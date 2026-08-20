import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostsService } from '../posts.service';

// Rescheduling a QUEUE post is not "the DRAFT pass with a different filter".
// A queued post has a live Temporal timer that captured its old publishDate and
// ABORTS on finding the date changed, so the contract here is:
//   - the DB write and a workflow RESTART always happen together;
//   - a post that is claimed, or about to publish, is skipped and reported —
//     never silently moved, and never allowed to fail the whole batch.

const WINDOW = { windowStart: '09:00', windowEnd: '18:00', timezone: 'UTC' };
// Out of the 09:00-18:00 window, and in the FUTURE relative to NOW — so the
// window it gets placed into (that same local day's) is still ahead of us.
const OUT_OF_WINDOW = '2026-08-20T22:00:00.000Z';
const NOW = new Date('2026-08-20T06:00:00.000Z');

const root = (
  id: string,
  overrides: Partial<{
    state: 'DRAFT' | 'QUEUE';
    publishDate: string;
    releaseId: string | null;
    providerIdentifier: string;
    group: string;
  }> = {}
) => ({
  id,
  group: overrides.group ?? `g-${id}`,
  providerIdentifier: overrides.providerIdentifier ?? 'x',
  publishDate: new Date(overrides.publishDate ?? OUT_OF_WINDOW),
  state: overrides.state ?? ('QUEUE' as const),
  releaseId: overrides.releaseId ?? null,
});

function makeService(roots: any[], publishing: Record<string, unknown> = {}) {
  const getPlanPostRootsForProject = vi.fn().mockResolvedValue(roots);
  const updateGroupPublishDate = vi.fn().mockResolvedValue({ count: 1 });
  const updateDraftGroupPublishDates = vi.fn().mockResolvedValue([]);
  const repo = {
    getPlanPostRootsForProject,
    updateGroupPublishDate,
    updateDraftGroupPublishDates,
  } as any;

  const extensionPublishConfigService = {
    getMinGapMinutes: vi.fn().mockResolvedValue({ x: 30, reddit: 30 }),
  } as any;

  const projectPublishingService = {
    resolve: vi.fn().mockResolvedValue({
      automationEnabled: true,
      publishingEnabled: true,
      publishingConfigured: true,
      enabledPlatforms: null,
      windows: { x: WINDOW },
      platformDecisions: {},
      ...publishing,
    }),
  } as any;

  const service = new PostsService(
    repo,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    extensionPublishConfigService,
    undefined,
    projectPublishingService
  );
  const startWorkflow = vi
    .spyOn(service as any, 'startWorkflow')
    .mockResolvedValue(undefined);

  return {
    service,
    getPlanPostRootsForProject,
    updateGroupPublishDate,
    startWorkflow,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

function freezeClock() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
}

describe('rescheduleQueuedPlanPosts', () => {
  it('writes the new date AND restarts the workflow for a moved post', async () => {
    freezeClock();
    const t = makeService([root('q1', { group: 'grp-1' })]);

    const result = await t.service.rescheduleQueuedPlanPosts('org', 'proj');

    expect(result.rescheduled).toBe(1);
    expect(result.skipped).toEqual([]);
    const [orgId, group, state, date] = t.updateGroupPublishDate.mock.calls[0];
    expect([orgId, group, state]).toEqual(['org', 'grp-1', 'QUEUE']);
    expect(date.getUTCHours()).toBeGreaterThanOrEqual(9);
    expect(date.getUTCHours()).toBeLessThan(18);
    // The restart is what makes the new date real — a bare UPDATE strands the
    // post, because the sleeping workflow aborts on seeing a changed date.
    expect(t.startWorkflow).toHaveBeenCalledTimes(1);
    expect(t.startWorkflow.mock.calls[0][1]).toBe('q1');
  });

  it('skips a CLAIMED post — terminating cannot cancel an in-flight send', async () => {
    freezeClock();
    const t = makeService([root('q1', { releaseId: 'claim_2026_abc' })]);

    const result = await t.service.rescheduleQueuedPlanPosts('org', 'proj');

    expect(result.rescheduled).toBe(0);
    expect(result.skipped).toEqual([{ id: 'q1', reason: 'claimed' }]);
    expect(t.updateGroupPublishDate).not.toHaveBeenCalled();
    expect(t.startWorkflow).not.toHaveBeenCalled();
  });

  it('skips a post inside the 30s lockout', async () => {
    freezeClock();
    const t = makeService([
      // 10s away: the workflow may no longer be sleeping, so terminate() races it.
      root('q1', { publishDate: new Date(NOW.getTime() + 10_000).toISOString() }),
    ]);

    const result = await t.service.rescheduleQueuedPlanPosts('org', 'proj');

    expect(result.skipped).toEqual([{ id: 'q1', reason: 'imminent' }]);
    expect(t.updateGroupPublishDate).not.toHaveBeenCalled();
  });

  it('skips a past-due post rather than yanking it back into the window', async () => {
    freezeClock();
    const t = makeService([
      root('q1', { publishDate: '2026-08-20T05:00:00.000Z' }), // an hour ago
    ]);

    const result = await t.service.rescheduleQueuedPlanPosts('org', 'proj');

    expect(result.skipped).toEqual([{ id: 'q1', reason: 'imminent' }]);
    expect(t.startWorkflow).not.toHaveBeenCalled();
  });

  it('refuses to move a post BACKWARDS into a window that has already passed', async () => {
    vi.useFakeTimers();
    // Half past the window: today's 09:00-18:00 is partly behind us...
    vi.setSystemTime(new Date('2026-08-20T19:00:00.000Z'));
    const t = makeService([
      // ...and this post is scheduled for tonight, outside it.
      root('q1', { publishDate: '2026-08-20T23:00:00.000Z' }),
    ]);

    const result = await t.service.rescheduleQueuedPlanPosts('org', 'proj');

    // Moving it into a window that closed an hour ago would publish it on the
    // spot — the exact opposite of what the window is for.
    expect(result.rescheduled).toBe(0);
    expect(result.skipped).toEqual([{ id: 'q1', reason: 'window-passed' }]);
    expect(t.updateGroupPublishDate).not.toHaveBeenCalled();
  });

  it('keeps going after one post fails, and reports it', async () => {
    freezeClock();
    const t = makeService([
      root('q1', { group: 'grp-1' }),
      root('q2', { group: 'grp-2' }),
    ]);
    t.startWorkflow.mockRejectedValueOnce(new Error('temporal down'));

    const result = await t.service.rescheduleQueuedPlanPosts('org', 'proj');

    // One batch member failing must not abandon the rest.
    expect(result.rescheduled).toBe(1);
    expect(result.skipped).toEqual([{ id: 'q1', reason: 'workflow-failed' }]);
    expect(t.updateGroupPublishDate).toHaveBeenCalledTimes(2);
  });

  it('leaves an in-window queued post alone', async () => {
    freezeClock();
    const t = makeService([root('q1', { publishDate: '2026-08-20T12:00:00.000Z' })]);

    const result = await t.service.rescheduleQueuedPlanPosts('org', 'proj');

    expect(result.rescheduled).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(t.updateGroupPublishDate).not.toHaveBeenCalled();
  });

  it('never moves a DRAFT — that is the other pass\'s post', async () => {
    freezeClock();
    const t = makeService([root('d1', { state: 'DRAFT' })]);

    const result = await t.service.rescheduleQueuedPlanPosts('org', 'proj');

    expect(result.rescheduled).toBe(0);
    expect(t.updateGroupPublishDate).not.toHaveBeenCalled();
  });

  it('spaces a placed post away from a DRAFT already holding that slot', async () => {
    freezeClock();
    const t = makeService([
      // A draft sitting mid-window. It is not this pass's to move, but it
      // occupies its slot — placing the queued post on top of it is the bug
      // reading both states exists to prevent.
      root('d1', { state: 'DRAFT', publishDate: '2026-08-20T12:00:00.000Z' }),
      root('q1'),
    ]);

    const result = await t.service.rescheduleQueuedPlanPosts('org', 'proj');

    expect(result.rescheduled).toBe(1);
    const placed = t.updateGroupPublishDate.mock.calls[0][3] as Date;
    const minutesApart =
      Math.abs(placed.getTime() - new Date('2026-08-20T12:00:00.000Z').getTime()) /
      60_000;
    expect(minutesApart).toBeGreaterThanOrEqual(30);
  });

  it('spaces a placed post away from a SKIPPED one that is not moving', async () => {
    freezeClock();
    const t = makeService([
      // Claimed: pinned where it is, mid-window, and going out at that time.
      root('claimed', {
        releaseId: 'claim_x',
        publishDate: '2026-08-20T12:00:00.000Z',
      }),
      root('q1'),
    ]);

    const result = await t.service.rescheduleQueuedPlanPosts('org', 'proj');

    expect(result.rescheduled).toBe(1);
    expect(result.skipped).toEqual([{ id: 'claimed', reason: 'claimed' }]);
    const placed = t.updateGroupPublishDate.mock.calls[0][3] as Date;
    expect(
      Math.abs(placed.getTime() - new Date('2026-08-20T12:00:00.000Z').getTime()) /
        60_000
    ).toBeGreaterThanOrEqual(30);
  });

  it('does nothing when publishing is switched off', async () => {
    freezeClock();
    const t = makeService([root('q1')], { automationEnabled: false });

    const result = await t.service.rescheduleQueuedPlanPosts('org', 'proj');

    expect(result).toEqual({ rescheduled: 0, skipped: [], inactive: 'inactive' });
    expect(t.getPlanPostRootsForProject).not.toHaveBeenCalled();
  });

  it('does nothing when no platform has a window', async () => {
    freezeClock();
    const t = makeService([root('q1')], { windows: {} });

    const result = await t.service.rescheduleQueuedPlanPosts('org', 'proj');

    expect(result).toEqual({ rescheduled: 0, skipped: [], inactive: 'no-windows' });
    expect(t.updateGroupPublishDate).not.toHaveBeenCalled();
  });
});

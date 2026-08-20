import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostsService } from '../posts.service';
import { DEFAULT_MIN_GAP_MINUTES } from '../extension-publish-config.service';

// alignPlanDraftPublishDates is the pass that makes a generated plan's calendar
// times the times the posts actually go out. The contract that matters:
//   - it runs only when publishing is actually switched on;
//   - it moves DRAFT plan posts and NOTHING else;
//   - it moves them by GROUP, so a thread's segments keep one publish time.

const WINDOW = { windowStart: '09:00', windowEnd: '18:00', timezone: 'UTC' };

function makeService(opts: {
  roots?: any[];
  publishing?: Partial<{
    automationEnabled: boolean;
    publishingEnabled: boolean;
    windows: Record<string, unknown>;
  }>;
  minGaps?: Record<string, number>;
}) {
  const getPlanPostRootsForProject = vi.fn().mockResolvedValue(opts.roots ?? []);
  const updateDraftGroupPublishDates = vi.fn().mockResolvedValue([]);
  const repo = { getPlanPostRootsForProject, updateDraftGroupPublishDates } as any;

  const getMinGapMinutes = vi
    .fn()
    .mockResolvedValue(opts.minGaps ?? { x: DEFAULT_MIN_GAP_MINUTES, reddit: DEFAULT_MIN_GAP_MINUTES });
  const extensionPublishConfigService = { getMinGapMinutes } as any;

  const resolve = vi.fn().mockResolvedValue({
    automationEnabled: true,
    publishingEnabled: true,
    publishingConfigured: true,
    enabledPlatforms: null,
    windows: { x: WINDOW },
    platformDecisions: {},
    ...opts.publishing,
  });
  const projectPublishingService = { resolve } as any;

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

  return {
    service,
    getPlanPostRootsForProject,
    updateDraftGroupPublishDates,
    getMinGapMinutes,
    resolve,
  };
}

const draft = (id: string, iso: string, platform = 'x', group = `g-${id}`) => ({
  id,
  group,
  providerIdentifier: platform,
  publishDate: new Date(iso),
  state: 'DRAFT' as const,
  releaseId: null,
});

describe('alignPlanDraftPublishDates', () => {
  // The fixtures are dated 2026-08-20 and the pass refuses to move a post
  // BACKWARDS across the clock, so "now" has to be frozen ahead of the window
  // they are placed into — otherwise a random pick inside 09:00-18:00 lands in
  // the past whenever the suite happens to run mid-window, and the test flakes.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('does nothing when the master switch is off', async () => {
    const t = makeService({
      roots: [draft('a', '2026-08-20T03:00:00.000Z')],
      publishing: { automationEnabled: false },
    });
    const result = await t.service.alignPlanDraftPublishDates('org', 'proj');
    expect(result).toEqual({ aligned: 0, skipped: 'inactive' });
    // Not even READ: a project that has not authorized publishing has not
    // authorized us to rewrite its schedule.
    expect(t.getPlanPostRootsForProject).not.toHaveBeenCalled();
    expect(t.updateDraftGroupPublishDates).not.toHaveBeenCalled();
  });

  it('does nothing when the publishing feature switch is off', async () => {
    const t = makeService({
      roots: [draft('a', '2026-08-20T03:00:00.000Z')],
      publishing: { publishingEnabled: false },
    });
    const result = await t.service.alignPlanDraftPublishDates('org', 'proj');
    expect(result).toEqual({ aligned: 0, skipped: 'inactive' });
    expect(t.updateDraftGroupPublishDates).not.toHaveBeenCalled();
  });

  it('does nothing when no platform has a window at any tier', async () => {
    const t = makeService({
      roots: [draft('a', '2026-08-20T03:00:00.000Z')],
      publishing: { windows: {} },
    });
    const result = await t.service.alignPlanDraftPublishDates('org', 'proj');
    // Unconstrained is the out-of-the-box state — configuring nothing must
    // change nothing.
    expect(result).toEqual({ aligned: 0, skipped: 'no-windows' });
    expect(t.updateDraftGroupPublishDates).not.toHaveBeenCalled();
  });

  it('moves an out-of-window draft into the window, keyed by its GROUP', async () => {
    const t = makeService({
      roots: [draft('anchor', '2026-08-20T03:00:00.000Z', 'x', 'thread-1')],
    });
    const result = await t.service.alignPlanDraftPublishDates('org', 'proj');

    expect(result).toEqual({ aligned: 1, skipped: null });
    const [orgId, updates] = t.updateDraftGroupPublishDates.mock.calls[0];
    expect(orgId).toBe('org');
    expect(updates).toHaveLength(1);
    // By group, not by id: the thread's segments must land on the same instant
    // as their anchor.
    expect(updates[0].group).toBe('thread-1');
    const hour = updates[0].publishDate.getUTCHours();
    expect(hour).toBeGreaterThanOrEqual(9);
    expect(hour).toBeLessThan(18);
  });

  it('leaves an in-window draft alone, so repeated saves do not shuffle times', async () => {
    const t = makeService({
      roots: [draft('a', '2026-08-20T10:00:00.000Z')],
    });
    const result = await t.service.alignPlanDraftPublishDates('org', 'proj');
    expect(result).toEqual({ aligned: 0, skipped: null });
    expect(t.updateDraftGroupPublishDates).toHaveBeenCalledWith('org', []);
  });

  it('ignores a platform with no window instead of moving its posts', async () => {
    const t = makeService({
      roots: [
        draft('x1', '2026-08-20T03:00:00.000Z', 'x'),
        // reddit has no window in the resolved map -> unconstrained.
        draft('r1', '2026-08-20T03:00:00.000Z', 'reddit'),
      ],
    });
    await t.service.alignPlanDraftPublishDates('org', 'proj');
    const [, updates] = t.updateDraftGroupPublishDates.mock.calls[0];
    expect(updates.map((u: any) => u.group)).toEqual(['g-x1']);
  });

  it('spaces the posts it places by the platform minimum gap', async () => {
    const t = makeService({
      roots: Array.from({ length: 5 }, (_, i) =>
        draft(`p${i}`, '2026-08-20T03:00:00.000Z')
      ),
      minGaps: { x: 60 },
    });
    await t.service.alignPlanDraftPublishDates('org', 'proj');
    const [, updates] = t.updateDraftGroupPublishDates.mock.calls[0];
    const times = updates
      .map((u: any) => u.publishDate.getTime())
      .sort((a: number, b: number) => a - b);
    for (let i = 1; i < times.length; i++) {
      expect((times[i] - times[i - 1]) / 60_000).toBeGreaterThanOrEqual(60);
    }
  });

  it('scopes the query to the plan when one is named', async () => {
    const t = makeService({ roots: [] });
    await t.service.alignPlanDraftPublishDates('org', 'proj', 'plan-1');
    expect(t.getPlanPostRootsForProject).toHaveBeenCalledWith(
      'org',
      'proj',
      ['DRAFT', 'QUEUE'],
      'plan-1'
    );
  });

  it('short-circuits before reading config when there are no drafts', async () => {
    const t = makeService({ roots: [] });
    const result = await t.service.alignPlanDraftPublishDates('org', 'proj');
    expect(result).toEqual({ aligned: 0, skipped: null });
    expect(t.getMinGapMinutes).not.toHaveBeenCalled();
    // The write is reached but carries nothing — the repository short-circuits
    // on an empty batch, so there is no query.
    expect(t.updateDraftGroupPublishDates).toHaveBeenCalledWith('org', []);
  });
});

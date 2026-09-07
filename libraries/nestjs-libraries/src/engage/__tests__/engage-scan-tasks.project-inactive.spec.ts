import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngageScanTasksService } from '../engage-scan-tasks.service';
import { DEFAULT_SCAN_PACING } from '../engage-scan-config.service';

/**
 * Deactivating a project in aisee-core (`Product.is_active = false`) must stop
 * the EXTENSION scan loop too — not just the Temporal path. The extension path
 * enumerated its units straight off `getEnabledConfigsForOrg`, whose only
 * predicate is `enabled + projectId != null`, so a deactivated project kept
 * handing its keywords to the extension and kept receiving the posts they
 * matched.
 */

// ProjectValidationService.getActivationVerdict is the tri-state contract this
// service depends on ('unknown' = aisee-core did not answer). The map keys
// projects by id so one test can mix active/inactive within an org.
function validation(verdicts: Record<string, 'active' | 'inactive' | 'unknown'>) {
  return {
    getActivationVerdict: vi.fn(
      async (_org: string, projectId: string) => verdicts[projectId] ?? 'active'
    ),
  };
}

function build(opts: {
  orgContexts?: any[];
  subscribers?: any[];
  unitByToken?: any;
  claimResults?: any[];
  verdicts?: Record<string, 'active' | 'inactive' | 'unknown'>;
}) {
  let claimCall = 0;
  const contexts = opts.orgContexts ?? [];
  const engageRepo = {
    getEnabledOrgContext: vi.fn(async () => contexts[0] ?? null),
    getEnabledConfigsForOrg: vi.fn(async () => contexts),
    findScanCursorByToken: vi.fn(async () => opts.unitByToken ?? null),
    getOrgContextsForUnit: vi.fn(async () => opts.subscribers ?? []),
  };
  const lease = {
    claim: vi.fn(async () => (opts.claimResults ?? [])[claimCall++] ?? null),
    completeByToken: vi.fn(async () => true),
    releaseByToken: vi.fn(async () => true),
  };
  const ingest = {
    ingestForOrg: vi.fn(async () => 3),
    filterExpiredByPublishTime: vi.fn(async (posts: any[]) => ({
      kept: posts,
      dropped: 0,
    })),
    scoreAllForOrg: vi.fn((posts: any[]) =>
      posts.map((p) => ({ ...p, score: p.score ?? 100 }))
    ),
  };
  const config = {
    getPacing: vi.fn(async () => DEFAULT_SCAN_PACING),
    getFreshnessWindowMs: vi.fn(async () => 24 * 3_600_000),
    getSupportedScanPlatforms: vi.fn(async () => ['reddit']),
  };
  const entitlement = { getScanIntervalHours: vi.fn(async () => 6) };
  const projectValidation = validation(opts.verdicts ?? {});

  const svc = new EngageScanTasksService(
    engageRepo as any,
    lease as any,
    ingest as any,
    config as any,
    entitlement as any,
    projectValidation as any
  );
  return { svc, engageRepo, lease, ingest, projectValidation };
}

function ctx(projectId: string, keyword: string) {
  return {
    organizationId: 'org1',
    projectId,
    keywords: [{ keyword, enabled: true }],
    monitoredChannels: [],
    trackedAccounts: [],
  };
}

function snap(over: any = {}) {
  return {
    id: 'cur1',
    platform: 'reddit',
    scanType: 'keyword',
    scanKey: 'alpha',
    lastSeenExternalId: null,
    lastSeenAt: null,
    leaseToken: 'tok_abc',
    ...over,
  };
}

describe('scan claim — deactivated projects', () => {
  beforeEach(() => vi.clearAllMocks());

  it('never enumerates units for a deactivated project', async () => {
    const { svc, lease } = build({
      orgContexts: [ctx('p-off', 'alpha')],
      verdicts: { 'p-off': 'inactive' },
      claimResults: [snap()],
    });

    const res = await svc.sync('org1', { want: 5 });

    expect(res.nextTasks).toEqual([]);
    // The gate runs BEFORE enumeration — no cursor is even considered, so the
    // project consumes no scan budget and holds no lease.
    expect(lease.claim).not.toHaveBeenCalled();
  });

  it('still scans the org\'s OTHER, active projects', async () => {
    const { svc, lease } = build({
      orgContexts: [ctx('p-off', 'alpha'), ctx('p-on', 'beta')],
      verdicts: { 'p-off': 'inactive', 'p-on': 'active' },
      claimResults: [snap({ scanKey: 'beta' })],
    });

    const res = await svc.sync('org1', { want: 5 });

    expect(res.nextTasks).toHaveLength(1);
    const claimedKeys = lease.claim.mock.calls.map((c: any[]) => c[0].scanKey);
    expect(claimedKeys).toEqual(['beta']);
    expect(claimedKeys).not.toContain('alpha');
  });

  it('fails CLOSED when aisee-core cannot be reached: no work is lost, the next tick retries', async () => {
    const { svc, lease } = build({
      orgContexts: [ctx('p1', 'alpha')],
      verdicts: { p1: 'unknown' },
      claimResults: [snap()],
    });

    expect(await svc.sync('org1', { want: 5 })).toEqual({
      accepted: 0,
      nextTasks: [],
    });
    expect(lease.claim).not.toHaveBeenCalled();
  });
});

describe('scan ingest — deactivated projects', () => {
  beforeEach(() => vi.clearAllMocks());

  it('drops a deactivated subscriber from the fan-out but still completes the shared lease', async () => {
    const { svc, ingest, lease } = build({
      unitByToken: {
        id: 'cur1',
        platform: 'reddit',
        scanType: 'keyword',
        scanKey: 'alpha',
      },
      subscribers: [
        { organizationId: 'o1', projectId: 'p-off' },
        { organizationId: 'o2', projectId: 'p-on' },
      ],
      verdicts: { 'p-off': 'inactive', 'p-on': 'active' },
    });

    const res = await svc.sync('org1', {
      completed: {
        taskId: 'tok_abc',
        posts: [
          {
            externalPostId: 't3_a',
            postPublishedAt: new Date('2020-01-01T10:00:00.000Z'),
          },
        ],
      } as any,
    });

    expect(ingest.ingestForOrg).toHaveBeenCalledTimes(1);
    expect(ingest.ingestForOrg.mock.calls[0][0]).toMatchObject({
      organizationId: 'o2',
    });
    expect(res.accepted).toBe(3);
    // The unit is GLOBAL: one deactivated subscriber must not strand the lease
    // or replay the same page for every other org sharing it.
    expect(lease.completeByToken).toHaveBeenCalled();
  });

  it('fails OPEN when aisee-core cannot be reached: the posts are already fetched and the cursor advances', async () => {
    const { svc, ingest, lease } = build({
      unitByToken: {
        id: 'cur1',
        platform: 'reddit',
        scanType: 'keyword',
        scanKey: 'alpha',
      },
      subscribers: [{ organizationId: 'o1', projectId: 'p1' }],
      verdicts: { p1: 'unknown' },
    });

    const res = await svc.sync('org1', {
      completed: {
        taskId: 'tok_abc',
        posts: [
          {
            externalPostId: 't3_a',
            postPublishedAt: new Date('2020-01-01T10:00:00.000Z'),
          },
        ],
      } as any,
    });

    // Dropping here would lose the page for good — completeByToken advances the
    // cursor right after, so it is never re-fetched.
    expect(ingest.ingestForOrg).toHaveBeenCalledTimes(1);
    expect(res.accepted).toBe(3);
    expect(lease.completeByToken).toHaveBeenCalled();
  });
});

describe('collected-post ingest — deactivated projects', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scores collected posts only against active projects', async () => {
    const { svc, ingest } = build({
      orgContexts: [ctx('p-off', 'alpha'), ctx('p-on', 'beta')],
      verdicts: { 'p-off': 'inactive', 'p-on': 'active' },
    });

    const res = await svc.ingestCollectedPosts('org1', [
      { id: 'x', postPublishedAt: new Date() },
    ] as any);

    expect(ingest.ingestForOrg).toHaveBeenCalledTimes(1);
    expect(res.accepted).toBe(3);
  });

  it('names deactivation as the reason when EVERY config belongs to a deactivated project', async () => {
    const { svc, ingest } = build({
      orgContexts: [ctx('p-off', 'alpha')],
      verdicts: { 'p-off': 'inactive' },
    });

    const res = await svc.ingestCollectedPosts('org1', [
      { id: 'x', postPublishedAt: new Date() },
    ] as any);

    expect(ingest.ingestForOrg).not.toHaveBeenCalled();
    // Distinct from 'no engage config found for org': the org HAS configs, they
    // are just all switched off upstream — a different fix for the operator.
    expect(res.reason).toBe(
      'every enabled engage config belongs to a deactivated project'
    );
  });
});

describe('backfill — deactivated projects', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not back-attribute existing opportunities to a deactivated project', async () => {
    const { svc, engageRepo } = build({
      orgContexts: [ctx('p-off', 'alpha')],
      verdicts: { 'p-off': 'inactive' },
    });

    expect(
      await svc.backfillFromExisting('org1', { projectId: 'p-off' })
    ).toBe(0);
    // Short-circuits before the (expensive) global opportunity read.
    expect(engageRepo.getEnabledConfigsForOrg).not.toHaveBeenCalled();
  });
});

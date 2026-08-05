import { describe, it, expect, vi } from 'vitest';
import { EngageService } from '@gitroom/nestjs-libraries/engage/engage.service';

/**
 * Keywords / tracked accounts / subreddits are capped TWICE: an org-wide budget
 * and a per-project one. GET /engage/config has to report both, or a frontend
 * cannot tell which cap is about to block an "+ Add".
 *
 * `entitlement.counts.<type>` stays org-scoped (unchanged contract) and gains a
 * `project` block of the same shape. The project block is null when the request
 * carried no projectId — the browser extension's org-wide aggregate view has no
 * single project to report on.
 */
describe('EngageService.getConfig — entitlement.counts project block', () => {
  const org = { id: 'org-1' } as any;

  // trackedAccounts + subreddits share the priorityAccounts caps (one pool).
  const LIMITS = {
    scanIntervalHours: 6,
    keywordsMax: 30,
    priorityAccountsMax: 20,
    keywordsPerProjectMax: 5,
    priorityAccountsPerProjectMax: 3,
  };

  // Two enabled + one disabled keyword, one enabled tracked account, one
  // disabled channel — so `added` and `active` are provably different numbers.
  const projectConfig = {
    id: 'cfg-1',
    keywords: [
      { id: 'k1', keyword: 'alpha', enabled: true },
      { id: 'k2', keyword: 'beta', enabled: true },
      { id: 'k3', keyword: 'gamma', enabled: false },
    ],
    trackedAccounts: [{ id: 't1', platform: 'x', username: 'someone', enabled: true }],
    monitoredChannels: [
      { id: 'c1', platform: 'reddit', channelId: 'r1', enabled: false },
    ],
    xReplyAccounts: [],
  };

  function buildService() {
    const engageRepository = {
      getOrCreateConfig: vi.fn(async () => projectConfig),
      getOrgAggregateConfig: vi.fn(async () => projectConfig),
      getOrgScanStatus: vi.fn(async () => ({})),
      getKeywordCursors: vi.fn(async () => ({})),
      getChannelCursors: vi.fn(async () => ({})),
      getTrackedCursors: vi.fn(async () => ({})),
    } as any;
    const entitlementService = {
      getEntitlementSummary: vi.fn(async () => ({
        limits: LIMITS,
        // Org-wide usage is deliberately HIGHER than the project's, so a project
        // block that accidentally reused the org numbers would fail here.
        usage: { keywords: 9, trackedAccounts: 7, subreddits: 4 },
      })),
      // Org-wide enabled tracked+channels per platform (x: 5 tracked+list,
      // reddit: 6 channels) — again higher than this project's rows.
      getPriorityAccountsUsageByPlatform: vi.fn(async () => ({
        x: 5,
        reddit: 6,
      })),
    } as any;

    return new EngageService(
      engageRepository,
      { client: undefined } as any,
      {} as any,
      {} as any,
      entitlementService,
      undefined,
      undefined,
      undefined
    );
  }

  it('reports org and project scope side by side for a project-scoped request', async () => {
    const res: any = await buildService().getConfig(org, 'proj-1');

    expect(res.entitlement.counts.keywords).toEqual({
      added: 3,
      active: 9, // org-wide enabled count
      max: 30,
      project: { added: 3, active: 2, max: 5 }, // gamma is disabled
    });
    expect(res.entitlement.counts.trackedAccounts).toEqual({
      added: 1,
      active: 7,
      max: 20,
      project: { added: 1, active: 1, max: 3 },
    });
    // subreddits report the SAME shared cap as trackedAccounts.
    expect(res.entitlement.counts.subreddits).toEqual({
      added: 1,
      active: 4,
      max: 20,
      project: { added: 1, active: 0, max: 3 }, // the only channel is disabled
    });
  });

  it('surfaces the per-project caps in entitlement.limits', async () => {
    const res: any = await buildService().getConfig(org, 'proj-1');

    expect(res.entitlement.limits).toMatchObject({
      keywordsPerProjectMax: 5,
      priorityAccountsPerProjectMax: 3,
    });
  });

  it('nulls the project block when no projectId is given (org-wide aggregate)', async () => {
    const res: any = await buildService().getConfig(org);

    expect(res.entitlement.counts.keywords.project).toBeNull();
    expect(res.entitlement.counts.trackedAccounts.project).toBeNull();
    expect(res.entitlement.counts.subreddits.project).toBeNull();
    // Org-scope numbers are unaffected by the addition.
    expect(res.entitlement.counts.keywords).toMatchObject({ added: 3, active: 9, max: 30 });
  });

  it('reports the per-platform priority-accounts rollup with project scope', async () => {
    const res: any = await buildService().getConfig(org, 'proj-1');

    expect(res.entitlement.counts.priorityAccounts).toEqual({
      max: 20, // per-platform org cap
      projectMax: 3, // per-platform project cap
      byPlatform: {
        // org-wide active from the entitlement service; project added/active
        // from this project's config rows (1 enabled x tracked account, 1
        // disabled reddit channel).
        x: { active: 5, project: { added: 1, active: 1 } },
        reddit: { active: 6, project: { added: 1, active: 0 } },
      },
    });
  });

  it('nulls the per-platform project blocks without a projectId', async () => {
    const res: any = await buildService().getConfig(org);

    expect(res.entitlement.counts.priorityAccounts.byPlatform).toEqual({
      x: { active: 5, project: null },
      reddit: { active: 6, project: null },
    });
  });
});

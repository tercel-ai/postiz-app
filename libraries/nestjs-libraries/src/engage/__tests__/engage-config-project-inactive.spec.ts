import { describe, it, expect, vi } from 'vitest';
import { EngageService } from '@gitroom/nestjs-libraries/engage/engage.service';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';

/**
 * `GET /engage/config` answers two different questions, and aisee-core's
 * `Product.is_active` switch means something different in each — so the two
 * branches must NOT be given the same treatment:
 *
 *   ?projectId=…  — aisee-app's per-project Engage settings page. Reads stay
 *     open on a deactivated project by design (ProjectAuthGuard only asserts
 *     ACCESS on GET) so it can be inspected and switched back on. Filtering
 *     its keywords away would read as data loss; the verdict is REPORTED as
 *     `projectActive` instead.
 *
 *   no projectId — the browser extension's org-wide scan panel, whose contract
 *     is to list exactly the units claimNext will claim. It has no project
 *     dimension (keywords are deduped across projects into one flat list), so
 *     a per-row status flag has nothing to attach to: FILTERING is the only
 *     coherent answer, and it restores the parity claimNext's own gate broke.
 */
describe('EngageService.getConfig — deactivated projects', () => {
  const org = { id: 'org-1' } as any;

  const projectConfig = {
    id: 'cfg-1',
    keywords: [{ id: 'k1', keyword: 'alpha', enabled: true }],
    trackedAccounts: [],
    monitoredChannels: [],
    replyAccounts: [],
  };

  function buildService(verdict: 'active' | 'inactive' | 'unknown') {
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
        limits: { scanIntervalHours: 6 },
        usage: { keywords: 1, trackedAccounts: 0, subreddits: 0 },
      })),
      getPriorityAccountsUsageByPlatform: vi.fn(async () => ({})),
    } as any;
    const projectValidation = {
      getActivationVerdict: vi.fn(async () => verdict),
    } as any;

    const svc = new EngageService(
      engageRepository,
      { client: undefined } as any,
      {} as any,
      {} as any,
      entitlementService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      projectValidation
    );
    return { svc, engageRepository, projectValidation };
  }

  it('keeps a deactivated project fully readable and reports projectActive: false', async () => {
    const { svc } = buildService('inactive');

    const res: any = await svc.getConfig(org, 'proj-1');

    // The settings page must still render everything the user configured —
    // hiding it would look like the keywords were deleted, not paused.
    expect(res.keywords).toHaveLength(1);
    expect(res.keywords[0].keyword).toBe('alpha');
    expect(res.projectActive).toBe(false);
  });

  it('reports projectActive: true for a live project', async () => {
    const { svc } = buildService('active');
    expect((await svc.getConfig(org, 'proj-1')).projectActive).toBe(true);
  });

  it('reports projectActive: null when aisee-core did not answer', async () => {
    const { svc } = buildService('unknown');
    // A client must not render "deactivated" on the strength of an outage.
    expect((await svc.getConfig(org, 'proj-1')).projectActive).toBeNull();
  });

  it('passes an activation gate into the org-wide aggregate, and reports no projectActive there', async () => {
    const { svc, engageRepository } = buildService('inactive');

    const res: any = await svc.getConfig(org);

    // The aggregate branch filters rather than flags — it receives a predicate.
    const [orgId, gate] = engageRepository.getOrgAggregateConfig.mock.calls[0];
    expect(orgId).toBe('org-1');
    expect(await gate('proj-1')).toBe(false);
    // No single project to report on.
    expect(res.projectActive).toBeNull();
  });

  it('lets the aggregate gate pass on an inconclusive verdict', async () => {
    const { svc, engageRepository } = buildService('unknown');

    await svc.getConfig(org);

    // Fails OPEN: wrongly showing a keyword costs one empty claim, while
    // wrongly emptying the panel during a blip reads as data loss.
    const [, gate] = engageRepository.getOrgAggregateConfig.mock.calls[0];
    expect(await gate('proj-1')).toBe(true);
  });
});

/**
 * The repository half of the aggregate gate: `getOrgAggregateConfig` unions the
 * scan units of every enabled project-scoped config, and must drop the ones
 * whose project is switched off — the same set claimNext refuses to claim.
 */
describe('EngageRepository.getOrgAggregateConfig — activation gate', () => {
  function buildRepo(rows: any[]) {
    const base = {
      id: 'cfg-null',
      projectId: null,
      keywords: [],
      trackedAccounts: [],
      replyAccounts: [],
    };
    const findMany = vi.fn(async ({ select }: any) =>
      select
        ? rows.map((r) => ({ projectId: r.projectId, metadata: r.metadata }))
        : rows
    );
    const config = {
      model: {
        engageConfig: {
          findFirst: vi.fn(async () => base),
          findMany,
        },
      },
    } as any;
    const repo = new EngageRepository(
      config,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    return repo;
  }

  const row = (projectId: string, keyword: string, automation = false) => ({
    id: `cfg-${projectId}`,
    projectId,
    keywords: [{ id: `k-${keyword}`, keyword, enabled: true, initialScans: [] }],
    trackedAccounts: [],
    metadata: { automationEnabled: automation },
  });

  it('drops a deactivated project\'s keywords from the union', async () => {
    const repo = buildRepo([row('p-off', 'alpha'), row('p-on', 'beta')]);

    const res: any = await repo.getOrgAggregateConfig(
      'org-1',
      async (pid) => pid !== 'p-off'
    );

    expect(res.keywords.map((k: any) => k.keyword)).toEqual(['beta']);
  });

  it('does not let a deactivated project keep automationEnabled true', async () => {
    const repo = buildRepo([row('p-off', 'alpha', true)]);

    const res: any = await repo.getOrgAggregateConfig(
      'org-1',
      async () => false
    );

    // A project that can no longer publish or reply must not be what makes the
    // extension's org-wide "automation is running" badge light up.
    expect(res.automationEnabled).toBe(false);
  });

  it('is a no-op without a validator (every existing caller keeps its behaviour)', async () => {
    const repo = buildRepo([row('p-off', 'alpha'), row('p-on', 'beta')]);

    const res: any = await repo.getOrgAggregateConfig('org-1');

    expect(res.keywords.map((k: any) => k.keyword).sort()).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('keeps a row whose verdict threw — the panel is read-only, so it fails open', async () => {
    const repo = buildRepo([row('p1', 'alpha')]);

    const res: any = await repo.getOrgAggregateConfig('org-1', async () => {
      throw new Error('aisee-core unreachable');
    });

    expect(res.keywords.map((k: any) => k.keyword)).toEqual(['alpha']);
  });
});

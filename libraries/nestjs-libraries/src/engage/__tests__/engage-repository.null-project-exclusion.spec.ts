import { describe, it, expect, vi } from 'vitest';
import { EngageRepository } from '../engage.repository';

// The legacy null-project EngageConfig row holds pre-project data that must no
// longer be scanned or fanned out to. Every enumeration path the browser
// extension drives (scan panel display, scan claim, collected ingest) and the
// server-side scan activity must therefore query only project-scoped configs,
// i.e. `projectId: { not: null }`. These tests lock that predicate onto each
// findMany so a future refactor can't silently re-admit the legacy row.
function buildRepo(configFindMany: any) {
  const _config = { model: { engageConfig: { findMany: configFindMany } } } as any;
  return new EngageRepository(
    _config,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any
  );
}

describe('EngageRepository — null-project config exclusion', () => {
  it('getEnabledConfigsForOrg filters out the legacy null-project row', async () => {
    const findMany = vi.fn(async () => []);
    const repo = buildRepo(findMany);
    await repo.getEnabledConfigsForOrg('org1');
    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      organizationId: 'org1',
      enabled: true,
      projectId: { not: null },
    });
  });

  it('getAllEnabledOrgContexts filters out null-project rows', async () => {
    const findMany = vi.fn(async () => []);
    const repo = buildRepo(findMany);
    await repo.getAllEnabledOrgContexts();
    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ enabled: true, projectId: { not: null } });
  });

  it('getOrgContextsForUnit excludes null-project subscribers in every scanType branch', async () => {
    const findMany = vi.fn(async () => []);
    const repo = buildRepo(findMany);

    await repo.getOrgContextsForUnit('reddit', 'channel', 'webdev');
    await repo.getOrgContextsForUnit('x', 'tracked', 'alice');
    await repo.getOrgContextsForUnit('reddit', 'keyword', 'ai');

    for (const call of findMany.mock.calls) {
      expect(call[0].where.projectId).toEqual({ not: null });
    }
  });

  it('getOrgAggregateConfig unions only project-scoped configs (legacy row reused for scalars only)', async () => {
    const findMany = vi.fn(async () => []);
    const repo = buildRepo(findMany);
    // The legacy null-project row still supplies the scalar/entitlement shape as
    // the response base — stub it so we can assert the union query in isolation.
    vi.spyOn(repo, 'getOrCreateConfig').mockResolvedValue({
      keywords: [],
      monitoredChannels: [],
      trackedAccounts: [],
    } as any);

    await repo.getOrgAggregateConfig('org1');

    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      organizationId: 'org1',
      enabled: true,
      projectId: { not: null },
    });
  });
});

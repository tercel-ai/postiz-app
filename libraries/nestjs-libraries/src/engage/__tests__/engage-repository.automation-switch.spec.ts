import { describe, it, expect, vi } from 'vitest';
import { EngageRepository } from '../engage.repository';

// The managed-replies half of the Automation switch chain.
//
// The chain is applied in CODE, not in the WHERE clause, so that the driver's
// gate and every other read share one implementation of the defaults. These
// tests therefore assert on which configs come BACK — the behaviour the driver
// depends on — rather than on the shape of the query.
function buildRepo(rows: any[]) {
  const findMany = vi.fn(async () => rows);
  const _config = { model: { engageConfig: { findMany } } } as any;
  const repo = new EngageRepository(
    _config,
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any
  );
  return { repo, findMany };
}

const row = (id: string, metadata: unknown) => ({
  id,
  projectId: `proj-${id}`,
  metadata,
});

describe('EngageRepository.getAutoReplyConfigs — switch chain', () => {
  it('filters only the real columns in SQL', async () => {
    const { repo, findMany } = buildRepo([]);

    await repo.getAutoReplyConfigs('org-1');

    expect(findMany.mock.calls[0][0].where).toEqual({
      organizationId: 'org-1',
      enabled: true,
      projectId: { not: null },
    });
    expect(findMany.mock.calls[0][0].select).toMatchObject({ metadata: true });
  });

  it('drops a project whose MASTER switch is off', async () => {
    const { repo } = buildRepo([
      row('a', { automationEnabled: false, autoReplyEnabled: true }),
      row('b', { automationEnabled: true, autoReplyEnabled: true }),
    ]);

    expect((await repo.getAutoReplyConfigs('org-1')).map((c) => c.id)).toEqual(['b']);
  });

  it('drops a project that never set the master switch — absence is not consent', async () => {
    // Automation replies with the user's real account. A project that has never
    // been switched on must not be driven just because the field is missing.
    const { repo } = buildRepo([row('a', { autoReplyEnabled: true })]);

    expect(await repo.getAutoReplyConfigs('org-1')).toEqual([]);
  });

  it('drops a project whose reply switch is off or unset', async () => {
    const { repo } = buildRepo([
      row('a', { automationEnabled: true, autoReplyEnabled: false }),
      row('b', { automationEnabled: true }),
      row('c', null),
      row('d', { automationEnabled: true, autoReplyEnabled: true }),
    ]);

    expect((await repo.getAutoReplyConfigs('org-1')).map((c) => c.id)).toEqual(['d']);
  });

  it('carries the per-platform policies through for the caller to gate on', async () => {
    const { repo } = buildRepo([
      row('a', {
        automationEnabled: true,
        autoReplyEnabled: true,
        replyPolicies: { x: { autoReplyEnabled: true }, reddit: { autoReplyEnabled: false } },
      }),
    ]);

    // The third level of the chain is applied by the caller, so both platforms
    // must survive the query — including the one that is switched off.
    const [config] = await repo.getAutoReplyConfigs('org-1');
    expect(config.replyPolicies).toEqual({
      x: { autoReplyEnabled: true },
      reddit: { autoReplyEnabled: false },
    });
  });

  it('returns the resolved settings, not the raw row', async () => {
    const { repo } = buildRepo([
      row('a', {
        automationEnabled: true,
        autoReplyEnabled: true,
        replyPolicies: { X: { autoReplyEnabled: true } },
      }),
    ]);

    const [config] = await repo.getAutoReplyConfigs('org-1');
    expect(config).toEqual({
      id: 'a',
      projectId: 'proj-a',
      // The reply switch itself is NOT carried: `isRepliesActive` already
      // filtered on it, so every row that survives has it on. Returning it would
      // invite the driver to re-check what the query already decided.
      // Platform keys are normalized to lowercase on the way out, so the driver
      // does not have to guess how the caller wrote them.
      replyPolicies: { x: { autoReplyEnabled: true } },
    });
  });
});

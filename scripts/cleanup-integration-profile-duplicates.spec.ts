import { describe, expect, it, vi } from 'vitest';
import { cleanupDuplicate, parseCleanupOptions } from './cleanup-integration-profile-duplicates';

const row = (id: string, extra = {}) => ({ id, organizationId: 'org',
  providerIdentifier: 'linkedin', type: 'social', profile: '@Alice', name: id,
  internalId: id, identityNamespace: 'legacy', disabled: false, deletedAt: null,
  updatedAt: null, ...extra });
function fixture() {
  const rows = [row('keep'), row('remove', { profile: 'alice' })];
  const db: any = { integration: { findMany: vi.fn(async () => rows),
    updateMany: vi.fn(async () => ({ count: 1 })) } };
  for (const model of ['organizationSendBinding', 'projectSendBinding', 'post',
    'sendIntent', 'sendExecution', 'accountWriteState', 'sendQuotaReservation',
    'integrationProject', 'extensionNodeSession', 'dataTicks', 'postRelease']) {
    db[model] = { count: vi.fn(async () => 0) };
  }
  db.sendMutationReceipt = { findMany: vi.fn(async () => []) };
  db.post.findMany = vi.fn(async () => []);
  db.$transaction = vi.fn(async (fn: any) => fn(db));
  return { db, rows };
}

describe('explicit duplicate profile cleanup', () => {
  it('requires an explicit distinct keep/remove pair and defaults to preview', () => {
    expect(parseCleanupOptions(['--keep', 'keep', '--remove', 'remove']))
      .toEqual({ keep: 'keep', remove: 'remove', apply: false, json: false, help: false });
    for (const args of [[], ['--apply'], ['--keep', 'same', '--remove', 'same'],
      ['--keep', 'keep'], ['--keep', 'k', '--remove', 'r', '--force'],
      ['--keep', 'k', '--remove', 'r', '--apply', '--apply']]) {
      expect(() => parseCleanupOptions(args)).toThrow();
    }
    expect(parseCleanupOptions(['--help']).help).toBe(true);
  });

  it('previews safe soft deletion without touching any references', async () => {
    const { db } = fixture();
    const result = await cleanupDuplicate(db, { keep: 'keep', remove: 'remove', apply: false });
    expect(result).toMatchObject({ applied: false, preview: { canApply: true,
      actions: [{ integrationId: 'remove', disabled: true, deletedAt: 'application time' }] } });
    expect(db.integration.updateMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.integration.findMany.mock.calls[0][0].select).not.toHaveProperty('token');
  });

  it.each([
    { organizationId: 'other' }, { providerIdentifier: 'quora' }, { type: 'article' },
    { profile: '' }, { profile: 'other' },
  ])('rejects a mismatched duplicate pair: %j', async extra => {
    const { db, rows } = fixture();
    Object.assign(rows[1], extra);
    await expect(cleanupDuplicate(db, { keep: 'keep', remove: 'remove', apply: true }))
      .rejects.toThrow();
    expect(db.integration.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a missing row and a deleted retained row', async () => {
    const { db, rows } = fixture();
    rows.pop();
    await expect(cleanupDuplicate(db, { keep: 'keep', remove: 'remove', apply: false }))
      .rejects.toThrow();
    rows.push(row('remove'));
    Object.assign(rows[0], { deletedAt: new Date() });
    await expect(cleanupDuplicate(db, { keep: 'keep', remove: 'remove', apply: false }))
      .rejects.toThrow();
  });

  it.each(['organizationSendBinding', 'projectSendBinding', 'post', 'sendIntent',
    'sendExecution', 'accountWriteState', 'sendQuotaReservation'])
  ('blocks active/default references in %s', async model => {
    const { db } = fixture();
    db[model].count.mockResolvedValue(1);
    const result = await cleanupDuplicate(db, { keep: 'keep', remove: 'remove', apply: true });
    expect(result.preview.canApply).toBe(false);
    expect(result.applied).toBe(false);
    expect(db.integration.updateMany).not.toHaveBeenCalled();
  });

  it('preserves project assignments, sessions and historical data', async () => {
    const { db } = fixture();
    db.integrationProject.count.mockResolvedValue(3);
    db.extensionNodeSession.count.mockResolvedValue(2);
    db.dataTicks.count.mockResolvedValue(8);
    const result = await cleanupDuplicate(db, { keep: 'keep', remove: 'remove', apply: true });
    expect(result.applied).toBe(true);
    expect(result.preview.preservedReferences).toMatchObject({ projectAssignments: 3,
      terminalSessions: 2, metrics: 8 });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    expect(db.integration.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'remove', deletedAt: null }),
      data: { deletedAt: expect.any(Date), disabled: true },
    }));
    expect(db.accountWriteState.count.mock.calls[0][0].where).toMatchObject({
      OR: [{ integrationId: 'remove' }, { identityIntegrationIds: { has: 'remove' } }],
    });
  });

  it('identifies blocking posts without modifying them or exposing content and lease tokens', async () => {
    const { db } = fixture();
    db.post.count.mockResolvedValueOnce(1);
    const post = { id: 'queued-post', state: 'QUEUE', projectId: 'project',
      publishDate: new Date('2026-10-28T01:00:00Z'), title: 'Queued post', sendIntentId: null };
    db.post.findMany.mockResolvedValue([post]);
    const result = await cleanupDuplicate(db, { keep: 'keep', remove: 'remove', apply: false });
    expect(result.preview).toMatchObject({
      canApply: false, blockingPosts: [post], blockingPostsTruncated: false,
    });
    const query = db.post.findMany.mock.calls[0][0];
    expect(query.where).toMatchObject({ organizationId: 'org', integrationId: 'remove',
      deletedAt: null, state: { not: 'PUBLISHED' } });
    expect(query.select).not.toHaveProperty('content');
    expect(query.select).not.toHaveProperty('releaseId');
    expect(db.integration.updateMany).not.toHaveBeenCalled();
  });

  it('marks truncated blocking-post diagnostics while preserving the full blocker count', async () => {
    const { db } = fixture();
    db.post.count.mockResolvedValueOnce(21);
    db.post.findMany.mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ id: `post-${i}` })));
    const result = await cleanupDuplicate(db, { keep: 'keep', remove: 'remove', apply: false });
    expect(result.preview.blockers.livePosts).toBe(21);
    expect(result.preview.blockingPostsTruncated).toBe(true);
    expect(db.post.findMany.mock.calls[0][0].take).toBe(20);
  });

  it.each(['AUTHORIZED', 'UNKNOWN', 'FUTURE_STATE', undefined])(
    'blocks unresolved autonomous effects in status %s even without a queued post', async status => {
      const { db } = fixture();
      db.sendMutationReceipt.findMany.mockResolvedValue([
        { id: 'effect', result: { integrationId: 'remove', status } },
      ]);
      const result = await cleanupDuplicate(db, { keep: 'keep', remove: 'remove', apply: true });
      expect(result.preview).toMatchObject({ canApply: false,
        blockers: { unsettledAutonomousEffects: 1 }, unsettledAutonomousEffectIds: ['effect'] });
      expect(db.integration.updateMany).not.toHaveBeenCalled();
    }
  );

  it.each(['CONFIRMED', 'NOT_SUBMITTED'])(
    'preserves terminal autonomous effects without blocking cleanup: %s', async status => {
      const { db } = fixture();
      db.sendMutationReceipt.findMany.mockResolvedValue([
        { id: 'effect', result: { integrationId: 'remove', status } },
      ]);
      expect((await cleanupDuplicate(db, { keep: 'keep', remove: 'remove', apply: true })).applied)
        .toBe(true);
    }
  );

  it('blocks browser effects linked through historical posts even if those posts were deleted', async () => {
    const { db } = fixture();
    db.sendMutationReceipt.findMany.mockResolvedValue([
      { id: 'browser-effect', result: {
        integrationId: 'browser:user:linkedin', status: 'UNKNOWN', postIds: ['historical-post'],
      } },
    ]);
    db.post.count.mockImplementation(async (args: any) =>
      args.where.id?.in?.includes('historical-post') ? 1 : 0);
    const result = await cleanupDuplicate(db, { keep: 'keep', remove: 'remove', apply: true });
    expect(result.preview.canApply).toBe(false);
    expect(result.preview.unsettledAutonomousEffectIds).toEqual(['browser-effect']);
    expect(db.post.count).toHaveBeenCalledWith({ where: {
      organizationId: 'org', integrationId: 'remove', id: { in: ['historical-post'] },
    } });
    expect(db.integration.updateMany).not.toHaveBeenCalled();
  });

  it('ignores unresolved effects of another account and checks receipts again before applying', async () => {
    const { db } = fixture();
    db.sendMutationReceipt.findMany.mockResolvedValueOnce([
      { id: 'unrelated', result: { integrationId: 'other', status: 'UNKNOWN' } },
    ]).mockResolvedValueOnce([
      { id: 'appeared', result: { integrationId: 'remove', status: 'AUTHORIZED' } },
    ]);
    await expect(cleanupDuplicate(db, { keep: 'keep', remove: 'remove', apply: true }))
      .rejects.toThrow(/changed|blocked/i);
    expect(db.integration.updateMany).not.toHaveBeenCalled();
  });

  it('does not miss unresolved autonomous effects after a full page of settled receipts', async () => {
    const { db } = fixture();
    db.sendMutationReceipt.findMany.mockResolvedValueOnce(
      Array.from({ length: 500 }, (_, index) => ({
        id: `effect-${String(index).padStart(3, '0')}`,
        result: { integrationId: 'remove', status: 'CONFIRMED' },
      }))
    ).mockResolvedValueOnce([
      { id: 'later-effect', result: { integrationId: 'remove', status: 'UNKNOWN' } },
    ]);
    const result = await cleanupDuplicate(db, { keep: 'keep', remove: 'remove', apply: true });
    expect(result.preview.unsettledAutonomousEffectIds).toEqual(['later-effect']);
    expect(db.sendMutationReceipt.findMany.mock.calls[1][0].where).toEqual({
      organizationId: 'org', operation: 'autonomous-side-effect', id: { gt: 'effect-499' },
    });
    expect(db.integration.updateMany).not.toHaveBeenCalled();
  });

  it('rechecks blockers inside the transaction before any mutation', async () => {
    const { db } = fixture();
    db.projectSendBinding.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    await expect(cleanupDuplicate(db, { keep: 'keep', remove: 'remove', apply: true }))
      .rejects.toThrow(/changed|blocked/i);
    expect(db.integration.updateMany).not.toHaveBeenCalled();
  });

  it('aborts when identity changes after preview', async () => {
    const { db, rows } = fixture();
    db.$transaction.mockImplementation(async (fn: any) => {
      rows[1].internalId = 'new-id';
      return fn(db);
    });
    await expect(cleanupDuplicate(db, { keep: 'keep', remove: 'remove', apply: true }))
      .rejects.toThrow(/changed/i);
    expect(db.integration.updateMany).not.toHaveBeenCalled();
  });

  it('treats an already soft-deleted duplicate as an idempotent no-op', async () => {
    const { db, rows } = fixture();
    Object.assign(rows[1], { deletedAt: new Date(), disabled: true });
    const result = await cleanupDuplicate(db, { keep: 'keep', remove: 'remove', apply: true });
    expect(result).toMatchObject({ applied: false, preview: { alreadyDeleted: true, actions: [] } });
    expect(db.integration.updateMany).not.toHaveBeenCalled();
  });
});

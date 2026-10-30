import { expect, it, vi } from 'vitest';
import { applyPlan, preparePlan, TARGET_ORG, TARGET_POSTS, RecoveryService } from './recover-legacy-calendar';
function fixture() {
  const reviews = TARGET_POSTS.map((id, i) => ({ organizationId: TARGET_ORG, actorKey: 'admin', postId: id,
    recoveryRevision: 'a'.repeat(64), canResolve: true, reasons: [] as string[], action: 'QUARANTINE_LEGACY_THREAD', postIds: [id],
    posts: [{ id, state: 'DRAFT', platform: i === 4 ? 'reddit' : 'x', parentPostId: null, deleted: false,
      claimPresent: false, publicationEvidencePresent: false, captured: true }], receipts: [] }));
  const mode = { organizationId: TARGET_ORG, actorKey: 'admin', mode: 'CONTROLLED', configuredMode: 'CONTROLLED' as string | null, systemEnabled: true, canManage: true };
  const service: RecoveryService = {
    state: vi.fn(async () => mode),
    inspect: vi.fn(async id => structuredClone(reviews.find(r => r.postId === id)!)),
    archive: vi.fn(async id => ({ resolved: true, organizationId: TARGET_ORG, actorKey: 'admin', postId: id, quarantinedPostIds: [id] })),
  };
  return { reviews, mode, service };
}
it('prepares five thread reviews directly through the service without archiving', async () => {
  const f = fixture();
  const plan = await preparePlan('database-fingerprint', f.service);
  expect(plan.reviews).toHaveLength(5);
  expect(plan.version).toBe(3);
  expect(f.service.archive).not.toHaveBeenCalled();
});
it('uses fresh snapshots sequentially and persists before service mutation', async () => {
  const f = fixture();
  const plan = await preparePlan('db', f.service);
  f.reviews.forEach(r => r.recoveryRevision = 'b'.repeat(64));
  const journal: any = { version: 1, plan, operations: [] };
  let persisted = 0;
  const original = f.service.archive;
  f.service.archive = async (id, body) => {
    expect(persisted).toBe(journal.operations.length * 2 - 1);
    return original(id, body);
  };
  await applyPlan(plan, journal, f.service, 'Executors stopped; no pending submission.', () => persisted++);
  expect(journal.operations).toHaveLength(5);
  expect(journal.operations.every((o: any) => o.body.expectedRecoveryRevision === 'b'.repeat(64) && o.result)).toBe(true);
});
it('reuses the exact persisted service mutation after an uncertain result', async () => {
  const f = fixture();
  const plan = await preparePlan('db', f.service);
  const journal: any = { version: 1, plan, operations: [] };
  await expect(applyPlan(plan, journal, { ...f.service, archive: async () => { throw new Error('Lost result'); } }, 'Stopped.', () => {})).rejects.toThrow('Lost result');
  const original = structuredClone(journal.operations[0].body);
  const archive = f.service.archive;
  f.service.archive = async (id, body) => {
    if (id === TARGET_POSTS[0]) expect(body).toEqual(original);
    return archive(id, body);
  };
  await applyPlan(plan, journal, f.service, 'Stopped.', () => {});
  expect(journal.operations[0].body).toEqual(original);
});
it('rejects changed identity or thread membership before mutation', async () => {
  const f = fixture();
  const plan = await preparePlan('db', f.service);
  const journal: any = { version: 1, plan, operations: [] };
  f.mode.actorKey = 'other';
  await expect(applyPlan(plan, journal, f.service, 'Stopped.', () => {})).rejects.toThrow('MAINTENANCE_CONTEXT_CHANGED');
  f.mode.actorKey = 'admin';
  f.reviews[0].postIds.push('unexpected');
  await expect(applyPlan(plan, journal, f.service, 'Stopped.', () => {})).rejects.toThrow('THREAD_CHANGED');
  expect(f.service.archive).not.toHaveBeenCalled();
});
it('refuses a blocked review anywhere in the batch before archiving', async () => {
  const f = fixture();
  f.reviews[4].canResolve = false;
  const plan = await preparePlan('db', f.service);
  await expect(applyPlan(plan, { version: 1, plan, operations: [] }, f.service, 'Stopped.', () => {})).rejects.toThrow('REVIEW_BLOCKED');
  expect(f.service.archive).not.toHaveBeenCalled();
});

it('permits maintenance in configured controlled mode while actual sending is paused', async () => {
  const f = fixture();
  f.mode.mode = 'PAUSED';
  f.mode.systemEnabled = false;
  const plan = await preparePlan('db', f.service);
  await applyPlan(plan, { version: 1, plan, operations: [] }, f.service, 'Stopped.', () => {});
  expect(f.service.archive).toHaveBeenCalledTimes(5);
});

it('reports actual mode details when a different database has an autonomous organization', async () => {
  const f = fixture();
  f.mode.mode = 'AUTONOMOUS';
  f.mode.configuredMode = null;
  await expect(preparePlan('db', f.service)).rejects.toMatchObject({ message: 'ORGANIZATION_NOT_CONFIGURED_CONTROLLED',
    details: { mode: 'AUTONOMOUS', configuredMode: null, organizationId: TARGET_ORG } });
  expect(f.service.archive).not.toHaveBeenCalled();
});

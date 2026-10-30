import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SendModeService, organizationSendModeKey } from '../send-mode.service';
import { memorySendDatabase } from './support/memory-send-database';
import { setupSend } from './support/send-fixture';

beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const db = memorySendDatabase();
  const modes = new SendModeService(db);
  db.seed('organization', { id: 'org' });
  db.seed('user', { id: 'admin', isSuperAdmin: true, activated: true });
  db.seed('user', { id: 'platform-admin', isSuperAdmin: true, activated: true });
  db.seed('user', { id: 'member', isSuperAdmin: false, activated: true });
  db.seed('userOrganization', { organizationId: 'org', userId: 'admin', role: 'ADMIN', disabled: false });
  db.seed('userOrganization', { organizationId: 'org', userId: 'member', role: 'USER', disabled: false });
  db.seed('integration', { id: 'account', organizationId: 'org', providerIdentifier: 'x', internalId: '123', identityNamespace: 'x.rest_id' });
  db.seed('post', { id: 'root', organizationId: 'org', source: 'calendar', state: 'QUEUE',
    providerIdentifier: 'x', integrationId: null, publishMethod: null, parentPostId: null,
    publishDate: new Date('2026-03-29'), releaseId: 'old', releaseURL: 'https://x.com/example/status/1', deletedAt: new Date('2026-03-26') });
  db.seed('post', { id: 'child', organizationId: 'org', source: 'calendar', state: 'DRAFT',
    providerIdentifier: 'x', integrationId: null, parentPostId: 'root', publishDate: new Date('2026-03-29') });
  db.seed('settings', { key: organizationSendModeKey('org'), value: { mode: 'CONTROLLED', revision: 1,
    legacyDrain: { version: 2, targetMode: 'CONTROLLED', requestedAt: '2026-10-26T03:33:49.677Z', requestedByUserId: 'admin',
      initialPendingCount: 2, eligiblePostIds: ['root', 'child'], eligiblePostOccurrences: { root: '2026-03-29T00:00:00.000Z', child: '2026-03-29T00:00:00.000Z' }, effectReceiptIds: [] } } });
  const api = modes;
  const body = (revision: string) => ({ expectedOrganizationId: 'org', expectedUserId: 'admin', requestId: 'recover',
    expectedRecoveryRevision: revision, executorStopped: true, noPendingSubmit: true, evidence: 'All old executors stopped; retain historical results without resending.' });
  return { db, modes, api, body };
}
it('archives the entire historical calendar thread, preserves publication evidence and releases the platform', async () => {
  const { db, modes, api, body } = fixture();
  expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(true);
  const view = await api.getLegacyPostRecovery('org', 'admin', 'child');
  expect(view).toMatchObject({ canResolve: true, postIds: ['child', 'root'] });
  expect(JSON.stringify(view)).not.toContain('https://x.com');
  const request = body(view.recoveryRevision);
  const result = await api.resolveLegacyPostRecovery('org', 'admin', 'child', request);
  expect(result).toMatchObject({ resolved: true, quarantinedPostIds: ['child', 'root'] });
  expect(db.rows('post').find(p => p.id === 'root')).toMatchObject({ releaseURL: 'https://x.com/example/status/1', releaseId: null, executionProtocol: 'LEGACY_QUARANTINED' });
  expect(db.rows('post').every(p => p.deletedAt && p.state === 'DRAFT')).toBe(true);
  expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(false);
  await expect(modes.assertAutonomousIn(db, 'org', ['root'])).rejects.toThrow();
  expect(await api.resolveLegacyPostRecovery('org', 'admin', 'child', request)).toEqual(result);
  expect(db.rows('sendMutationReceipt').filter(r => r.operation === 'legacy-post-recovery')).toHaveLength(1);
});
it('refuses a changed snapshot and does not partially archive the thread', async () => {
  const { db, api, body } = fixture();
  const view = await api.getLegacyPostRecovery('org', 'admin', 'root');
  db.rows('post')[1].releaseId = 'new-claim';
  await expect(api.resolveLegacyPostRecovery('org', 'admin', 'root', body(view.recoveryRevision))).rejects.toThrow('LEGACY_POST_RECOVERY_CHANGED');
  expect(db.rows('post')[0].releaseId).toBe('old');
});
it('requires an administrator and explicit stop attestations', async () => {
  const { db, api, body } = fixture();
  await expect(api.getLegacyPostRecovery('org', 'member', 'root')).rejects.toThrow('PLATFORM_SUPERADMIN_REQUIRED');
  const view = await api.getLegacyPostRecovery('org', 'admin', 'root');
  await expect(api.resolveLegacyPostRecovery('org', 'admin', 'root', { ...body(view.recoveryRevision), noPendingSubmit: false })).rejects.toThrow('INVALID_LEGACY_POST_RECOVERY');
  await expect(api.getLegacyPostRecovery('other', 'admin', 'root')).rejects.toThrow();
  expect(db.rows('post')[0].releaseId).toBe('old');
});
it('refuses unresolved receipts and controlled descendants', async () => {
  const { db, api, body } = fixture();
  db.seed('sendMutationReceipt', { organizationId: 'org', userId: 'admin', operation: 'autonomous-side-effect', result: {
    revision: 1, status: 'UNKNOWN', action: 'POST', integrationId: 'browser:admin:x', browserUserId: 'admin', source: 'BROWSER', platform: 'x', postIds: ['root'], recurring: false, occurrenceKey: 'single' } });
  let view = await api.getLegacyPostRecovery('org', 'admin', 'root');
  expect(view.reasons).toContain('UNRESOLVED_RECEIPT');
  await expect(api.resolveLegacyPostRecovery('org', 'admin', 'root', body(view.recoveryRevision))).rejects.toThrow('LEGACY_POST_RECOVERY_UNSAFE');
  db.rows('sendMutationReceipt').length = 0;
  db.rows('post')[1].sendIntentId = 'controlled';
  view = await api.getLegacyPostRecovery('org', 'admin', 'root');
  expect(view.reasons).toContain('CONTROLLED_THREAD_MEMBER');
});
it('does not automatically release deleted or expired historical work', async () => {
  const { db, modes } = fixture();
  await modes.reconcilePendingTransitions();
  expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(true);
  expect(db.rows('post')[0].releaseId).toBe('old');
});

it('keeps published ancestors intact and rejects recovery request reuse with different evidence', async () => {
  const { db, api, body } = fixture();
  db.rows('post')[0].state = 'PUBLISHED';
  const original = structuredClone(db.rows('post')[0]);
  const view = await api.getLegacyPostRecovery('org', 'admin', 'child');
  const request = body(view.recoveryRevision);
  expect(await api.resolveLegacyPostRecovery('org', 'admin', 'child', request)).toMatchObject({ quarantinedPostIds: ['child'] });
  expect(db.rows('post')[0]).toEqual(original);
  await expect(api.resolveLegacyPostRecovery('org', 'admin', 'child', { ...request, evidence: 'Changed evidence' })).rejects.toThrow('REQUEST_ID_CONFLICT');
});

it('keeps archived content fenced after returning to autonomous mode', async () => {
  const { db, modes, api, body } = fixture();
  const view = await api.getLegacyPostRecovery('org', 'admin', 'root');
  await api.resolveLegacyPostRecovery('org', 'admin', 'root', body(view.recoveryRevision));
  await modes.reconcilePendingTransitions();
  expect((await modes.get('org', 'admin')).legacyDrain).toBeNull();
  db.rows('settings').find(row => row.key === organizationSendModeKey('org')).value = { mode: 'AUTONOMOUS', revision: 3 };
  await expect(modes.assertAutonomousIn(db, 'org', ['root'])).rejects.toThrow('LEGACY_CONTENT_QUARANTINED');
  expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(false);
});

it('rejects re-enqueueing an archived post even if its deletion flag is restored', async () => {
  const { db, service, create } = setupSend();
  await create();
  Object.assign(db.rows('post')[0], { state: 'DRAFT', sendIntentId: null, executionProtocol: 'LEGACY_QUARANTINED' });
  await expect(service.enqueue('org', 'root', { userId: 'user', origin: 'MANUAL' })).rejects.toThrow('LEGACY_CONTENT_QUARANTINED');
});

it('authorizes platform administrators without target membership and rejects organization-only administrators', async () => {
  const { db, api, body } = fixture();
  db.rows('userOrganization').find(row => row.userId === 'member').role = 'ADMIN';
  await expect(api.getAdminRecoveryState('org', 'member')).rejects.toThrow('PLATFORM_SUPERADMIN_REQUIRED');
  expect(await api.getAdminRecoveryState('org', 'platform-admin')).toMatchObject({ organizationId: 'org', userId: 'platform-admin', canManage: true });
  await expect(api.getAdminRecoveryState('missing', 'platform-admin')).rejects.toThrow('RECOVERY_ORGANIZATION_NOT_FOUND');
  await expect(api.getLegacyPostRecovery('org', 'member', 'root')).rejects.toThrow('PLATFORM_SUPERADMIN_REQUIRED');
  const review = await api.getLegacyPostRecovery('org', 'platform-admin', 'root');
  expect(review.canResolve).toBe(true);
  expect(await api.resolveLegacyPostRecovery('org', 'platform-admin', 'root', { ...body(review.recoveryRevision), expectedUserId: 'platform-admin' })).toMatchObject({ resolved: true, userId: 'platform-admin' });
  expect(db.rows('sendMutationReceipt').find(row => row.operation === 'legacy-post-recovery').userId).toBe('platform-admin');
});

it('audits local maintenance recovery without creating or impersonating a user', async () => {
  const { db, modes } = fixture();
  db.rows('user').length = 0;
  const actor = { kind: 'MAINTENANCE' as const, operator: 'local-operator', host: 'maintenance-host' };
  const service = modes as any;
  const review = await service.getMaintenancePostRecovery('org', actor, 'root');
  const request = { expectedOrganizationId: 'org', expectedActorKey: review.actorKey,
    requestId: 'maintenance', expectedRecoveryRevision: review.recoveryRevision,
    executorStopped: true, noPendingSubmit: true, evidence: 'Old workers stopped.' };
  const result = await service.resolveMaintenancePostRecovery('org', actor, 'root', request);
  expect(result).toMatchObject({ resolved: true, actor, actorKey: review.actorKey });
  expect(result).not.toHaveProperty('userId');
  expect(db.rows('sendMutationReceipt')).toHaveLength(0);
  const audit = db.rows('settings').find(row => row.key.startsWith('sending.maintenance-recovery:'));
  expect(audit.value.result).toEqual(result);
  expect(await service.resolveMaintenancePostRecovery('org', actor, 'root', request)).toEqual(result);
  await expect(service.resolveMaintenancePostRecovery('org', { ...actor, operator: 'different' }, 'root', request)).rejects.toThrow('MAINTENANCE_ACTOR_CHANGED');
  await expect(modes.getAdminRecoveryState('org', 'missing')).rejects.toThrow('PLATFORM_SUPERADMIN_REQUIRED');
});

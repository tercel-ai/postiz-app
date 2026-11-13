import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SendModeService, organizationSendModeKey } from '../send-mode.service';
import { memorySendDatabase } from './support/memory-send-database';
import { setupSend, sendNow } from './support/send-fixture';

beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
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


function missingReceiptReply() {
  const f = fixture();
  f.db.rows('post').splice(1);
  Object.assign(f.db.rows('post')[0], { source: 'engage', providerIdentifier: 'linkedin',
    integrationId: null, publishMethod: null, releaseURL: null, deletedAt: null,
    claimedAt: new Date('2026-11-06T06:37:19Z'), intervalInDays: null,
    projectId: 'project', content: 'Original historical reply' });
  Object.assign(f.db.rows('integration')[0], { providerIdentifier: 'linkedin', internalId: 'person', identityNamespace: 'linkedin.fs_miniProfile' });
  const drain = f.db.rows('settings')[0].value.legacyDrain;
  drain.eligiblePostIds = ['root'];
  delete drain.eligiblePostOccurrences.child;
  f.db.seed('engageSentReply', { id: 'saved-reply', organizationId: 'org', postId: 'root', projectId: 'project', opportunity: { platform: 'linkedin' } });
  return f;
}

it('quarantines one captured missing-receipt Engage writer without asserting absence or resending its content', async () => {
  const { db, modes } = missingReceiptReply();
  const actor = { kind: 'MAINTENANCE' as const, operator: 'operator', host: 'host' };
  const original = structuredClone(db.rows('post')[0]);
  expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(true);
  const view = await modes.getMaintenancePostRecovery('org', actor, 'root');
  expect(view).toMatchObject({ canResolve: true, reasons: [], postIds: ['root'] });
  const body = { expectedOrganizationId: 'org', expectedActorKey: view.actorKey, requestId: 'retire-old-reply',
    expectedRecoveryRevision: view.recoveryRevision, executorStopped: true, noPendingSubmit: true,
    evidence: 'All original browser executors stopped and no platform submit is pending; publication outcome remains unknown.' };
  const result = await modes.resolveMaintenancePostRecovery('org', actor, 'root', body);
  expect(result).toMatchObject({ resolved: true, quarantinedPostIds: ['root'] });
  expect(db.rows('post')[0]).toMatchObject({ content: original.content, claimedAt: original.claimedAt,
    releaseURL: null, releaseId: null, executionProtocol: 'LEGACY_QUARANTINED' });
  expect(db.rows('engageSentReply')).toHaveLength(1);
  expect(db.rows('sendIntent')).toHaveLength(0);
  expect(db.rows('sendExecution')).toHaveLength(0);
  expect(db.rows('sendMutationReceipt')).toHaveLength(0);
  expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(false);
  await expect(modes.assertAutonomousIn(db, 'org', ['root'])).rejects.toThrow('LEGACY_CONTENT_QUARANTINED');
  expect(await modes.resolveMaintenancePostRecovery('org', actor, 'root', body)).toEqual(result);
});

it.each(['not-captured', 'unclaimed', 'recurring', 'thread', 'api', 'published-url', 'missing-saved-reply', 'mismatched-project', 'mismatched-platform', 'orphan-intent', 'changed-occurrence', 'confirmed-receipt', 'unknown-receipt'])('does not admit unsafe missing-receipt Engage archival: %s', async kind => {
  const { db, modes } = missingReceiptReply();
  const root = db.rows('post')[0];
  if (kind === 'not-captured') { db.rows('settings')[0].value.legacyDrain.eligiblePostIds = []; db.rows('settings')[0].value.legacyDrain.eligiblePostOccurrences = {}; }
  if (kind === 'unclaimed') root.releaseId = null;
  if (kind === 'recurring') root.intervalInDays = 1;
  if (kind === 'thread') db.seed('post', { ...root, id: 'reply-child', parentPostId: 'root' });
  if (kind === 'api') root.publishMethod = 'API';
  if (kind === 'published-url') root.releaseURL = 'https://linkedin.com/comment/live';
  if (kind === 'missing-saved-reply') db.rows('engageSentReply').length = 0;
  if (kind === 'mismatched-project') db.rows('engageSentReply')[0].projectId = 'another-project';
  if (kind === 'mismatched-platform') db.rows('engageSentReply')[0].opportunity.platform = 'reddit';
  if (kind === 'orphan-intent') db.seed('sendIntent', { id: 'orphan', organizationId: 'org', rootPostId: 'root' });
  if (kind === 'changed-occurrence') db.rows('settings')[0].value.legacyDrain.eligiblePostOccurrences.root = '2026-11-05T00:00:00Z';
  if (kind === 'confirmed-receipt' || kind === 'unknown-receipt') db.seed('sendMutationReceipt', { organizationId: 'org', userId: 'admin', operation: 'autonomous-side-effect', result: {
    revision: 1, status: kind === 'confirmed-receipt' ? 'CONFIRMED' : 'UNKNOWN', action: 'COMMENT', source: 'BROWSER', browserUserId: 'admin', platform: 'linkedin',
    integrationId: 'browser:admin:linkedin', postIds: ['root'], recurring: false, occurrenceKey: 'single' } });
  const view = await modes.getMaintenancePostRecovery('org', { kind: 'MAINTENANCE', operator: 'operator', host: 'host' }, 'root');
  expect(view.canResolve).toBe(false);
  expect(root.executionProtocol).not.toBe('LEGACY_QUARANTINED');
});


it('admits an independent controlled reply after archival, while keeping both-mode replay and pacing protections', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(sendNow);
  const f = setupSend();
  f.db.seed('organization', { id: 'org' });
  await f.create('new-reply', 'EXTENSION');
  const fresh = f.db.rows('post')[0];
  fresh.source = 'engage';
  f.db.rows('sendIntent')[0].action = 'REPLY';
  const legacyDate = new Date('2026-10-10T00:00:00Z');
  f.db.seed('post', { ...fresh, id: 'old-reply', sendIntentId: null, executionProtocol: null,
    group: 'old-reply', state: 'QUEUE', releaseId: 'original-private-claim', claimedAt: legacyDate,
    publishDate: legacyDate, integrationId: null, publishMethod: null, intervalInDays: null });
  f.db.seed('engageSentReply', { id: 'old-saved', postId: 'old-reply', projectId: 'project', organizationId: 'org', opportunity: { platform: 'x' } });
  f.db.rows('settings')[0].value.legacyDrain = { version: 2, targetMode: 'CONTROLLED', requestedByUserId: 'user',
    requestedAt: legacyDate.toISOString(), initialPendingCount: 1, eligiblePostIds: ['old-reply'],
    eligiblePostOccurrences: { 'old-reply': legacyDate.toISOString() }, effectReceiptIds: [] };
  const session: any = { integrationId: 'account', verificationStatus: 'VERIFIED',
    verificationExpiresAt: new Date('2100-01-01'), accountIdentity: { id: '123', namespace: 'x.rest_id' } };
  expect(await f.service.claimabilityReasonIn(f.db, 'org', fresh, session, 'REPLY', new Date())).toBe('LEGACY_ACCOUNT_BLOCKED');
  const modes = new SendModeService(f.db);
  const actor = { kind: 'MAINTENANCE' as const, operator: 'operator', host: 'host' };
  const view = await modes.getMaintenancePostRecovery('org', actor, 'old-reply');
  await modes.resolveMaintenancePostRecovery('org', actor, 'old-reply', { expectedOrganizationId: 'org', expectedActorKey: view.actorKey,
    requestId: 'archive-old', expectedRecoveryRevision: view.recoveryRevision, executorStopped: true, noPendingSubmit: true, evidence: 'Original executor stopped; no pending submission.' });
  expect(await f.service.claimabilityReasonIn(f.db, 'org', fresh, session, 'REPLY', new Date())).toBeNull();
  expect(f.db.rows('sendIntent')).toHaveLength(1);
  expect(f.db.rows('post').find(p => p.id === 'old-reply').claimedAt).toEqual(legacyDate);
  // Restoring visibility cannot restore archived content's sending authority.
  f.db.rows('post').find(p => p.id === 'old-reply').deletedAt = null;
  await expect(f.service.enqueue('org', 'old-reply', { userId: 'user', origin: 'MANUAL', action: 'REPLY' })).rejects.toThrow('LEGACY_CONTENT_QUARANTINED');
  f.db.rows('accountWriteState')[0].nextWriteNotBefore = new Date(Date.now() + 60000);
  expect(await f.service.claimabilityReasonIn(f.db, 'org', fresh, session, 'REPLY', new Date())).toBe('ACCOUNT_COOLDOWN_ACTIVE');
  f.db.rows('settings')[0].value = { mode: 'AUTONOMOUS', revision: 2 };
  await expect(modes.assertAutonomousIn(f.db, 'org', ['old-reply'])).rejects.toThrow('LEGACY_CONTENT_QUARANTINED');
});

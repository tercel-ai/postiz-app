import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SendModeService, organizationSendModeKey } from '../send-mode.service';
import { memorySendDatabase } from './support/memory-send-database';
import { setupSend } from './support/send-fixture';

beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());
const owner = { expectedOrganizationId: 'org', expectedUserId: 'admin' };
const change = { ...owner, mode: 'CONTROLLED' as const, expectedRevision: 0, requestId: 'switch' };
function setup() {
 const db = memorySendDatabase();
 db.seed('userOrganization', { organizationId: 'org', userId: 'admin', role: 'ADMIN', disabled: false });
 db.seed('integration', { id: 'account', organizationId: 'org', providerIdentifier: 'x', internalId: '123', identityNamespace: 'x.rest_id', disabled: false, deletedAt: null });
 const modes = new SendModeService(db);
 const post = (id: string, extra = {}) => db.seed('post', { id, organizationId: 'org', parentPostId: null,
   state: 'QUEUE', providerIdentifier: 'x', integrationId: 'account', publishMethod: 'API',
   publishDate: new Date('2026-12-15'), createdAt: new Date('2026-10-19'), ...extra });
 return { db, modes, post };
}
it('enters controlled immediately and separates stale claimed work from unstarted reallocation', async () => {
 const { db, modes, post } = setup();
 post('claimed', { releaseId: 'old-lease', claimedAt: new Date('2026-10-19') }); post('future');
 const before = structuredClone(db.rows('post'));
 expect(await modes.save('org', 'admin', change)).toMatchObject({ mode: 'CONTROLLED', configuredMode: 'CONTROLLED',
   autonomousAllowed: false, revision: 1, transition: null,
   legacyDrain: { remainingCount: 1, status: 'NEEDS_ATTENTION' }, reallocation: { remainingCount: 1 } });
 expect(db.rows('post')).toEqual(before);
 await expect(modes.assertAutonomousIn(db, 'org')).rejects.toThrow('SEND_MODE_AUTONOMOUS_REQUIRED');
 await expect(modes.assertAutonomousIn(db, 'org', ['claimed'])).resolves.toBeDefined();
 await expect(modes.assertAutonomousIn(db, 'org', ['future'])).rejects.toThrow();
 expect(await modes.autonomousDrainPostIdsIn(db, 'org')).toEqual([]);
});
it('keeps controlled mode active with an unknown browser receipt and accepts its late settlement', async () => {
 const { modes } = setup();
 const grant = await modes.beginBrowserWrite('org', 'admin', { ...owner, requestId: 'write', platform: 'x', contentHash: 'a'.repeat(64) });
 expect(await modes.save('org', 'admin', change)).toMatchObject({ mode: 'CONTROLLED', transition: null,
   legacyDrain: { remainingCount: 1 } });
 await expect(modes.beginBrowserWrite('org', 'admin', { ...owner, requestId: 'new', platform: 'reddit', contentHash: 'a'.repeat(64) })).rejects.toThrow('SEND_MODE_AUTONOMOUS_REQUIRED');
 await modes.settleBrowserWrite('org', 'admin', grant.id, { ...owner, status: 'NOT_SUBMITTED' });
 await modes.reconcilePendingTransitions();
 expect(await modes.get('org', 'admin')).toMatchObject({ mode: 'CONTROLLED', legacyDrain: null });
});
it.each([1, 2])('automatically upgrades an existing pending v%s switch despite a stale claim', async version => {
 const { db, modes, post } = setup(); post('claimed', { releaseId: 'lease', claimedAt: new Date('2026-10-19') });
 db.seed('settings', { key: organizationSendModeKey('org'), value: { mode: 'AUTONOMOUS', revision: 1,
   transition: { version, targetMode: 'CONTROLLED', requestedAt: '2026-10-20T09:00:00Z', requestedByUserId: 'admin',
     initialPendingCount: 1, eligiblePostIds: ['claimed'], eligiblePostOccurrences: { claimed: '2026-12-15T00:00:00.000Z' } } } });
 await modes.reconcilePendingTransitions();
 expect(await modes.get('org', 'admin')).toMatchObject({ mode: 'CONTROLLED', revision: 2, transition: null, legacyDrain: { remainingCount: 1 } });
});
it('blocks only the claimed API actor, including another integration representing the same identity', async () => {
 const { db, modes, post } = setup(); post('claimed', { releaseId: 'lease' });
 db.seed('integration', { id: 'alias', organizationId: 'org', providerIdentifier: 'x', internalId: '123', identityNamespace: 'x.rest_id' });
 db.seed('integration', { id: 'other', organizationId: 'org', providerIdentifier: 'x', internalId: '456', identityNamespace: 'x.rest_id' });
 await modes.save('org', 'admin', change);
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(true);
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'alias')).toBe(true);
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'other')).toBe(false);
 db.rows('post')[0].state = 'PUBLISHED';
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(false);
});
it('isolates unknown browser writes by platform without guessing a historical account from current sessions', async () => {
 const { db, modes } = setup();
 db.seed('integration', { id: 'reddit', organizationId: 'org', providerIdentifier: 'reddit', internalId: 'r1', identityNamespace: 'reddit.user_id' });
 await modes.beginBrowserWrite('org', 'admin', { ...owner, requestId: 'write', platform: 'x', contentHash: 'a'.repeat(64) });
 await modes.save('org', 'admin', change);
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(true);
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'reddit')).toBe(false);
});
it('preserves legacy ownership independently of an immediate reverse switch', async () => {
 const { modes, post } = setup(); post('claimed', { releaseId: 'lease' }); await modes.save('org', 'admin', change);
 expect(await modes.save('org', 'admin', { ...owner, mode: 'AUTONOMOUS', expectedRevision: 1, requestId: 'reverse' })).toMatchObject({ mode: 'AUTONOMOUS', legacyDrain: { remainingCount: 1 } });
});
it('checks legacy account ownership again at controlled reservation rather than only during discovery', async () => {
 const { db, service, create, now } = setupSend(); await create();
 db.seed('post', { id: 'legacy', organizationId: 'org', state: 'QUEUE', releaseId: 'old', publishMethod: 'API',
   providerIdentifier: 'x', integrationId: 'account', publishDate: now });
 await expect(service.reserveApi('org', 'root', 'worker', now)).rejects.toThrow('LEGACY_ACCOUNT_DRAIN_REQUIRED');
 expect(db.rows('sendExecution')).toHaveLength(0);
});

it('keeps the browser platform guarded after confirmation until the saved post callback settles', async () => {
 const { db, modes, post } = setup(); post('saved');
 db.seed('integration', { id: 'other-x', organizationId: 'org', providerIdentifier: 'x', internalId: '456', identityNamespace: 'x.rest_id' });
 const grant = await modes.beginBrowserWrite('org', 'admin', { ...owner, requestId: 'write', platform: 'x', postId: 'saved', contentHash: 'a'.repeat(64) });
 await modes.settleBrowserWrite('org', 'admin', grant.id, { ...owner, status: 'CONFIRMED', platformPostId: 'remote' });
 await modes.save('org', 'admin', change);
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'other-x')).toBe(true);
 db.rows('post')[0].state = 'PUBLISHED';
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'other-x')).toBe(false);
});
it('rechecks old ownership at final authorization even for an already reserved controlled execution', async () => {
 const { db, service, create, now } = setupSend(); await create();
 const execution = await service.reserveApi('org', 'root', 'worker', now);
 db.seed('post', { id: 'legacy', organizationId: 'org', state: 'QUEUE', releaseId: 'old', publishMethod: 'API',
   providerIdentifier: 'x', integrationId: 'account', publishDate: now });
 await expect(service.authorizeApiSegment('org', execution.id, 0, { id: '123', idNamespace: 'x.rest_id' }, now)).rejects.toThrow('LEGACY_ACCOUNT_DRAIN_REQUIRED');
 expect(db.rows('sendSegment')[0].status).toBe('PENDING');
});

it('allows an unrelated API actor to reserve normally while old work remains claimed', async () => {
 const { db, service, create, now } = setupSend(); await create();
 db.seed('integration', { id: 'old-account', organizationId: 'org', providerIdentifier: 'x',
   internalId: 'different', identityNamespace: 'x.rest_id', disabled: true, deletedAt: now });
 db.seed('post', { id: 'legacy', organizationId: 'org', state: 'QUEUE', releaseId: 'old', publishMethod: 'API',
   providerIdentifier: 'x', integrationId: 'old-account', publishDate: now });
 expect(await service.reserveApi('org', 'root', 'worker', now)).toMatchObject({ status: 'RESERVED' });
});
it('does not release a claimed account merely because its old post or integration was soft-deleted', async () => {
 const { db, modes, post } = setup(); post('claimed', { releaseId: 'lease', deletedAt: new Date() });
 db.rows('integration')[0].deletedAt = new Date();
 expect(await modes.save('org', 'admin', change)).toMatchObject({ mode: 'CONTROLLED', legacyDrain: { remainingCount: 1 } });
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(true);
});
it('releases a captured thread only with its own non-submission proof and a settled business callback', async () => {
 const { db, modes, post } = setup();
 post('root', { releaseId: 'lease' }); post('child', { state: 'DRAFT', parentPostId: 'root' });
 const grant = await modes.beginBrowserWrite('org', 'admin', { ...owner, requestId: 'write', platform: 'x', postId: 'root', contentHash: 'a'.repeat(64) });
 await modes.save('org', 'admin', change);
 await modes.settleBrowserWrite('org', 'admin', grant.id, { ...owner, status: 'NOT_SUBMITTED' });
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(true);
 Object.assign(db.rows('post')[0], { state: 'ERROR', releaseId: null });
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(false);
 await modes.reconcilePendingTransitions();
 expect((await modes.get('org', 'admin')).legacyDrain).toBeNull();
 expect(db.rows('post')[1]).toMatchObject({ state: 'DRAFT', parentPostId: 'root' });
});
it('does not use an older non-submission proof to erase a later captured untracked claim', async () => {
 const { db, modes, post } = setup(); post('root');
 const old = await modes.beginBrowserWrite('org', 'admin', { ...owner, requestId: 'old-write', platform: 'x', postId: 'root', contentHash: 'a'.repeat(64) });
 await modes.settleBrowserWrite('org', 'admin', old.id, { ...owner, status: 'NOT_SUBMITTED' });
 Object.assign(db.rows('post')[0], { releaseId: 'new-legacy-lease', claimedAt: new Date() });
 await modes.save('org', 'admin', change);
 Object.assign(db.rows('post')[0], { state: 'ERROR', releaseId: null });
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(true);
 expect(await modes.get('org', 'admin')).toMatchObject({ legacyDrain: { remainingCount: 1 } });
});

it.each([1, 2])('retains uncertain error ownership while upgrading a persisted v%s transition', async version => {
 const { db, modes, post } = setup(); post('captured', { state: 'ERROR', releaseId: null });
 db.seed('settings', { key: organizationSendModeKey('org'), value: { mode: 'AUTONOMOUS', revision: 1,
  transition: { version, targetMode: 'CONTROLLED', requestedAt: '2026-10-20T09:00:00Z', requestedByUserId: 'admin',
   initialPendingCount: 1, eligiblePostIds: ['captured'], eligiblePostOccurrences: { captured: '2026-12-15T00:00:00.000Z' } } } });
 await modes.reconcilePendingTransitions();
 expect(await modes.get('org', 'admin')).toMatchObject({ mode: 'CONTROLLED', legacyDrain: { remainingCount: 1 } });
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(true);
});
it('links a post-cutover API continuation receipt to its drain before releasing on non-submission proof', async () => {
 const { db, modes, post } = setup(); post('captured', { releaseId: 'lease', claimedAt: new Date() });
 await modes.save('org', 'admin', change);
 await expect(modes.autonomousEffect('org', 'late-api-admission', { integrationId: 'account', action: 'POST',
   postIds: ['captured'], occurrenceKey: 'single' }, async () => { throw new Error('Lost result'); })).rejects.toThrow('AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
 const [effect] = (await modes.listAutonomousEffects('org', 'admin')).items;
 await modes.resolveAutonomousEffect('org', 'admin', effect.id, { ...owner, requestId: 'resolve',
   expectedRevision: 2, decision: 'NOT_SUBMITTED', executorStopped: true, noPendingSubmit: true,
   evidence: 'Executor stopped and platform checked.' });
 Object.assign(db.rows('post')[0], { state: 'ERROR', releaseId: null });
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(false);
 await modes.reconcilePendingTransitions();
 expect((await modes.get('org', 'admin')).legacyDrain).toBeNull();
});
it('does not adopt an admitted legacy draft into a new controlled intent', async () => {
 const { db, service, now } = setupSend();
 db.rows('settings')[0].value = { mode: 'AUTONOMOUS', revision: 1 };
 db.rows('userOrganization')[0].role = 'ADMIN';
 db.seed('post', { id: 'draft', organizationId: 'org', projectId: 'project', state: 'DRAFT', parentPostId: null,
   group: 'draft', providerIdentifier: 'x', integrationId: 'account', content: 'original', settings: '{}', image: '[]', publishDate: now });
 const modes = new SendModeService(db); const userOwner = { expectedOrganizationId: 'org', expectedUserId: 'user' };
 await modes.beginBrowserWrite('org', 'user', { ...userOwner, requestId: 'write', platform: 'x', postId: 'draft', contentHash: 'a'.repeat(64) });
 await modes.save('org', 'user', { ...userOwner, mode: 'CONTROLLED', expectedRevision: 1, requestId: 'switch' });
 await expect(service.enqueue('org', 'draft', { userId: 'user', origin: 'MANUAL', explicitIntegrationId: 'account' }))
   .rejects.toThrow('LEGACY_CONTENT_DRAIN_REQUIRED');
 expect(db.rows('sendIntent')).toHaveLength(0);
});
it.each([1, 2])('keeps missing captured work protected when upgrading a v%s pending request', async version => {
 const { db, modes } = setup();
 db.seed('settings', { key: organizationSendModeKey('org'), value: { mode: 'AUTONOMOUS', revision: 1,
  transition: { version, targetMode: 'CONTROLLED', requestedAt: '2026-10-20T09:00:00Z', requestedByUserId: 'admin',
   initialPendingCount: 1, eligiblePostIds: ['missing'], eligiblePostOccurrences: { missing: '2026-10-20T00:00:00.000Z' } } } });
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(true);
 await modes.reconcilePendingTransitions();
 expect(await modes.get('org', 'admin')).toMatchObject({ mode: 'CONTROLLED',
   legacyDrain: { remainingCount: 1, status: 'NEEDS_ATTENTION', waitReason: 'RECONCILIATION_REQUIRED' } });
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(true);
});
it('holds the linkedin platform family for an old page browser write without holding x', async () => {
 const { db, modes } = setup();
 db.seed('integration', { id: 'person', organizationId: 'org', providerIdentifier: 'linkedin', internalId: 'person', identityNamespace: 'linkedin.member_urn' });
 db.seed('integration', { id: 'page', organizationId: 'org', providerIdentifier: 'linkedin-page', internalId: 'page', identityNamespace: 'linkedin.organization_urn' });
 await modes.beginBrowserWrite('org', 'admin', { ...owner, requestId: 'page-write', platform: 'linkedin-page', contentHash: 'a'.repeat(64) });
 await modes.save('org', 'admin', change);
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'person')).toBe(true);
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'page')).toBe(true);
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(false);
});
it('keeps CONTROLLED active but refuses execution when a captured actor has no platform evidence', async () => {
 const { db, modes, post } = setup();
 post('unidentified', { releaseId: 'old', integrationId: null, providerIdentifier: null, publishMethod: 'EXTENSION' });
 expect(await modes.save('org', 'admin', change)).toMatchObject({ mode: 'CONTROLLED', legacyDrain: { remainingCount: 1 } });
 expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(true);
 const coordinated = setupSend();
 await coordinated.create();
 coordinated.db.seed('post', { id: 'unknown-actor', organizationId: 'org', state: 'QUEUE', releaseId: 'old',
   integrationId: null, providerIdentifier: null, publishMethod: 'EXTENSION', publishDate: coordinated.now });
 await expect(coordinated.service.reserveApi('org', 'root', 'worker', coordinated.now))
   .rejects.toThrow('LEGACY_ACCOUNT_DRAIN_REQUIRED');
 expect(coordinated.db.rows('sendExecution')).toHaveLength(0);
});

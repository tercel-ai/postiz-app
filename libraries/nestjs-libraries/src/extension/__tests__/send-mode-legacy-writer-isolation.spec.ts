import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SendModeService, organizationSendModeKey } from '../send-mode.service';
import { setupSend, sendNow } from './support/send-fixture';

function fixture() {
  const f = setupSend();
  const claimedAt = new Date(sendNow.getTime() - 60_000);
  f.db.seed('integration', { id: 'linkedin', organizationId: 'org', providerIdentifier: 'linkedin',
    internalId: 'member', identityNamespace: 'linkedin.fs_miniProfile' });
  f.db.seed('post', { id: 'legacy-reply', organizationId: 'org', projectId: 'project',
    state: 'QUEUE', source: 'engage', executionProtocol: 'LEGACY', publishMethod: 'EXTENSION',
    providerIdentifier: 'linkedin', integrationId: null, parentPostId: null,
    releaseId: 'historical-lease', claimedAt, publishDate: claimedAt, content: 'old reply',
    settings: '{}', image: '[]' });
  f.db.seed('sendMutationReceipt', { id: 'unsent-proof', organizationId: 'org', userId: 'browser-user',
    operation: 'autonomous-side-effect', createdAt: new Date(claimedAt.getTime() + 1_000),
    result: { status: 'NOT_SUBMITTED', revision: 2, source: 'BROWSER', platform: 'linkedin',
      browserUserId: 'browser-user', integrationId: 'browser:browser-user:linkedin',
      action: 'COMMENT', postIds: ['legacy-reply'], recurring: false, occurrenceKey: 'single' } });
  f.db.rows('settings')[0].value = { mode: 'CONTROLLED', revision: 2,
    legacyDrain: { version: 2, targetMode: 'CONTROLLED', requestedAt: sendNow.toISOString(),
      requestedByUserId: 'user', initialPendingCount: 1, eligiblePostIds: ['legacy-reply'],
      eligiblePostOccurrences: { 'legacy-reply': claimedAt.toISOString() }, effectReceiptIds: [] } };
  const modes = new SendModeService(f.db);
  return { ...f, modes, post: f.db.rows('post')[0], receipt: f.db.rows('sendMutationReceipt')[0] };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(sendNow);
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it('quarantines a historical unsent LinkedIn reply without retaining a platform writer', async () => {
  const { db, modes, service } = fixture();
  const before = structuredClone({ posts: db.rows('post'), receipts: db.rows('sendMutationReceipt'), settings: db.rows('settings') });
  expect(await modes.legacyAccountBlockedIn(db, 'org', 'linkedin')).toBe(false);
  expect(await modes.legacyAccountBlockedIn(db, 'org', null, 'linkedin-page')).toBe(false);
  expect(await modes.activeLegacyPostIdsIn(db, 'org')).toContain('legacy-reply');
  await expect(service.enqueue('org', 'legacy-reply', { userId: 'user', origin: 'MANUAL' }))
    .rejects.toThrow('LEGACY_CONTENT_DRAIN_REQUIRED');
  await expect(modes.beginBrowserWrite('org', 'user', { expectedOrganizationId: 'org', expectedUserId: 'user',
    requestId: 'must-not-reopen', platform: 'linkedin', contentHash: 'a'.repeat(64) }))
    .rejects.toThrow('SEND_MODE_AUTONOMOUS_REQUIRED');
  expect({ posts: db.rows('post'), receipts: db.rows('sendMutationReceipt'), settings: db.rows('settings') }).toEqual(before);
});

it('admits and authorizes an independent controlled send through the same historical guard', async () => {
  const { db, modes, service, create, post, receipt, now } = fixture();
  post.providerIdentifier = 'x';
  Object.assign(receipt.result, { platform: 'x', integrationId: 'browser:browser-user:x' });
  await create();
  const execution = await service.reserveApi('org', 'root', 'worker', now);
  expect(execution.status).toBe('RESERVED');
  expect(await service.authorizeApiSegment('org', execution.id, 0, { id: '123', idNamespace: 'x.rest_id' }, now))
    .toMatchObject({ granted: true });
  expect(await modes.activeLegacyPostIdsIn(db, 'org')).toContain('legacy-reply');
  expect(db.rows('post').find(row => row.id === 'legacy-reply').releaseId).toBe('historical-lease');
});

it.each(['AUTHORIZED', 'UNKNOWN', 'CONFIRMED'])('retains the guard when another receipt is %s', async status => {
  const { db, modes, receipt } = fixture();
  db.seed('sendMutationReceipt', { ...receipt, id: 'other', result: { ...receipt.result, status } });
  expect(await modes.legacyAccountBlockedIn(db, 'org', 'linkedin')).toBe(true);
});

it.each(['no-proof', 'older-proof', 'missing-claim-time', 'invalid-proof-time', 'changed-binding',
  'api', 'not-engage', 'parent', 'child', 'recurring-post', 'recurring-proof', 'wrong-platform',
  'wrong-action', 'wrong-occurrence', 'multi-post', 'url', 'autonomous', 'foreign-proof'])
('does not infer a settled historical browser writer from %s', async kind => {
  const { db, modes, post, receipt } = fixture();
  if (kind === 'no-proof') db.rows('sendMutationReceipt').length = 0;
  if (kind === 'older-proof') post.claimedAt = new Date(sendNow.getTime() - 1_000);
  if (kind === 'missing-claim-time') post.claimedAt = null;
  if (kind === 'invalid-proof-time') receipt.createdAt = null;
  if (kind === 'changed-binding') receipt.result.legacyClaim = { releaseId: 'other-lease', claimedAt: post.claimedAt.toISOString() };
  if (kind === 'api') post.publishMethod = 'API';
  if (kind === 'not-engage') post.source = 'calendar';
  if (kind === 'parent') post.parentPostId = 'parent';
  if (kind === 'child') db.seed('post', { id: 'child', organizationId: 'org', parentPostId: post.id, state: 'PUBLISHED', deletedAt: sendNow });
  if (kind === 'recurring-post') post.intervalInDays = 1;
  if (kind === 'recurring-proof') receipt.result.recurring = true;
  if (kind === 'wrong-platform') Object.assign(receipt.result, { platform: 'x', integrationId: 'browser:browser-user:x' });
  if (kind === 'wrong-action') receipt.result.action = 'POST';
  if (kind === 'wrong-occurrence') receipt.result.occurrenceKey = 'another-occurrence';
  if (kind === 'multi-post') receipt.result.postIds.push('other-post');
  if (kind === 'url') post.releaseURL = 'https://linkedin.com/comment/existing';
  if (kind === 'autonomous') db.rows('settings').find(row => row.key === organizationSendModeKey('org')).value.mode = 'AUTONOMOUS';
  if (kind === 'foreign-proof') receipt.organizationId = 'other';
  expect(await modes.legacyAccountBlockedIn(db, 'org', 'linkedin')).toBe(true);
});

it('accepts exact lease-bound proof without depending on receipt timestamp order', async () => {
  const { db, modes, post, receipt } = fixture();
  receipt.createdAt = new Date(post.claimedAt.getTime() - 1);
  receipt.result.legacyClaim = { releaseId: post.releaseId, claimedAt: post.claimedAt.toISOString() };
  expect(await modes.legacyAccountBlockedIn(db, 'org', 'linkedin')).toBe(false);
  expect(post.releaseId).toBe('historical-lease');
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setupSend, sendNow } from './support/send-fixture';
import { SendExecutionService } from '../send-execution.service';
import { confirmSendPreflight } from '../send-preflight';

const auth = { org: 'org', user: 'user', nodeId: 'node', token: 'token' };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(sendNow); vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'); vi.stubEnv('SEND_EXECUTION_CREDENTIAL_KEY', 'test-key-with-more-than-32-characters-for-reply-edit'); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function fixture(native = true, claimed = true) {
  const f = setupSend();
  (f.policies as any).lockSystemInTransaction = () => f.policies.getSystem();
  await f.create('root', 'EXTENSION');
  const post = f.db.rows('post')[0]; post.source = 'engage'; post.settings = JSON.stringify({ __type: 'x', reply: '12345' }); post.publishDate = new Date(+sendNow - 1000);
  const intent = f.db.rows('sendIntent')[0]; intent.action = 'REPLY';
  f.db.seed('engageOpportunity', { id: 'opportunity', externalPostId: '12345', externalPostUrl: 'https://x.com/a/status/12345', platform: 'x' });
  f.db.seed('engageSentReply', { id: 'reply', organizationId: 'org', projectId: 'project', postId: 'root', opportunityId: 'opportunity', inputData: { strategy: 'old', mentions: ['kept'] }, removedAt: null });
  f.db.rows('engageSentReply')[0].post = post;
  f.db.seed('extensionNode', { id: 'node', nodeId: 'node', organizationId: 'org', credentialVersion: 1, status: 'ACTIVE', capabilities: { x: { post: true, reply: true, strictAccountVerification: true } } });
  f.db.seed('extensionNodeSession', { extensionNodeId: 'node', organizationId: 'org', platform: 'x', integrationId: 'account', verificationStatus: 'VERIFIED', verificationExpiresAt: new Date(+sendNow + 300000), sessionRevision: 1, probeId: 'old', accountIdentity: { id: '123', namespace: 'x.rest_id' } });
  const nodes = { authenticateIn: vi.fn(async () => f.db.rows('extensionNode')[0]) };
  const executions = new SendExecutionService(f.db as any, nodes as any, f.service);
  const item = claimed ? (await executions.claim(auth, { requestId: 'old-claim', action: 'REPLY', ...(native ? { authorizationMode: 'NATIVE_FLOW_V1' as const } : {}) })).items[0] : undefined;
  const body: any = { requestId: 'edit-reply', expectedRouteRevision: 0, expectedContentRevision: 1, content: 'edited reply', strategy: 'new', scheduledAt: null };
  const edit = (value = body) => (f.service as any).editUnsentReply('org', 'user', 'reply', value);
  const proof = async () => {
    const challenge = await executions.preflight(auth, item!.executionId, 0, item!.leaseToken);
    const session = f.db.rows('extensionNodeSession')[0]; session.probeId = 'fresh';
    await f.db.$transaction((tx: any) => confirmSendPreflight(tx, f.db.rows('extensionNode')[0], { platform: 'x', id: '123', identityNamespace: 'x.rest_id', loggedIn: true, evidenceKind: 'LIVE_COOKIE_ID', probeId: 'fresh', identityObservedAt: sendNow.toISOString(), preflightChallenge: challenge.challenge }, session, 'old', sendNow));
  };
  return { ...f, post, intent, executions, item: item!, body, edit, proof };
}
it('exposes safe controlled Reply editing and atomically revokes its native preparation on the original record', async () => {
  const f = await fixture();
  expect((await f.service.businessSummary('org', 'user', 'root')).allowedActions.edit.allowed).toBe(true);
  const old = structuredClone(f.db.rows('sendExecution')[0]);
  const result = await f.edit();
  expect(result).toMatchObject({ id: 'reply', postId: 'root', post: { content: 'edited reply', state: 'QUEUE' }, sending: { rootPostId: 'root', sendIntentId: old.sendIntentId, routeRevision: 1, contentRevision: 2 } });
  expect(f.db.rows('sendExecution')[0]).toMatchObject({ id: old.id, status: 'CANCELLED', payload: old.payload });
  expect(f.db.rows('engageSentReply')[0].inputData).toEqual({ strategy: 'new', mentions: ['kept'] });
  expect(f.db.rows('post')[0].settings).toBe(f.post.settings);
  expect(f.db.rows('sendIntent')).toHaveLength(1); expect(f.db.rows('engageSentReply')).toHaveLength(1);
  expect(f.db.rows('sendQuotaReservation')).toHaveLength(0);
  await expect(f.executions.preflight(auth, f.item.executionId, 0, f.item.leaseToken)).rejects.toThrow();
});
it('replays the exact controlled Reply edit acknowledgement after response loss without another revision or date change', async () => {
  const f = await fixture(); const first = await f.edit(); vi.setSystemTime(new Date(+sendNow + 10000));
  expect(await f.edit()).toEqual(JSON.parse(JSON.stringify(first)));
  expect(f.db.rows('post')[0]).toMatchObject({ contentRevision: 2, routeRevision: 1, publishDate: sendNow });
  await expect(f.edit({ ...f.body, content: 'different' })).rejects.toThrow('REQUEST_ID_CONFLICT');
});
it.each(['old-client', 'AUTHORIZED', 'UNKNOWN', 'CONFIRMED', 'exposed', 'quota'])(
  'does not edit a Reply with %s authority or evidence', async kind => {
    const f = await fixture(kind !== 'old-client'); const segment = f.db.rows('sendSegment')[0];
    if (['AUTHORIZED', 'UNKNOWN', 'CONFIRMED'].includes(kind)) segment.status = kind;
    if (kind === 'exposed') segment.result = { status: 'draft_exposed' };
    if (kind === 'quota') f.db.seed('sendQuotaReservation', { organizationId: 'org', executionId: f.item.executionId });
    await expect(f.edit()).rejects.toThrow(); expect(f.db.rows('post')[0].content).toBe('hello');
  }
);
it.each(['expectedRouteRevision', 'expectedContentRevision'])('requires the original Reply %s and rejects stale edits', async field => {
  const f = await fixture(); await expect(f.edit({ ...f.body, [field]: 9 })).rejects.toThrow();
  expect(f.db.rows('sendExecution')[0].status).toBe('RESERVED');
});
it('preserves an omitted schedule and accepts a future schedule without reopening quota or changing automatic origin', async () => {
  const f = await fixture(true, false); const future = new Date(+sendNow + 3600000); f.post.publishDate = future; f.intent.sendOrigin = 'AUTOMATION';
  const { scheduledAt, ...body } = f.body; await f.edit(body);
  expect(f.db.rows('post')[0].publishDate).toEqual(future); expect(f.db.rows('sendIntent')[0].sendOrigin).toBe('AUTOMATION');
  const next = new Date(+future + 3600000); await f.edit({ ...body, requestId: 'schedule', expectedRouteRevision: 1, expectedContentRevision: 2, scheduledAt: next.toISOString() });
  expect(f.db.rows('post')[0].publishDate).toEqual(next);
});
it.each([true, false])('serializes controlled Reply editing with authorization (start first: %s)', async first => {
  const f = await fixture(); await f.proof();
  const start = () => f.executions.start(auth, f.item.executionId, 0, f.item.leaseToken, { authorizationMode: 'NATIVE_FLOW_V1' });
  const results = await Promise.allSettled(first ? [start(), f.edit()] : [f.edit(), start()]);
  const edited = results[first ? 1 : 0].status === 'fulfilled';
  expect(edited && f.db.rows('sendSegment')[0].status === 'AUTHORIZED').toBe(false);
  expect(edited || f.db.rows('sendSegment')[0].status === 'AUTHORIZED').toBe(true);
});
it('keeps an inherited OPTIONAL unbound Reply discoverable by its next verified current session', async () => {
  const f = await fixture(true, false); f.bindings.resolveForEnqueueInTransaction.mockResolvedValue(null as any); f.policies.requiresPreselection.mockReturnValue(false);
  await f.edit({ ...f.body, integrationId: null });
  expect(f.db.rows('post')[0]).toMatchObject({ integrationId: null, accountSelectionMode: 'CURRENT_SESSION', accountResolution: 'AWAITING_CURRENT_ACTOR' });
});

it('replays a future controlled Reply edit after its accepted date has passed', async () => {
  const f = await fixture(true, false); const raw = { ...f.body, scheduledAt: new Date(+sendNow + 60000).toISOString() };
  const first = await f.edit(raw); vi.setSystemTime(new Date(+sendNow + 120000));
  expect(await f.edit(raw)).toEqual(JSON.parse(JSON.stringify(first)));
  expect(f.db.rows('post')[0].contentRevision).toBe(2);
});
it('requires fresh verification of a changed Reply account and preserves old actor payload and pacing', async () => {
  const f = await fixture();
  f.db.seed('integration', { ...f.db.rows('integration')[0], id: 'other', internalId: '456' });
  f.db.seed('integrationProject', { id: 'other-relation', organizationId: 'org', projectId: 'project', integrationId: 'other', disabled: false, engageEnabled: true });
  f.bindings.resolveForEnqueueInTransaction.mockResolvedValue({ integrationId: 'other', providerIdentifier: 'x', bindingSource: 'EXPLICIT', bindingRevision: null, canonicalAccountKey: 'other-key', targetAccount: { id: '456', idNamespace: 'x.rest_id', handle: 'other' } });
  const original = structuredClone(f.db.rows('sendExecution')[0]);
  await f.edit({ ...f.body, integrationId: 'other' });
  expect((await f.executions.claim(auth, { requestId: 'wrong-actor', action: 'REPLY', rootPostId: 'root', authorizationMode: 'NATIVE_FLOW_V1' })).items).toEqual([]);
  Object.assign(f.db.rows('extensionNodeSession')[0], { integrationId: 'other', accountIdentity: { id: '456', namespace: 'x.rest_id' } });
  const account = f.db.rows('accountWriteState').find(row => row.canonicalAccountKey === 'other-key');
  account.nextWriteNotBefore = new Date(+sendNow + 60000);
  expect((await f.executions.claim(auth, { requestId: 'paced-actor', action: 'REPLY', rootPostId: 'root', authorizationMode: 'NATIVE_FLOW_V1' })).items).toEqual([]);
  vi.setSystemTime(new Date(+sendNow + 60001));
  const next = (await f.executions.claim(auth, { requestId: 'verified-actor', action: 'REPLY', rootPostId: 'root', authorizationMode: 'NATIVE_FLOW_V1' })).items[0];
  expect(next).toMatchObject({ integrationId: 'other', targetAccount: { id: '456' }, segments: [{ id: 'root', content: 'edited reply' }] });
  expect(f.db.rows('sendExecution')[0]).toMatchObject({ id: original.id, target: original.target, payload: original.payload, status: 'CANCELLED' });
});
it('retains a late old Reply uncertainty receipt and freezes the edited original instead of replaying it', async () => {
  const f = await fixture(); await f.edit();
  await expect(f.executions.outcome(auth, f.item.executionId, 0, f.item.leaseToken, { eventId: 'late-old', status: 'unknown' })).rejects.toThrow();
  expect(f.db.rows('sendIntent')[0].status).toBe('RECONCILING');
  expect((await f.service.businessSummary('org', 'user', 'root')).allowedActions.edit.allowed).toBe(false);
});

it('preserves inherited Reply account provenance when no account change was requested', async () => {
  const f = await fixture(true, false); Object.assign(f.post, { accountSelectionMode: 'INHERIT', bindingSource: 'PROJECT', bindingSourceRevision: 7 });
  await f.edit();
  expect(f.db.rows('post')[0]).toMatchObject({ accountSelectionMode: 'INHERIT', bindingSource: 'PROJECT', bindingSourceRevision: 7 });
});

it.each(['AUTONOMOUS', 'PAUSED', 'membership'])('refuses controlled Reply edit after %s without changing original content or revisions', async restriction => {
  const f = await fixture();
  if (restriction === 'AUTONOMOUS') f.db.rows('settings')[0].value = { mode: 'AUTONOMOUS', revision: 2 };
  if (restriction === 'PAUSED') vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
  if (restriction === 'membership') f.db.rows('userOrganization')[0].disabled = true;
  const original = structuredClone(f.db.rows('post')[0]);
  await expect(f.edit()).rejects.toThrow();
  expect(f.db.rows('post')[0]).toEqual(original);
  expect(f.db.rows('sendExecution')[0].status).toBe('RESERVED');
});

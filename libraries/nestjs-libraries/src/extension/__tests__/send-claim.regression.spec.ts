import { withPublishNowRequestedAt } from '../send-dispatch';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { setupSend, sendNow } from './support/send-fixture';
import { SendExecutionService } from '../send-execution.service';
import { confirmSendPreflight } from '../send-preflight';

const auth = { org: 'org', user: 'user', nodeId: 'node', token: 'token' };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(sendNow);
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
  vi.stubEnv('SEND_EXECUTION_CREDENTIAL_KEY', 'review-key-at-least-thirty-two-characters');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

function fixture() {
  const f = setupSend();
  f.db.seed('extensionNode', {
    id: 'node', nodeId: 'node', organizationId: 'org', credentialVersion: 1,
    capabilities: { x: { post: true, reply: true, strictAccountVerification: true } },
  });
  f.db.seed('extensionNodeSession', {
    extensionNodeId: 'node', organizationId: 'org', platform: 'x',
    integrationId: 'account', verificationStatus: 'VERIFIED',
    verificationExpiresAt: new Date(sendNow.getTime() + 300_000), sessionRevision: 1,
    probeId: 'old', accountIdentity: { id: '123', namespace: 'x.rest_id' },
  });
  const nodes = { authenticateIn: vi.fn(async (_tx, org, user, nodeId) => {
    if (org !== 'org' || user !== 'user') throw new ForbiddenException('NODE_AUTHENTICATION_REQUIRED');
    return f.db.rows('extensionNode').find((n) => n.nodeId === nodeId);
  }) };
  const executions = new SendExecutionService(f.db as any, nodes as any, f.service);
  let sequence = 0;
  const claim = (requestId = `poll-${++sequence}`, rootPostId?: string) =>
    executions.claim(auth, { requestId, action: 'POST', ...(rootPostId ? { rootPostId } : {}) });
  const proof = async (item: any, index = 0) => {
    const challenge = await executions.preflight(auth, item.executionId, index, item.leaseToken);
    const session = f.db.rows('extensionNodeSession')[0];
    const previous = session.probeId;
    session.probeId = `probe-${++sequence}`;
    await f.db.$transaction((tx: any) => confirmSendPreflight(tx, f.db.rows('extensionNode')[0], {
      platform: 'x', id: '123', identityNamespace: 'x.rest_id', loggedIn: true,
      evidenceKind: 'LIVE_COOKIE_ID', probeId: session.probeId,
      identityObservedAt: new Date().toISOString(), preflightChallenge: challenge.challenge,
    }, session, previous, new Date()));
    return challenge;
  };
  return { ...f, executions, claim, proof };
}

it.each(['account', 'relation', 'owner', 'session-actor'])('does not reserve after claim authorization is lost: %s', async (kind) => {
  const f = fixture(); await f.create();
  if (kind === 'account') f.db.rows('integration')[0].disabled = true;
  if (kind === 'relation') f.db.rows('integrationProject')[0].disabled = true;
  if (kind === 'owner') f.db.rows('userOrganization')[0].disabled = true;
  if (kind === 'session-actor') f.db.rows('extensionNodeSession')[0].accountIdentity.id = '999';
  expect((await f.claim()).items).toEqual([]);
  expect(f.db.rows('sendExecution')).toHaveLength(0);
  expect(f.db.rows('sendQuotaReservation')).toHaveLength(0);
});

it('does not reserve a task whose persisted project fails authorization', async () => {
  const f = fixture(); await f.create();
  f.projects.assertProjectActive.mockRejectedValue(new ForbiddenException('PROJECT_INACTIVE'));
  expect((await f.claim()).items).toEqual([]);
  expect(f.db.rows('sendExecution')).toHaveLength(0);
});

it('fails closed for new claims and permits while policy cannot be verified, allowing outcome settlement', async () => {
  const f = fixture(); await f.create();
  const item = (await f.claim()).items[0]; await f.proof(item);
  f.policies.getSystem.mockRejectedValue(new Error('SEND_POLICY_INVALID'));
  await expect(f.claim()).rejects.toThrow('SEND_POLICY_INVALID');
  await expect(f.executions.start(auth, item.executionId, 0, item.leaseToken)).rejects.toThrow('SEND_POLICY_INVALID');
  expect(f.db.rows('sendQuotaReservation')).toHaveLength(0);
  f.policies.getSystem.mockResolvedValue({ mode: 'REQUIRED', revision: 0, lastRequiredRevision: 0 });
  await f.executions.start(auth, item.executionId, 0, item.leaseToken);
  f.policies.getSystem.mockRejectedValue(new Error('SEND_POLICY_INVALID'));
  await f.executions.outcome(auth, item.executionId, 0, item.leaseToken, { status: 'unknown', eventId: 'unknown' });
  expect(f.db.rows('sendQuotaReservation')[0].state).toBe('HELD');
});

it('replays a live preflight challenge without clearing its verified evidence', async () => {
  const f = fixture(); await f.create();
  const item = (await f.claim()).items[0];
  const first = await f.proof(item);
  const again = await f.executions.preflight(auth, item.executionId, 0, item.leaseToken);
  expect(again.challenge).toBe(first.challenge);
  expect(f.db.rows('sendSegment')[0].evidenceSessionRevision).toBe(1);
  const permits = await Promise.all([
    f.executions.start(auth, item.executionId, 0, item.leaseToken),
    f.executions.start(auth, item.executionId, 0, item.leaseToken),
  ]);
  expect(permits.filter((p) => p.granted)).toHaveLength(1);
  expect(f.db.rows('sendQuotaReservation')).toHaveLength(1);
});

it('rotates only expired challenges and never reauthorizes a spent segment', async () => {
  const f = fixture(); await f.create();
  const item = (await f.claim()).items[0];
  const first = await f.proof(item);
  vi.setSystemTime(new Date(sendNow.getTime() + 31_000));
  const next = await f.executions.preflight(auth, item.executionId, 0, item.leaseToken);
  expect(next.challenge).not.toBe(first.challenge);
  expect(f.db.rows('sendSegment')[0].evidenceSessionRevision).toBeNull();
  await f.proof(item);
  await f.executions.start(auth, item.executionId, 0, item.leaseToken);
  await expect(f.executions.preflight(auth, item.executionId, 0, item.leaseToken)).rejects.toThrow('SEGMENT_NOT_PENDING');
});

it('filters unsupported CURRENT_SESSION platforms before the candidate limit', async () => {
  const f = fixture();
  for (let i = 0; i < 26; i++) await f.create(`root-${String(i).padStart(3, '0')}`);
  for (const post of f.db.rows('post').slice(0, 25)) {
    Object.assign(post, { providerIdentifier: 'medium', integrationId: null,
      accountSelectionMode: 'CURRENT_SESSION', accountResolution: 'AWAITING_CURRENT_ACTOR' });
    Object.assign(f.db.rows('sendIntent').find((r) => r.id === post.sendIntentId), {
      platform: 'medium', integrationId: null, canonicalAccountKey: null, target: null,
    });
  }
  expect((await f.claim()).items[0]?.segments[0].id).toBe('root-025');
});

it('continues after the scan budget, replays empty receipts without moving, and wraps to recovered tasks', async () => {
  const f = fixture();
  for (let i = 0; i < 102; i++) await f.create(`root-${String(i).padStart(3, '0')}`);
  for (const post of f.db.rows('post').slice(0, 101)) {
    post.projectId = 'blocked';
    f.db.rows('sendIntent').find((r) => r.id === post.sendIntentId).projectId = 'blocked';
  }
  f.projects.assertProjectActive.mockImplementation(async (_org, project) => {
    if (project === 'blocked') throw new ForbiddenException('PROJECT_INACTIVE');
  });
  expect((await f.claim('empty')).items).toEqual([]);
  const cursor = structuredClone(f.db.rows('sendClaimCursor'));
  expect((await f.claim('empty')).items).toEqual([]);
  expect(f.db.rows('sendClaimCursor')).toEqual(cursor);
  expect((await f.claim('next')).items[0]?.segments[0].id).toBe('root-101');
  f.db.rows('post')[0].projectId = 'project';
  f.db.rows('sendIntent')[0].projectId = 'project';
  expect((await f.claim('wrap')).items[0]?.segments[0].id).toBe('root-000');
});

it('keeps direct claims independent of the polling cursor and deduplicates simultaneous requests', async () => {
  const f = fixture(); await f.create('one'); await f.create('two');
  const results = await Promise.all([f.claim('same', 'two'), f.claim('same', 'two')]);
  expect(results[0].items[0].executionId).toBe(results[1].items[0].executionId);
  expect(f.db.rows('sendExecution')).toHaveLength(1);
  expect(f.db.rows('sendClaimCursor')).toHaveLength(0);
  expect((await f.claim('poll')).items[0]?.segments[0].id).toBe('one');
});

it('records an authenticated removal monotonically without altering committed quota or releasing UNKNOWN', async () => {
  const f = fixture(); await f.create();
  const item = (await f.claim()).items[0]; await f.proof(item);
  await f.executions.start(auth, item.executionId, 0, item.leaseToken);
  const confirmed = { status: 'confirmed' as const, eventId: 'sent', platformId: 'tweet', url: 'https://x.com/alice/status/123' };
  await f.executions.outcome(auth, item.executionId, 0, item.leaseToken, confirmed);
  const buckets = structuredClone(f.db.rows('sendQuotaBucket'));
  const removal = { ...confirmed, eventId: 'removed', removal: 'gone' as const,
    evidence: 'Verified original resource is gone', url: 'https://x.com/other/status/999' };
  await f.executions.outcome(auth, item.executionId, 0, item.leaseToken, removal);
  await f.executions.outcome(auth, item.executionId, 0, item.leaseToken, removal);
  expect(f.db.rows('sendQuotaBucket')).toEqual(buckets);
  expect(f.db.rows('post')[0]).toMatchObject({ state: 'PUBLISHED', releaseURL: confirmed.url, removedReason: 'gone' });
  expect(f.db.rows('sendIntent')[0].status).toBe('SUCCEEDED');
  await expect(f.executions.outcome(auth, item.executionId, 0, item.leaseToken, { ...removal, evidence: 'changed' }))
    .rejects.toThrow('SEND_OUTCOME_EVENT_CONFLICT');
  await expect(f.executions.outcome(auth, item.executionId, 0, item.leaseToken,
    { ...removal, eventId: 'wrong-resource', platformId: 'other' })).rejects.toThrow('CONFIRMED_REMOVAL_EVIDENCE_REQUIRED');
  await expect(f.executions.outcome({ ...auth, user: 'other' }, item.executionId, 0, item.leaseToken, removal))
    .rejects.toThrow('NODE_AUTHENTICATION_REQUIRED');
});

it('does not interpret removal evidence as confirmation or release for an UNKNOWN submission', async () => {
  const f = fixture(); await f.create();
  const item = (await f.claim()).items[0]; await f.proof(item);
  await f.executions.start(auth, item.executionId, 0, item.leaseToken);
  await f.executions.outcome(auth, item.executionId, 0, item.leaseToken, { status: 'unknown', eventId: 'lost' });
  await expect(f.executions.outcome(auth, item.executionId, 0, item.leaseToken, {
    status: 'confirmed', eventId: 'gone', platformId: 'tweet', removal: 'gone', evidence: 'Resource not found',
  })).rejects.toThrow('CONFIRMED_REMOVAL_EVIDENCE_REQUIRED');
  expect(f.db.rows('sendQuotaReservation')[0].state).toBe('HELD');
  expect(f.db.rows('accountWriteState')[0].activeExecutionId).toBe(item.executionId);
  expect((await f.claim()).items).toEqual([]);
});

it('skips malformed candidate media without retaining a partial execution or blocking later content', async () => {
  const f = fixture(); await f.create('bad'); await f.create('good');
  f.db.rows('post')[0].image = '[{}]';
  const item = (await f.claim()).items[0];
  expect(item.segments[0].id).toBe('good');
  expect(f.db.rows('sendExecution')).toHaveLength(1);
  expect(f.db.rows('sendIntent')[0]).toMatchObject({ status: 'QUEUED', activeExecutionId: null });
  expect(f.db.rows('sendQuotaReservation')).toHaveLength(0);
});

it('allows only one execution when two nodes race for the same content', async () => {
  const f = fixture(); await f.create('root');
  f.db.seed('extensionNode', { ...f.db.rows('extensionNode')[0], id: 'second-node', nodeId: 'second-node' });
  f.db.seed('extensionNodeSession', { ...f.db.rows('extensionNodeSession')[0], extensionNodeId: 'second-node' });
  const results = await Promise.all([
    f.claim('first'),
    f.executions.claim({ ...auth, nodeId: 'second-node' }, { requestId: 'second', action: 'POST' }),
  ]);
  expect(results.flatMap(result => result.items)).toHaveLength(1);
  expect(f.db.rows('sendExecution')).toHaveLength(1);
  expect(f.db.rows('sendQuotaReservation')).toHaveLength(0);
});

it('revisits recovered old tasks even while newly created work keeps extending the queue', async () => {
  const f = fixture(); await f.create('old'); await f.create('ready');
  f.db.rows('post')[0].projectId = 'blocked';
  f.db.rows('sendIntent')[0].projectId = 'blocked';
  f.projects.assertProjectActive.mockImplementation(async (_org, project) => {
    if (project === 'blocked') throw new ForbiddenException('PROJECT_INACTIVE');
  });
  expect((await f.claim()).items[0].segments[0].id).toBe('ready');
  vi.setSystemTime(new Date(sendNow.getTime() + 1_000));
  await f.create('newer');
  f.db.rows('post')[2].publishDate = new Date();
  f.db.rows('post')[0].projectId = 'project';
  f.db.rows('sendIntent')[0].projectId = 'project';
  expect((await f.claim()).items[0].segments[0].id).toBe('old');
});

it('starts a fresh cycle immediately after an empty queue receives newly created work', async () => {
  const f = fixture();
  expect((await f.claim('empty')).items).toEqual([]);
  vi.setSystemTime(new Date(sendNow.getTime() + 1_000));
  await f.create('new');
  expect((await f.claim('empty')).items).toEqual([]);
  expect((await f.claim('fresh')).items[0].segments[0].id).toBe('new');
});


it('honors the possible write cooldown after an UNKNOWN report without reopening the old intent or quota', async () => {
  const f = fixture(); await f.create();
  const old = (await f.claim('old-claim')).items[0]; await f.proof(old);
  await f.executions.start(auth, old.executionId, 0, old.leaseToken);
  await f.executions.outcome(auth, old.executionId, 0, old.leaseToken, { status: 'unknown', eventId: 'lost' });
  await f.create('independent');
  expect((await f.claim('fresh-permit')).items).toEqual([]);
  const held = structuredClone(f.db.rows('sendQuotaReservation'));
  vi.setSystemTime(new Date(sendNow.getTime() + 31000));
  expect(await f.claim('expired-permit')).toMatchObject({ items: [], reason: 'ACCOUNT_COOLDOWN_ACTIVE' });
  vi.setSystemTime(new Date(sendNow.getTime() + 90_001));
  const next = (await f.claim('after-cooldown')).items[0];
  expect(next?.segments[0].id).toBe('independent');
  expect(f.db.rows('sendIntent').find(row => row.id === old.sendIntentId)).toMatchObject({ status: 'RECONCILING', activeExecutionId: old.executionId });
  expect(f.db.rows('sendSegment').find(row => row.executionId === old.executionId).status).toBe('UNKNOWN');
  expect(f.db.rows('sendQuotaReservation')).toEqual(held);
  expect(f.db.rows('accountWriteState')[0]).toMatchObject({ activeExecutionId: null, rolloutReady: true });
  await expect(f.service.retry('org', 'root', 'user')).rejects.toThrow();
});


async function replyStatusFixture() {
  const f = fixture(); await f.create();
  const item = (await f.claim()).items[0];
  Object.assign(f.db.rows('sendExecution')[0], { action: 'REPLY', status: 'RECONCILING' });
  Object.assign(f.db.rows('sendIntent')[0], { action: 'REPLY', status: 'RECONCILING' });
  f.db.rows('post')[0].source = 'engage';
  f.db.seed('engageOpportunity', { id: 'opportunity', externalPostUrl: 'https://x.com/noahkagan/status/123' });
  f.db.seed('engageSentReply', { id: 'saved-reply', organizationId: 'org', projectId: 'project', postId: 'root', opportunityId: 'opportunity', createdAt: sendNow });
  return { ...f, item };
}

it.each(['poll', 'direct'])('claims and starts independent work past a settled historical browser reply: %s', async kind => {
  const f = fixture(); await f.create();
  const claimedAt = new Date(sendNow.getTime() - 60_000);
  f.db.seed('post', { id: 'historical-reply', organizationId: 'org', projectId: 'project',
    state: 'QUEUE', executionProtocol: 'LEGACY', source: 'engage', publishMethod: 'EXTENSION',
    providerIdentifier: 'x', parentPostId: null, releaseId: 'old-lease', claimedAt, publishDate: claimedAt });
  f.db.seed('sendMutationReceipt', { id: 'old-unsent', organizationId: 'org', userId: 'previous-browser',
    operation: 'autonomous-side-effect', createdAt: new Date(claimedAt.getTime() + 1_000),
    result: { status: 'NOT_SUBMITTED', revision: 2, source: 'BROWSER', platform: 'x', browserUserId: 'previous-browser',
      integrationId: 'browser:previous-browser:x', action: 'COMMENT', postIds: ['historical-reply'],
      recurring: false, occurrenceKey: 'single' } });
  const item = (await f.claim(`legacy-${kind}`, kind === 'direct' ? 'root' : undefined)).items[0];
  expect(item?.segments[0].id).toBe('root');
  await f.proof(item);
  expect(await f.executions.start(auth, item.executionId, 0, item.leaseToken)).toMatchObject({ granted: true });
  expect(f.db.rows('post').find(row => row.id === 'historical-reply').releaseId).toBe('old-lease');
  expect(f.db.rows('sendIntent').filter(row => row.rootPostId === 'historical-reply')).toEqual([]);
});

it('returns sanitized original reply context for an authenticated historical execution without changing its state', async () => {
  const f = await replyStatusFixture();
  const before = structuredClone(f.db.rows('sendExecution'));
  const status = await f.executions.status(auth, f.item.executionId, f.item.leaseToken);
  expect(status).toMatchObject({ status: 'RECONCILING', reply: {
    sentReplyId: 'saved-reply', opportunityId: 'opportunity', targetUrl: 'https://x.com/noahkagan/status/123', createdAt: sendNow,
  } });
  expect(Object.keys(status.reply!)).toEqual(['sentReplyId', 'opportunityId', 'targetUrl', 'createdAt']);
  expect(status).not.toHaveProperty('leaseToken');
  expect(status).not.toHaveProperty('leaseTokenHash');
  expect(f.db.rows('sendExecution')).toEqual(before);
});

it('leaves ordinary post execution status free of reply context', async () => {
  const f = fixture(); await f.create(); const item = (await f.claim()).items[0];
  expect(await f.executions.status(auth, item.executionId, item.leaseToken)).not.toHaveProperty('reply');
});

it.each(['reply-organization', 'reply-project', 'post-project', 'root-binding'])('does not expose reply context across a mismatched scope: %s', async kind => {
  const f = await replyStatusFixture();
  if (kind === 'reply-organization') f.db.rows('engageSentReply')[0].organizationId = 'other';
  if (kind === 'reply-project') f.db.rows('engageSentReply')[0].projectId = 'other';
  if (kind === 'post-project') f.db.rows('post')[0].projectId = 'other';
  if (kind === 'root-binding') f.db.rows('post')[0].sendIntentId = 'other';
  await expect(f.executions.status(auth, f.item.executionId, f.item.leaseToken)).rejects.toThrow('SEND_REPLY_SCOPE_MISMATCH');
});

it('requires the original lease before returning reply context', async () => {
  const f = await replyStatusFixture();
  await expect(f.executions.status(auth, f.item.executionId, 'wrong-lease')).rejects.toThrow('SEND_LEASE_AUTHENTICATION_FAILED');
});

it('claims an unrelated post after a reply lease and its unreported permit have expired', async () => {
  const f = fixture();
  await f.create('old');
  await f.create('next');
  const old = (await f.claim('old-claim', 'old')).items[0];
  await f.proof(old);
  await f.executions.start(auth, old.executionId, 0, old.leaseToken);
  f.db.rows('sendExecution')[0].action = 'REPLY';
  f.db.rows('sendIntent').find(intent => intent.rootPostId === 'old').action = 'REPLY';

  vi.setSystemTime(new Date(sendNow.getTime() + 121_000));
  expect((await f.claim('next-claim', 'next')).items[0]?.segments[0].id).toBe('next');
  expect(f.db.rows('sendExecution').find(execution => execution.id === old.executionId).status).toBe('RECONCILING');
  expect(f.db.rows('sendIntent').find(intent => intent.rootPostId === 'old')).toMatchObject({
    status: 'RECONCILING', activeExecutionId: old.executionId,
  });
  expect(f.db.rows('sendSegment').find(segment => segment.executionId === old.executionId).status).toBe('UNKNOWN');
  expect(f.db.rows('sendQuotaReservation')[0].state).toBe('HELD');
  expect(f.db.rows('post').find(post => post.id === 'old').state).toBe('QUEUE');

  await f.executions.outcome(auth, old.executionId, 0, old.leaseToken, {
    eventId: 'late-confirmation', status: 'confirmed', platformId: 'old-reply',
  });
  expect(f.db.rows('post').find(post => post.id === 'old').state).toBe('PUBLISHED');
});

it.each(['lease', 'permit'])('keeps the account writer while its %s is still valid', async live => {
  const f = fixture();
  await f.create('old');
  await f.create('next');
  const old = (await f.claim('old-claim', 'old')).items[0];
  await f.proof(old);
  await f.executions.start(auth, old.executionId, 0, old.leaseToken);
  if (live === 'permit') f.db.rows('sendExecution')[0].leaseExpiresAt = new Date(sendNow.getTime() + 10_000);
  vi.setSystemTime(new Date(sendNow.getTime() + (live === 'lease' ? 40_000 : 20_000)));
  expect(await f.claim('next-claim', 'next')).toMatchObject({ items: [], reason: 'ACCOUNT_EXECUTION_ACTIVE' });
  expect(f.db.rows('accountWriteState')[0].activeExecutionId).toBe(old.executionId);
  expect(f.db.rows('sendSegment')[0].status).toBe('AUTHORIZED');
});

it('preserves the possible write cooldown after recovering an unreported expired permit', async () => {
  const f = fixture();
  await f.create('old');
  await f.create('next');
  const old = (await f.claim('old-claim', 'old')).items[0];
  await f.proof(old);
  const plan = await f.quotas.resolve(f.db as any, f.db.rows('sendIntent')[0], f.db.rows('accountWriteState')[0], 0, sendNow);
  f.quotas.resolve.mockResolvedValue({ ...plan, gapMs: 180_000 });
  const permit = await f.executions.start(auth, old.executionId, 0, old.leaseToken);
  if (!permit.granted) throw new Error('Expected a send permit');
  vi.setSystemTime(new Date(sendNow.getTime() + 121_000));
  expect(await f.claim('next-claim', 'next')).toMatchObject({ items: [], reason: 'ACCOUNT_COOLDOWN_ACTIVE' });
  expect(f.db.rows('accountWriteState')[0]).toMatchObject({ activeExecutionId: null,
    nextWriteNotBefore: new Date(Date.parse(permit.submitBefore) + 180_000) });
  expect(f.db.rows('sendQuotaReservation')[0].state).toBe('HELD');
});

it('sweeps an expired authorization with no new task to claim', async () => {
  const f = fixture(); await f.create('old');
  const old = (await f.claim('old', 'old')).items[0];
  await f.proof(old);
  await f.executions.start(auth, old.executionId, 0, old.leaseToken);
  vi.setSystemTime(new Date(sendNow.getTime() + 180_000));
  await f.service.recoverExpiredAccountWriters();
  expect(f.db.rows('accountWriteState')[0].activeExecutionId).toBeNull();
  expect(f.db.rows('sendExecution')[0].status).toBe('RECONCILING');
  expect(f.db.rows('sendQuotaReservation')[0].state).toBe('HELD');
});

it('reviews an expired authorized reply on direct retry without a competing task', async () => {
  const f = fixture(); await f.create('old');
  const old = (await f.claim('old', 'old')).items[0];
  await f.proof(old);
  await f.executions.start(auth, old.executionId, 0, old.leaseToken);
  f.db.rows('sendExecution')[0].action = 'REPLY';
  f.db.rows('sendIntent')[0].action = 'REPLY';
  f.db.seed('engageSentReply', { id: 'reply', organizationId: 'org', projectId: 'project', postId: 'old' });
  vi.setSystemTime(new Date(sendNow.getTime() + 180_000));
  expect(await f.service.retryUnconfirmedReply('org', 'user', old.executionId, 'reply', {
    requestId: 'review', expectedResolutionRevision: 0,
  })).toMatchObject({ status: 'review-required' });
  expect(await f.service.retryUnconfirmedReply('org', 'user', old.executionId, 'reply', {
    requestId: 'confirmed-review', expectedResolutionRevision: 0, confirmDuplicateRisk: true,
  })).toEqual({ status: 'requeued' });
});

it.each(['POST', 'REPLY'] as const)('keeps the possible write cooldown when directly retrying an UNKNOWN %s', async action => {
  const f = fixture(); await f.create('old'); await f.create('next');
  const old = (await f.claim('old', 'old')).items[0];
  const plan = await f.quotas.resolve(f.db as any, f.db.rows('sendIntent')[0], f.db.rows('accountWriteState')[0], 0, sendNow);
  f.quotas.resolve.mockResolvedValue({ ...plan, gapMs: 180_000 });
  await f.proof(old);
  const permit = await f.executions.start(auth, old.executionId, 0, old.leaseToken);
  if (!permit.granted) throw new Error('Expected a send permit');
  if (action === 'REPLY') {
    f.db.rows('sendExecution')[0].action = action;
    f.db.rows('sendIntent')[0].action = action;
    f.db.seed('engageSentReply', { id: 'reply', organizationId: 'org', projectId: 'project', postId: 'old' });
  }
  await f.executions.outcome(auth, old.executionId, 0, old.leaseToken, { eventId: 'lost', status: 'unknown' });
  vi.setSystemTime(new Date(sendNow.getTime() + 121_000));
  const request = { requestId: 'manual-retry', expectedResolutionRevision: 0 };
  const result = action === 'REPLY'
    ? await f.service.retryUnconfirmedReply('org', 'user', old.executionId, 'reply', { ...request, confirmDuplicateRisk: true })
    : await f.service.retryUnconfirmedPost('org', 'user', old.executionId, 'old', request);
  expect(result.status).toBe(action === 'REPLY' ? 'requeued' : 'QUEUED');
  expect(f.db.rows('accountWriteState')[0]).toMatchObject({ activeExecutionId: null,
    nextWriteNotBefore: new Date(Date.parse(permit.submitBefore) + 180_000) });
  expect(await f.claim('next', 'next')).toMatchObject({ items: [], reason: 'ACCOUNT_COOLDOWN_ACTIVE' });
});

it('releases a partial thread after the preparation cap while preserving its confirmed segment', async () => {
  const f = fixture(); await f.create('old'); await f.create('next');
  const root = f.db.rows('post').find(post => post.id === 'old');
  f.db.seed('post', { ...root, id: 'child', parentPostId: 'old' });
  const old = (await f.claim('old', 'old')).items[0];
  await f.proof(old);
  await f.executions.start(auth, old.executionId, 0, old.leaseToken);
  await f.executions.outcome(auth, old.executionId, 0, old.leaseToken, {
    eventId: 'first-confirmed', status: 'confirmed', platformId: 'first-segment',
  });
  vi.setSystemTime(new Date(sendNow.getTime() + 1_800_001));
  f.db.rows('extensionNodeSession')[0].verificationExpiresAt = new Date(Date.now() + 60_000);
  expect((await f.claim('next', 'next')).items[0]?.segments[0].id).toBe('next');
  expect(f.db.rows('sendIntent').find(intent => intent.rootPostId === 'old')).toMatchObject({
    status: 'RECONCILING', hasConfirmedSegments: true,
  });
  expect(f.db.rows('sendSegment').slice(0, 2).map(segment => segment.status)).toEqual(['CONFIRMED', 'PENDING']);
  await expect(f.executions.renew(auth, old.executionId, old.leaseToken)).rejects.toThrow('SEND_LEASE_NOT_RENEWABLE');
});

it('does not authorize the next segment when the old node is first to recover its expired partial thread', async () => {
  const f = fixture(); await f.create('old'); await f.create('next');
  const root = f.db.rows('post').find(post => post.id === 'old');
  f.db.seed('post', { ...root, id: 'child', parentPostId: 'old' });
  const old = (await f.claim('old', 'old')).items[0];
  await f.proof(old);
  await f.executions.start(auth, old.executionId, 0, old.leaseToken);
  await f.executions.outcome(auth, old.executionId, 0, old.leaseToken, {
    eventId: 'first-confirmed', status: 'confirmed', platformId: 'first-segment',
  });
  vi.setSystemTime(new Date(sendNow.getTime() + 1_800_001));
  f.db.rows('extensionNodeSession')[0].verificationExpiresAt = new Date(Date.now() + 60_000);
  await f.proof(old, 1);
  f.quotas.resolve.mockResolvedValueOnce({ gapMs: 60_000, budgets: [] });
  await expect(f.executions.start(auth, old.executionId, 1, old.leaseToken))
    .resolves.toMatchObject({ granted: false, status: 'RECONCILING' });
  expect(f.db.rows('sendQuotaReservation')).toHaveLength(1);
  expect(f.db.rows('sendIntent').find(intent => intent.rootPostId === 'old')).toMatchObject({
    status: 'RECONCILING', hasConfirmedSegments: true,
  });
  expect(f.db.rows('sendSegment').slice(0, 2).map(segment => segment.status)).toEqual(['CONFIRMED', 'PENDING']);
  expect((await f.claim('next', 'next')).items[0]?.segments[0].id).toBe('next');
});

it('skips a numeric media ID and claims the next post without passing invalid input to Prisma', async () => {
  const f = fixture(); await f.create('a-malformed'); await f.create('z-healthy');
  f.db.rows('post')[0].image = '[{"id":123}]';
  const findMedia = vi.fn().mockRejectedValue(new TypeError('Media.id must be a string'));
  f.db.media = { findFirst: findMedia };
  expect((await f.claim()).items[0]?.segments[0].id).toBe('z-healthy');
  expect(findMedia).not.toHaveBeenCalled();
});

it('returns a retryable claim conflict instead of a raw transaction error', async () => {
  const f = fixture(); await f.create();
  const tx = vi.spyOn(f.db, '$transaction').mockRejectedValue(Object.assign(new Error('Write conflict'), { code: 'P2034' }));
  const claim = f.claim();
  await Promise.all([
    expect(claim).rejects.toMatchObject({ status: 409, response: { code: 'CLAIM_BUSY' } }),
    vi.advanceTimersByTimeAsync(1000),
  ]);
  expect(tx).toHaveBeenCalledTimes(4);
});

it('keeps the longer account cooldown when an older confirmation arrives late', async () => {
  const f = fixture(); await f.create('old');
  const old = (await f.claim('old', 'old')).items[0];
  await f.proof(old);
  await f.executions.start(auth, old.executionId, 0, old.leaseToken);
  const deadline = new Date(sendNow.getTime() + 30 * 60_000);
  f.db.rows('accountWriteState')[0].nextWriteNotBefore = deadline;
  await f.executions.outcome(auth, old.executionId, 0, old.leaseToken, {
    eventId: 'late', status: 'confirmed', platformId: 'posted',
  });
  expect(f.db.rows('accountWriteState')[0].nextWriteNotBefore).toEqual(deadline);
});

it('identifies an expired X draft and lets a superadmin record verified publication without resending', async () => {
  const f = fixture(); await f.create('old'); await f.create('next');
  const old = (await f.claim('old', 'old')).items[0];
  await f.executions.draftExposure(auth, old.executionId, 0, old.leaseToken);
  const publication = {
    status: 'confirmed' as const, eventId: 'verified', platformId: '321', url: 'https://x.com/alice/status/321', verifiedAccountId: '123',
    evidence: 'Checked the original platform publication against the stored account and content.',
  };
  await expect(f.service.reconcile('org', 'user', old.executionId, 0, 0, publication))
    .rejects.toThrow('SEND_RECONCILIATION_PERMISSION_REQUIRED');
  f.db.seed('user', { id: 'user', isSuperAdmin: true });
  await expect(f.service.reconcile('org', 'user', old.executionId, 0, 0, publication))
    .rejects.toThrow('SEND_X_DRAFT_REVIEW_NOT_SETTLED');
  vi.setSystemTime(new Date(sendNow.getTime() + 180_000));
  expect((await f.service.businessSummary('org', 'user', 'next')).timing).toMatchObject({
    reason: 'ACCOUNT_REVIEW_REQUIRED', blockingExecutionId: old.executionId,
  });
  expect(f.db.rows('accountWriteState')[0].activeExecutionId).toBe(old.executionId);
  await expect(f.service.reconcile('org', 'user', old.executionId, 0, 0, {
    ...publication, url: 'https://x.com/bob/status/999',
  })).rejects.toThrow('INVALID_X_DRAFT_PUBLICATION_RECEIPT');
  const plan = await f.quotas.resolve(f.db as any, f.db.rows('sendIntent')[0], f.db.rows('accountWriteState')[0], 0, new Date());
  f.quotas.resolve.mockResolvedValue({ ...plan, budgets: plan.budgets.map(budget => ({ ...budget, limit: 0 })) });
  await expect(f.service.reconcile('org', 'user', old.executionId, 0, 0, publication))
    .resolves.toMatchObject({ status: 'confirmed' });
  await expect(f.service.reconcile('org', 'user', old.executionId, 0, 0, publication))
    .resolves.toMatchObject({ status: 'confirmed' });
  expect(f.db.rows('accountWriteState')[0]).toMatchObject({
    activeExecutionId: null, nextWriteNotBefore: new Date(Date.now() + plan.gapMs),
  });
  expect(f.db.rows('sendQuotaBucket')[0]).toMatchObject({ confirmedUnits: 1, heldUnits: 0 });
  expect(f.db.rows('sendQuotaReservation')).toHaveLength(1);
  expect(f.db.rows('sendQuotaReservation')[0].state).toBe('COMMITTED');
  expect(f.db.rows('post').find(post => post.id === 'old').state).toBe('PUBLISHED');
});

it.each(['alice', null])('verifies a renamed X account using the administrator-checked stable ID (saved handle: %s)', async handle => {
  const f = fixture(); await f.create('old');
  const old = (await f.claim('old', 'old')).items[0];
  f.db.rows('sendExecution')[0].target.handle = handle;
  await f.executions.draftExposure(auth, old.executionId, 0, old.leaseToken);
  f.db.seed('user', { id: 'user', isSuperAdmin: true });
  vi.setSystemTime(new Date(sendNow.getTime() + 180_000));
  const publication = {
    status: 'confirmed' as const, eventId: 'verified-renamed', platformId: '321', url: 'https://x.com/new_name/status/321',
    evidence: 'Verified the author ID and the exact draft publication on X.',
  };
  await expect(f.service.reconcile('org', 'user', old.executionId, 0, 0, {
    ...publication, verifiedAccountId: '999',
  })).rejects.toThrow('INVALID_X_DRAFT_PUBLICATION_RECEIPT');
  await expect(f.service.reconcile('org', 'user', old.executionId, 0, 0, {
    ...publication, verifiedAccountId: '123',
  })).resolves.toMatchObject({ status: 'confirmed' });
});

it('settles an expired exposed X draft already in reconciliation only after a verified stop', async () => {
  const f = fixture(); await f.create('old');
  const old = (await f.claim('old', 'old')).items[0];
  await f.executions.draftExposure(auth, old.executionId, 0, old.leaseToken);
  f.db.rows('sendExecution')[0].status = 'RECONCILING';
  f.db.rows('sendIntent')[0].status = 'RECONCILING';
  f.db.seed('user', { id: 'user', isSuperAdmin: true });
  vi.setSystemTime(new Date(sendNow.getTime() + 180_000));
  const absent = {
    status: 'definitely_not_submitted' as const, eventId: 'verified-stop',
    evidence: 'Checked the target and closed the original browser draft.',
  };
  await expect(f.service.reconcile('org', 'user', old.executionId, 0, 0, absent))
    .rejects.toThrow('STOP_CONFIRMATION_REQUIRED');
  expect(f.db.rows('accountWriteState')[0].activeExecutionId).toBe(old.executionId);
  await expect(f.service.reconcile('org', 'user', old.executionId, 0, 0, { ...absent, stopped: true }))
    .resolves.toMatchObject({ status: 'definitely_not_submitted' });
  expect(f.db.rows('accountWriteState')[0].activeExecutionId).toBeNull();
  expect(f.db.rows('sendSegment')[0].status).toBe('NOT_SUBMITTED');
});


it('accounts for a no-permit X publication confirmed by the original browser node', async () => {
  const f = fixture(); await f.create('old');
  const old = (await f.claim('old', 'old')).items[0];
  await f.executions.draftExposure(auth, old.executionId, 0, old.leaseToken);
  await f.executions.outcome(auth, old.executionId, 0, old.leaseToken, { status: 'unknown', eventId: 'exposed-unknown' });
  const confirmation = { status: 'confirmed' as const, eventId: 'browser-found', platformId: '321', url: 'https://x.com/alice/status/321' };
  await f.executions.outcome(auth, old.executionId, 0, old.leaseToken, confirmation);
  await f.executions.outcome(auth, old.executionId, 0, old.leaseToken, confirmation);
  expect(f.db.rows('sendQuotaReservation')).toHaveLength(1);
  expect(f.db.rows('sendQuotaReservation')[0].state).toBe('COMMITTED');
  expect(f.db.rows('sendQuotaBucket')[0]).toMatchObject({ confirmedUnits: 1, heldUnits: 0 });
  expect(f.db.rows('accountWriteState')[0].nextWriteNotBefore).toEqual(new Date(sendNow.getTime() + 60_000));
});

it('accounts for a superseded no-permit X receipt while quarantining the retry', async () => {
  const f = fixture(); await f.create('old');
  const old = (await f.claim('old', 'old')).items[0];
  await f.executions.draftExposure(auth, old.executionId, 0, old.leaseToken);
  await f.executions.outcome(auth, old.executionId, 0, old.leaseToken, { status: 'unknown', eventId: 'unknown' });
  vi.setSystemTime(new Date(sendNow.getTime() + 180_000));
  await f.service.retryUnconfirmedPost('org', 'user', old.executionId, 'old', { requestId: 'retry', expectedResolutionRevision: 0 });
  await expect(f.executions.outcome(auth, old.executionId, 0, old.leaseToken, {
    status: 'confirmed', eventId: 'late-found', platformId: '321', url: 'https://x.com/alice/status/321',
  })).rejects.toThrow('SEND_OUTCOME_CONFLICT_REQUIRES_RECONCILIATION');
  expect(f.db.rows('sendQuotaReservation')).toHaveLength(1);
  expect(f.db.rows('sendQuotaReservation')[0].state).toBe('COMMITTED');
  expect(f.db.rows('accountWriteState')[0]).toMatchObject({ rolloutReady: false, nextWriteNotBefore: new Date(Date.now() + 60_000) });
});

it('requires stable author identity for an administrator to confirm an unpermitted X publication', async () => {
  const f = fixture(); await f.create('old'); const old = (await f.claim('old', 'old')).items[0];
  await f.executions.draftExposure(auth, old.executionId, 0, old.leaseToken);
  f.db.seed('user', { id: 'user', isSuperAdmin: true });
  vi.setSystemTime(new Date(sendNow.getTime() + 180_000));
  await expect(f.service.reconcile('org', 'user', old.executionId, 0, 0, {
    status: 'confirmed', eventId: 'handle-only', platformId: '321', url: 'https://x.com/alice/status/321',
    evidence: 'Checked the URL with the saved handle, without stable author ID.',
  })).rejects.toThrow('INVALID_X_DRAFT_PUBLICATION_RECEIPT');
  expect(f.db.rows('sendQuotaReservation')).toHaveLength(0);
  expect(f.db.rows('sendSegment')[0].status).toBe('PENDING');
});
it.each(['UNKNOWN'])('requires duplicate-risk acknowledgement before retrying an exposed no-permit X reply (%s)', async status => {
  const f = fixture(); await f.create('old'); const old = (await f.claim('old', 'old')).items[0];
  f.db.rows('sendExecution')[0].action = 'REPLY'; f.db.rows('sendIntent')[0].action = 'REPLY';
  f.db.rows('post')[0].source = 'engage';
  f.db.seed('engageSentReply', { id: 'reply', organizationId: 'org', projectId: 'project', postId: 'old' });
  await f.executions.draftExposure(auth, old.executionId, 0, old.leaseToken);
  if (status === 'UNKNOWN') await f.executions.outcome(auth, old.executionId, 0, old.leaseToken, { status: 'unknown', eventId: 'exposed-unknown' });
  vi.setSystemTime(new Date(sendNow.getTime() + 180_000));
  const request = { requestId: 'risk-review', expectedResolutionRevision: 0 };
  expect(await f.service.retryUnconfirmedReply('org', 'user', old.executionId, 'reply', request)).toMatchObject({ status: 'review-required' });
  expect(f.db.rows('sendIntent')[0].activeExecutionId).toBe(old.executionId);
  expect(await f.service.retryUnconfirmedReply('org', 'user', old.executionId, 'reply', { ...request, confirmDuplicateRisk: true })).toMatchObject({ status: 'requeued' });
});

it('commits a late no-permit receipt after an attended absence review', async () => {
  const f = fixture(); await f.create('old'); const old = (await f.claim('old', 'old')).items[0];
  await f.executions.draftExposure(auth, old.executionId, 0, old.leaseToken);
  await f.executions.outcome(auth, old.executionId, 0, old.leaseToken, { status: 'unknown', eventId: 'unknown' });
  vi.setSystemTime(new Date(sendNow.getTime() + 180_000));
  await f.service.reviewPostNotSent('org', 'user', old.executionId, 'old', { eventId: 'review', expectedResolutionRevision: 0, reviewedNotSent: true, draftsClosed: true });
  await expect(f.executions.outcome(auth, old.executionId, 0, old.leaseToken, { status: 'confirmed', eventId: 'late-found', platformId: '321', url: 'https://x.com/alice/status/321' }))
    .rejects.toThrow('SEND_OUTCOME_CONFLICT_REQUIRES_RECONCILIATION');
  expect(f.db.rows('sendQuotaReservation')[0].state).toBe('COMMITTED');
  expect(f.db.rows('sendQuotaBucket')[0]).toMatchObject({ confirmedUnits: 1, heldUnits: 0 });
});

it('claims explicit Post now before older ordinary work and keeps urgent requests FIFO', async () => {
 const f = fixture();
 await f.create('ordinary'); await f.create('urgent-later'); await f.create('urgent-first');
 f.db.rows('post')[1].sendTarget=withPublishNowRequestedAt(f.db.rows('post')[1].sendTarget,sendNow);
 f.db.rows('post')[2].sendTarget=withPublishNowRequestedAt(f.db.rows('post')[2].sendTarget,new Date(sendNow.getTime()-1));
 expect((await f.claim()).items[0]?.segments[0].id).toBe('urgent-first');
 f.db.rows('accountWriteState')[0].activeExecutionId = null;
 expect((await f.claim()).items[0]?.segments[0].id).toBe('urgent-later');
});
it('discovers newly prioritized work before continuing an ordinary cursor', async () => {
 const f = fixture(); await f.create('first'); await f.create('later'); await f.create('urgent');
 expect((await f.claim()).items[0]?.segments[0].id).toBe('first');
 vi.setSystemTime(new Date(sendNow.getTime()+1000));
 await f.service.rescheduleQueuedPost('org','urgent','user',new Date(),0,1,true);
 f.db.rows('accountWriteState')[0].activeExecutionId = null;
 expect((await f.claim()).items[0]?.segments[0].id).toBe('urgent');
});
it('continues to eligible ordinary work after a full scan of blocked urgent work', async () => {
 const f = fixture();
 for(let i=0;i<101;i++) {
  await f.create(`urgent-${String(i).padStart(3,'0')}`);
  Object.assign(f.db.rows('post')[i],{sendTarget:withPublishNowRequestedAt(f.db.rows('post')[i].sendTarget,sendNow),projectId:'blocked'});
 }
 await f.create('ordinary');
 f.projects.assertProjectActive.mockImplementation(async (_org, project) => {
  if(project==='blocked') throw new ForbiddenException('PROJECT_INACTIVE');
 });
 expect((await f.claim()).items[0]?.segments[0].id).toBe('ordinary');
});

it('keeps priority receipts idempotent and recovers an expired lease without duplicating its intent', async () => {
 const f=fixture(); await f.create('urgent');
 f.db.rows('post')[0].sendTarget=withPublishNowRequestedAt(f.db.rows('post')[0].sendTarget,sendNow);
 const first=(await f.claim('first')).items[0];
 expect((await f.claim('first')).items[0]?.executionId).toBe(first.executionId);
 expect((await f.claim('active')).items).toEqual([]);
 vi.setSystemTime(new Date(sendNow.getTime()+120001));
 expect(await f.claim('first')).toMatchObject({items:[],reason:'REPLAYED_EXECUTION_UNAVAILABLE'});
 const next=(await f.claim('replacement')).items[0];
 expect(next.executionId).not.toBe(first.executionId);
 expect(f.db.rows('sendIntent')).toHaveLength(1);
 expect(f.db.rows('sendExecution')[0].status).toBe('EXPIRED');
 expect(f.db.rows('sendQuotaReservation')).toHaveLength(0);
});
it('keeps targeted claims independent of the priority lane', async () => {
 const f=fixture(); await f.create('ordinary'); await f.create('urgent');
 f.db.rows('post')[1].sendTarget=withPublishNowRequestedAt(f.db.rows('post')[1].sendTarget,sendNow);
 expect((await f.claim('targeted','ordinary')).items[0]?.segments[0].id).toBe('ordinary');
 expect(f.db.rows('sendClaimCursor')).toHaveLength(0);
});
it('keeps REPLY discovery ordered by its original schedule even with a priority marker', async () => {
 const f=fixture(); await f.create('first'); await f.create('second');
 for(const row of f.db.rows('sendIntent')) row.action='REPLY';
 for(const row of f.db.rows('post')) row.settings=JSON.stringify({post:{replyToTweetId:'42'}});
 f.db.rows('post')[1].sendTarget=withPublishNowRequestedAt(f.db.rows('post')[1].sendTarget,sendNow);
 const result=await f.executions.claim(auth,{requestId:'reply',action:'REPLY'});
 expect(result.items[0]?.segments[0].id).toBe('first');
 expect(f.db.rows('sendClaimCursor').map(row=>row.action)).toEqual(['REPLY']);
});
it('continues past a rate-limited urgent platform to eligible urgent work on another platform', async () => {
 const f=fixture(); await f.create('blocked-x'); await f.create('linkedin');
 for(const row of f.db.rows('post')) row.sendTarget=withPublishNowRequestedAt(row.sendTarget,sendNow);
 const post=f.db.rows('post')[1],intent=f.db.rows('sendIntent')[1];
 Object.assign(post,{providerIdentifier:'linkedin',integrationId:'linkedin-account'});
 Object.assign(intent,{platform:'linkedin',integrationId:'linkedin-account',canonicalAccountKey:'linkedin-key',target:{id:'member',idNamespace:'linkedin.member_id'}});
 f.db.seed('integration',{...f.db.rows('integration')[0],id:'linkedin-account',providerIdentifier:'linkedin',internalId:'member',identityNamespace:'linkedin.member_id'});
 f.db.seed('integrationProject',{organizationId:'org',projectId:'project',integrationId:'linkedin-account',disabled:false});
 f.db.seed('accountWriteState',{organizationId:'org',integrationId:'linkedin-account',canonicalAccountKey:'linkedin-key',rolloutReady:true});
 f.db.seed('extensionNodeSession',{...f.db.rows('extensionNodeSession')[0],id:'linkedin-session',platform:'linkedin',integrationId:'linkedin-account',accountIdentity:{id:'member',namespace:'linkedin.member_id'}});
 f.db.rows('extensionNode')[0].capabilities.linkedin={post:true,reply:true,strictAccountVerification:true};
 f.db.rows('accountWriteState')[0].nextWriteNotBefore=new Date(Date.now()+60000);
 expect((await f.claim()).items[0]?.segments[0].id).toBe('linkedin');
 expect(f.db.rows('sendQuotaReservation')).toHaveLength(0);
});

it('rechecks recovered older urgent work before newer urgent work after a successful grant', async () => {
 const f=fixture(); await f.create('old'); await f.create('middle'); await f.create('new');
 for(const [index,row] of f.db.rows('post').entries()) row.sendTarget=withPublishNowRequestedAt(row.sendTarget,new Date(sendNow.getTime()-3+index));
 f.db.rows('post')[0].projectId='blocked'; f.db.rows('sendIntent')[0].projectId='blocked';
 f.projects.assertProjectActive.mockImplementation(async (_org, project)=>{
  if(project==='blocked') throw new ForbiddenException('PROJECT_INACTIVE');
 });
 expect((await f.claim()).items[0]?.segments[0].id).toBe('middle');
 f.db.rows('post')[0].projectId='project'; f.db.rows('sendIntent')[0].projectId='project';
 f.db.rows('accountWriteState')[0].activeExecutionId=null;
 expect((await f.claim()).items[0]?.segments[0].id).toBe('old');
});

it('applies manual Post now admission with real quota rules while retaining current account pacing and limits', async () => {
 const f=fixture(); await f.create('automatic');
 f.quotas.resolve.mockRestore();
 f.db.rows('sendIntent')[0].sendOrigin='AUTOMATION';
 expect(await f.claim('automatic-disabled')).toMatchObject({items:[],reason:'AUTOMATION_DISABLED'});
 await f.service.rescheduleQueuedPost('org','automatic','user',sendNow,0,1,true);
 f.db.rows('accountWriteState')[0].lastConfirmedAt=new Date(sendNow.getTime()-60000);
 expect(await f.claim('manual-early')).toMatchObject({items:[],reason:'ACCOUNT_COOLDOWN_ACTIVE'});
 f.db.rows('accountWriteState')[0].lastConfirmedAt=null;
 f.db.rows('accountWriteState')[0].dailyWriteLimit=0;
 const item=(await f.claim('manual-due')).items[0];
 expect(item?.segments[0].id).toBe('automatic');
 await f.proof(item);
 await expect(f.executions.start(auth,item.executionId,0,item.leaseToken)).rejects.toThrow('SEND_QUOTA_EXHAUSTED');
 expect(f.db.rows('sendQuotaReservation')).toHaveLength(0);
 expect(f.db.rows('sendIntent')[0].sendOrigin).toBe('AUTOMATION');
});
it('revalidates priority lane membership if scheduling changes during discovery', async () => {
 const f=fixture(); await f.create('urgent'); await f.create('ordinary');
 f.db.rows('post')[0].sendTarget=withPublishNowRequestedAt(f.db.rows('post')[0].sendTarget,sendNow);
 f.projects.assertProjectActive.mockImplementationOnce(async ()=>{
  f.db.rows('post')[0].sendTarget=withPublishNowRequestedAt(f.db.rows('post')[0].sendTarget,null);
 });
 expect((await f.claim()).items[0]?.segments[0].id).toBe('ordinary');
 expect(f.db.rows('sendExecution')).toHaveLength(1);
});

it('treats missing and malformed dispatch metadata as ordinary due work', async () => {
 const f=fixture(); await f.create('a-legacy'); await f.create('b-invalid');
 f.db.rows('post')[0].sendTarget = null;
 f.db.rows('post')[1].sendTarget = {dispatch:{mode:'now',requestedAt:'b-invalid'}};
 expect((await f.claim()).items[0]?.segments[0].id).toBe('a-legacy');
 f.db.rows('accountWriteState')[0].activeExecutionId=null;
 expect((await f.claim()).items[0]?.segments[0].id).toBe('b-invalid');
});

it('sorts the JSON priority subset before taking the discovery page', async () => {
 const f=fixture();
 for(let i=0;i<27;i++) {
  await f.create(`urgent-${String(i).padStart(2,'0')}`);
  const row=f.db.rows('post')[i];
  row.sendTarget=withPublishNowRequestedAt(row.sendTarget,new Date(sendNow.getTime()-i));
 }
 expect((await f.claim()).items[0]?.segments[0].id).toBe('urgent-26');
});

it('reads one priority snapshot for an entire polling claim across both scan lanes', async () => {
 const f=fixture();
 for(let i=0;i<101;i++) {
  await f.create(`blocked-${String(i).padStart(3,'0')}`);
  const row=f.db.rows('post')[i]; row.projectId='blocked';
  row.sendTarget=withPublishNowRequestedAt(row.sendTarget,sendNow);
 }
 await f.create('ordinary');
 f.projects.assertProjectActive.mockImplementation(async (_org,project)=>{
  if(project==='blocked') throw new ForbiddenException('PROJECT_INACTIVE');
 });
 const model=f.db.post, findMany=vi.fn(model.findMany);
 f.db.post={...model,findMany};
 expect((await f.claim()).items[0]?.segments[0].id).toBe('ordinary');
 const priorityReads=findMany.mock.calls.filter(([args])=>args.where?.sendTarget?.path?.[0]==='dispatch');
 expect(priorityReads).toHaveLength(1);
 expect(priorityReads[0][0]).not.toHaveProperty('take');
});

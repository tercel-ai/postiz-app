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
  const proof = async (item: any) => {
    const challenge = await executions.preflight(auth, item.executionId, 0, item.leaseToken);
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

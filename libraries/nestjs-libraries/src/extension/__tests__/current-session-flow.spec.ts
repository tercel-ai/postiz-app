import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExtensionNodeService } from '../extension-node.service';
import { SendBindingService } from '../send-binding.service';
import {
  SendPolicyService,
  SEND_ACCOUNT_POLICY_KEY,
} from '../send-policy.service';
import { SendCoordinatorService } from '../send-coordinator.service';
import { SendExecutionService } from '../send-execution.service';
import { SendQuotaService } from '../send-quota.service';
import { canonicalSendAccount } from '../send-coordination.utils';
import { memorySendDatabase } from './support/memory-send-database';
const now = new Date('2026-10-16T12:00:00Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
  vi.stubEnv('EXTENSION_NODE_CREDENTIAL_KEY', 'n'.repeat(32));
  vi.stubEnv('SEND_EXECUTION_CREDENTIAL_KEY', 's'.repeat(32));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
const platformCases = [
  ['x', 'x.rest_id', '123'], ['reddit', 'reddit.user_id', 'abc123'],
  ['linkedin', 'linkedin.organization_id', '1337'],
  ['linkedin', 'linkedin.fs_miniProfile', 'ACoAAabc_1'], ['medium', 'medium.handle', 'alice'],
  ['quora', 'quora.user_id', '1923931969'], ['hackernews', 'hackernews.handle', 'Alice'], ['devto', 'devto.user_id', '12345'],
];
const validFlows = platformCases.flatMap(row => ['POST', 'REPLY'].flatMap(action =>
  ['LIVE', 'CACHE'].map(mode => [...row, action, mode, 'valid'])));
const invalidCachedFlows = [
  ...['changed-binding', 'missing-binding', 'missing-prior-proof', 'missing-prior-session',
    'integration-mismatch', 'expired-challenge', 'stale-observation', 'future-observation',
    'before-challenge', 'repeated-probe', 'changed-actor', 'changed-namespace'].map(failure =>
    ['linkedin', 'linkedin.fs_miniProfile', 'ACoAAabc_1', 'POST', 'CACHE', failure]),
  ...['changed-controller', 'composer-context'].map(failure =>
    ['linkedin', 'linkedin.organization_id', '1337', 'POST', 'CACHE', failure]),
];
it.each([...validFlows, ...invalidCachedFlows])('runs %s %s %s %s %s %s registration, OPTIONAL binding and settlement', async (platform, namespace, actorIdentity, action, mode, failure) => {
  const company = namespace === 'linkedin.organization_id';
  const provider = company ? 'linkedin-page' : platform;
  const db = memorySendDatabase();
  db.seed('settings', { key: 'sending.organization_mode:org', value: { mode: 'CONTROLLED', revision: 1 } });
  db.seed('userOrganization', {
    organizationId: 'org',
    userId: 'owner',
    disabled: false,
  });
  db.seed('settings', {
    key: SEND_ACCOUNT_POLICY_KEY,
    value: { mode: 'OPTIONAL', revision: 1, lastRequiredRevision: 0 },
  });
  const nodes = new ExtensionNodeService(db as any);
  const registered = await nodes.register('org', 'owner', {
    nodeId: 'a'.repeat(64),
    requestId: 'register',
    browser: 'chrome',
    protocolVersion: 'ACCOUNT_BOUND_V1',
    capabilities: {
      [platform]: { post: true, reply: true, strictAccountVerification: true },
    },
  } as any);
  const auth = {
    org: 'org',
    user: 'owner',
    nodeId: registered.nodeId,
    token: registered.nodeToken,
  };
  let sequence = 0;
  const report = (challenge?: string, overrides: Record<string, unknown> = {}) =>
    nodes.report(
      'org',
      'owner',
      auth.nodeId,
      auth.token,
      {
        reportSequence: ++sequence,
        checkedAt: new Date().toISOString(),
        platforms: [
          {
            platform,
            ...(company ? { actorContext: challenge && mode === 'LIVE' ? 'COMPOSER' : 'COMPANY_ADMIN', controllerId: 'ACoAdmin' } : {}),
            id: actorIdentity,
            identityNamespace: namespace,
            loggedIn: true,
            handle: 'alice',
            probeId: `probe-${sequence}`,
            sessionBinding: 'a'.repeat(64),
            evidenceKind: challenge && mode === 'CACHE' ? 'SESSION_BOUND_ACTOR' : company ? 'LIVE_PAGE_ACTOR' : 'LIVE_COOKIE_ID',
            verificationStatus: 'VERIFIED',
            identityObservedAt: new Date().toISOString(),
            ...(challenge ? { preflightChallenge: challenge } : {}),
            ...overrides,
          },
        ],
      } as any,
      { canCreateChannels: true, maxChannels: 1 }
    );
  const discovered: any = await report();
  const originalSession = structuredClone(db.rows('extensionNodeSession')[0]);
  const actorId = discovered.results[0].integrationId;
  expect(actorId).toBeTruthy();
  expect(db.rows('integration')[0].token).toBe('');
  // Synchronization only identifies the actor; project authorization remains explicit.
  db.seed('integrationProject', {
    id: 'relation',
    organizationId: 'org',
    projectId: 'project',
    integrationId: actorId,
    disabled: false,
    engageEnabled: true,
    integration: db.rows('integration')[0],
  });
  expect(db.rows('accountWriteState')).toHaveLength(0);
  db.seed('post', {
    id: 'root',
    organizationId: 'org',
    projectId: 'project',
    group: 'group',
    providerIdentifier: provider,
    integrationId: company ? actorId : null,
    parentPostId: null,
    accountSelectionMode: company ? 'EXPLICIT' : 'INHERIT',
    state: 'DRAFT',
    content: 'hello',
    settings: JSON.stringify(platform === 'x' ? { reply_to_tweet_id: '1' } : platform === 'reddit' ? { replyToId: 't3_1' } : { replyToId: '1', replyUrl: ({linkedin:'https://www.linkedin.com/feed/update/urn:li:activity:1',medium:'https://medium.com/@alice/story-abcdef123456',quora:'https://www.quora.com/question/answer/Alice',hackernews:'https://news.ycombinator.com/item?id=1',devto:'https://dev.to/alice/article'} as Record<string,string>)[platform] }),
    image: '[]',
    source: 'calendar',
    publishDate: now,
    publishMethod: 'EXTENSION',
  });
  const projects = { assertProjectActive: vi.fn() };
  const quotas = new SendQuotaService();
  vi.spyOn(quotas, 'resolve').mockResolvedValue({
    gapMs: 0,
    budgets: [
      {
        key: 'budget',
        scope: 'ACCOUNT',
        dimension: 'WRITES',
        limit: 1,
        units: 1,
        windowStart: new Date('2026-10-16T00:00:00Z'),
        windowEnd: new Date('2026-10-17T00:00:00Z'),
        timezone: 'UTC',
        policyVersion: 'test',
      },
    ],
  });
  const sends = new SendCoordinatorService(
    db as any,
    new SendBindingService(db as any, projects as any),
    new SendPolicyService(db as any),
    projects as any,
    quotas
  );
  const executions = new SendExecutionService(db as any, nodes, sends);
  await sends.enqueue('org', 'root', { userId: 'owner', origin: 'MANUAL', action: action as 'POST' | 'REPLY' });
  const claim = (
    await executions.claim(auth, { requestId: 'claim', action: action as 'POST' | 'REPLY' })
  ).items[0];
  expect(db.rows('accountWriteState')).toEqual([expect.objectContaining({
    canonicalAccountKey: canonicalSendAccount('org', provider, namespace, actorIdentity),
    integrationId: actorId, rolloutReady: true,
  })]);
  expect(claim.targetAccount).toMatchObject({
    id: actorIdentity,
    idNamespace: namespace,
  });
  if (company) {
    const other = await nodes.register('org', 'owner', { nodeId: 'b'.repeat(64), requestId: 'second-register', browser: 'firefox', protocolVersion: 'ACCOUNT_BOUND_V1', capabilities: { linkedin: { post: true, reply: true, strictAccountVerification: true } } } as any);
    await nodes.report('org', 'owner', other.nodeId, other.nodeToken, {
      checkedAt: now.toISOString(), reportSequence: 1,
      platforms: [{ platform: 'linkedin', id: actorIdentity, identityNamespace: namespace, controllerId: 'ACoOtherAdmin', actorContext: 'COMPANY_ADMIN', loggedIn: true, probeId: 'other-admin-probe', evidenceKind: 'LIVE_PAGE_ACTOR', verificationStatus: 'VERIFIED', identityObservedAt: now.toISOString() }],
    } as any);
    const rival = await executions.claim({ ...auth, nodeId: other.nodeId, token: other.nodeToken }, { requestId: 'rival-claim', action: action as 'POST' | 'REPLY' });
    expect(rival.items).toEqual([]);
    expect(db.rows('sendExecution')).toHaveLength(1);
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
  }
  const challenge = await executions.preflight(
    auth,
    claim.executionId,
    0,
    claim.leaseToken
  );
  if (company) {
    const before = db.rows('sendQuotaReservation').length;
    await expect(nodes.report('org', 'owner', auth.nodeId, auth.token, {
      checkedAt: now.toISOString(), reportSequence: sequence + 1,
      platforms: [{ platform, id: actorIdentity, identityNamespace: namespace,
        loggedIn: true, actorContext: 'COMPANY_ADMIN', controllerId: 'ACoAdmin',
        probeId: 'admin-is-not-composer', evidenceKind: 'LIVE_PAGE_ACTOR', verificationStatus: 'VERIFIED',
        identityObservedAt: now.toISOString(), preflightChallenge: challenge.challenge }],
    } as any)).rejects.toThrow('SEND_PREFLIGHT_EVIDENCE_INVALID');
    expect(db.rows('sendQuotaReservation')).toHaveLength(before);
  }
  vi.setSystemTime(new Date(now.getTime()+1000));
  if (failure !== 'valid') {
    const prior = db.rows('extensionNodeSession')[0];
    const overrides: Record<string, unknown> = {};
    if (failure === 'changed-binding') overrides.sessionBinding = 'b'.repeat(64);
    if (failure === 'missing-binding') overrides.sessionBinding = undefined;
    if (failure === 'missing-prior-proof') prior.verifiedAt = null;
    if (failure === 'missing-prior-session') db.rows('extensionNodeSession').splice(0, 1);
    if (failure === 'integration-mismatch') db.rows('sendExecution')[0].integrationId = 'other-account';
    if (failure === 'expired-challenge') vi.setSystemTime(new Date(now.getTime() + 31_000));
    if (failure === 'stale-observation') overrides.identityObservedAt = new Date(now.getTime() - 31_000).toISOString();
    if (failure === 'future-observation') overrides.identityObservedAt = new Date(now.getTime() + 1_001).toISOString();
    if (failure === 'before-challenge') overrides.identityObservedAt = new Date(now.getTime() - 1).toISOString();
    if (failure === 'repeated-probe') overrides.probeId = prior.probeId;
    if (failure === 'changed-actor') overrides.id = 'ACoDifferentMember';
    if (failure === 'changed-namespace') overrides.identityNamespace = 'linkedin.oauth_sub';
    if (failure === 'changed-controller') overrides.controllerId = 'ACoOtherAdmin';
    if (failure === 'composer-context') overrides.actorContext = 'COMPOSER';
    const sessionsBefore = structuredClone(db.rows('extensionNodeSession'));
    const segmentsBefore = structuredClone(db.rows('sendSegment'));
    const receiptsBefore = structuredClone(db.rows('extensionNodeReportReceipt'));
    const nodeBefore = structuredClone(db.rows('extensionNode'));
    await expect(report(challenge.challenge, overrides)).rejects.toThrow('SEND_PREFLIGHT_EVIDENCE_INVALID');
    expect(db.rows('extensionNodeSession')).toEqual(sessionsBefore);
    expect(db.rows('sendSegment')).toEqual(segmentsBefore);
    expect(db.rows('extensionNodeReportReceipt')).toEqual(receiptsBefore);
    expect(db.rows('extensionNode')).toEqual(nodeBefore);
    await expect(executions.start(auth, claim.executionId, 0, claim.leaseToken,
      { authorizationMode: 'NATIVE_FLOW_V1' })).rejects.toThrow('FRESH_SEND_PREFLIGHT_REQUIRED');
    expect(db.rows('sendSegment')[0]).toMatchObject({ status: 'PENDING', probeId: null,
      evidenceSessionRevision: null, evidenceObservedAt: null });
    expect(db.rows('sendSegment')[0].permitHash).toBeUndefined();
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
    expect(db.rows('sendQuotaBucket')).toHaveLength(0);
    return;
  }
  await report(challenge.challenge);
  if (mode === 'CACHE') {
    const session=db.rows('extensionNodeSession')[0], segment=db.rows('sendSegment')[0];
    expect(session.verifiedAt).toEqual(originalSession.verifiedAt);
    expect(session.lastVerifiedIdentity).toEqual(originalSession.lastVerifiedIdentity);
    expect(session.probeId).toBe(`probe-${sequence}`);
    expect(segment.probeId).toBe(session.probeId);
    expect(segment.evidenceSessionRevision).toBe(session.sessionRevision);
  }
  const permit = await executions.start(
    auth,
    claim.executionId,
    0,
    claim.leaseToken,
    mode === 'CACHE' ? { authorizationMode: 'NATIVE_FLOW_V1' } : {}
  );
  expect(permit.granted).toBe(true);
  if (mode === 'CACHE') expect(permit).toMatchObject({ authorizationMode: 'NATIVE_FLOW_V1' });
  expect(db.rows('sendQuotaReservation')[0].state).toBe('HELD');
  expect(
    (await executions.start(auth, claim.executionId, 0, claim.leaseToken,
      mode === 'CACHE' ? { authorizationMode: 'NATIVE_FLOW_V1' } : {}))
      .granted
  ).toBe(false);
  const result = {
    eventId: 'confirmed',
    status: 'confirmed' as const,
    platformId: 'tweet-id',
    url: 'https://x.com/alice/status/tweet-id',
  };
  await executions.outcome(
    auth,
    claim.executionId,
    0,
    claim.leaseToken,
    result
  );
  await executions.outcome(
    auth,
    claim.executionId,
    0,
    claim.leaseToken,
    result
  );
  expect(db.rows('post')[0]).toMatchObject({
    state: 'PUBLISHED',
    integrationId: actorId,
    releaseId: 'tweet-id',
  });
  expect(db.rows('sendQuotaBucket')[0]).toMatchObject({
    heldUnits: 0,
    confirmedUnits: 1,
  });
  expect(db.rows('sendExecution')).toHaveLength(1);
  if (company) {
    db.seed('post', { ...db.rows('post')[0], id: 'unbound-root', sendIntentId: null, contentUnitId: null, executionProtocol: null, releaseId: null, state: 'DRAFT', integrationId: null, accountSelectionMode: 'INHERIT' });
    await expect(sends.enqueue('org', 'unbound-root', { userId: 'owner', origin: 'MANUAL', action: action as 'POST' | 'REPLY' })).rejects.toThrow('LINKEDIN_COMPANY_ACCOUNT_REQUIRED');
    db.rows('post').find(p => p.id === 'unbound-root').providerIdentifier = 'linkedin';
    await sends.enqueue('org', 'unbound-root', { userId: 'owner', origin: 'MANUAL', action: action as 'POST' | 'REPLY' });
    const unbound = await executions.claim(auth, { requestId: 'never-pick-arbitrary-company', rootPostId: 'unbound-root', action: action as 'POST' | 'REPLY' });
    expect(unbound.items).toEqual([]);
    expect(db.rows('post').find(p => p.id === 'unbound-root').integrationId).toBeNull();
    expect(db.rows('sendQuotaBucket')[0].confirmedUnits).toBe(1);
  }
});

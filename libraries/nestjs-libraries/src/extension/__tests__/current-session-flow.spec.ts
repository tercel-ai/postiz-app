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
it.each(platformCases.flatMap(row => ['POST', 'REPLY'].map(action => [...row, action])))('runs %s %s %s %s registration, OPTIONAL binding and settlement', async (platform, namespace, actorIdentity, action) => {
  const company = namespace === 'linkedin.organization_id';
  const provider = company ? 'linkedin-page' : platform;
  const db = memorySendDatabase();
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
  const report = (challenge?: string) =>
    nodes.report(
      'org',
      'owner',
      auth.nodeId,
      auth.token,
      {
        reportSequence: ++sequence,
        checkedAt: now.toISOString(),
        platforms: [
          {
            platform,
            ...(company ? { actorContext: challenge ? 'COMPOSER' : 'COMPANY_ADMIN', controllerId: 'ACoAdmin' } : {}),
            id: actorIdentity,
            identityNamespace: namespace,
            loggedIn: true,
            handle: 'alice',
            probeId: `probe-${sequence}`,
            evidenceKind: company ? 'LIVE_PAGE_ACTOR' : 'LIVE_COOKIE_ID',
            verificationStatus: 'VERIFIED',
            identityObservedAt: now.toISOString(),
            ...(challenge ? { preflightChallenge: challenge } : {}),
          },
        ],
      } as any,
      { canCreateChannels: true, maxChannels: 1 }
    );
  const discovered: any = await report();
  const actorId = discovered.results[0].integrationId;
  expect(actorId).toBeTruthy();
  expect(db.rows('integration')[0].token).toBe('');
  // Project authorization and the deployment audit are explicit, independent prerequisites.
  db.seed('integrationProject', {
    id: 'relation',
    organizationId: 'org',
    projectId: 'project',
    integrationId: actorId,
    disabled: false,
    engageEnabled: true,
    integration: db.rows('integration')[0],
  });
  db.seed('accountWriteState', {
    id: 'state',
    organizationId: 'org',
    canonicalAccountKey: canonicalSendAccount('org', provider, namespace, actorIdentity),
    integrationId: actorId,
    rolloutReady: true,
  });
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
  await report(challenge.challenge);
  const permit = await executions.start(
    auth,
    claim.executionId,
    0,
    claim.leaseToken
  );
  expect(permit.granted).toBe(true);
  expect(db.rows('sendQuotaReservation')[0].state).toBe('HELD');
  expect(
    (await executions.start(auth, claim.executionId, 0, claim.leaseToken))
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

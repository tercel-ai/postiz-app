import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
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
function fixture(action: 'POST' | 'REPLY' = 'POST') {
  const db = memorySendDatabase();
  db.seed('settings', { key: 'sending.organization_mode:org', value: { mode: 'CONTROLLED', revision: 1 } });
  db.seed('settings', {
    key: SEND_ACCOUNT_POLICY_KEY,
    value: { mode: 'OPTIONAL', revision: 1, lastRequiredRevision: 0 },
  });
  db.seed('userOrganization', {
    organizationId: 'org',
    userId: 'owner',
    disabled: false,
  });
  const projects = { assertProjectActive: vi.fn() };
  const bindings = new SendBindingService(db as any, projects as any);
  const policies = new SendPolicyService(db as any);
  const sends = new SendCoordinatorService(
    db as any,
    bindings,
    policies,
    projects as any,
    new SendQuotaService()
  );
  const nodes = {
    authenticateIn: vi.fn(async (_tx, _org, _user, nodeId) =>
      db.rows('extensionNode').find((n) => n.id === nodeId)
    ),
  };
  const executions = new SendExecutionService(db as any, nodes as any, sends);
  const seedActor = (id = 'one', actorId = '123') => {
    const actor = {
      id,
      organizationId: 'org',
      providerIdentifier: 'x',
      identityNamespace: 'x.rest_id',
      internalId: actorId,
      profile: id,
      disabled: false,
      inBetweenSteps: false,
    };
    db.seed('integration', actor);
    db.seed('integrationProject', {
      id: `rel-${id}`,
      organizationId: 'org',
      projectId: 'project',
      integrationId: id,
      disabled: false,
      engageEnabled: true,
      integration: actor,
    });
    db.seed('accountWriteState', {
      id: `state-${id}`,
      organizationId: 'org',
      integrationId: id,
      canonicalAccountKey: canonicalSendAccount(
        'org',
        'x',
        'x.rest_id',
        actorId
      ),
      rolloutReady: true,
    });
    db.seed('extensionNode', {
      id: `node-${id}`,
      nodeId: `node-${id}`,
      organizationId: 'org',
      credentialVersion: 1,
      capabilities: {
        x: { post: true, reply: true, strictAccountVerification: true },
      },
    });
    db.seed('extensionNodeSession', {
      extensionNodeId: `node-${id}`,
      organizationId: 'org',
      platform: 'x',
      integrationId: id,
      verificationStatus: 'VERIFIED',
      verificationExpiresAt: new Date(now.getTime() + 60000),
      sessionRevision: 1,
      accountIdentity: { id: actorId, namespace: 'x.rest_id' },
    });
  };
  db.seed('post', {
    id: 'root',
    organizationId: 'org',
    projectId: 'project',
    providerIdentifier: 'x',
    group: 'group',
    parentPostId: null,
    integrationId: null,
    accountSelectionMode: 'INHERIT',
    state: 'DRAFT',
    content: 'hello',
    image: '[]',
    settings:
      action === 'REPLY'
        ? JSON.stringify({ reply_to_tweet_id: 'target' })
        : '{}',
    publishDate: now,
    publishMethod: 'EXTENSION',
    source: 'calendar',
  });
  const enqueue = (extra = {}) =>
    sends.enqueue('org', 'root', {
      userId: 'owner',
      origin: 'MANUAL',
      action,
      ...extra,
    });
  let request = 0;
  const claim = (id = 'one') =>
    executions.claim(
      { org: 'org', user: 'owner', nodeId: `node-${id}`, token: 'token' },
      { requestId: `request-${++request}`, action }
    );
  return {
    db,
    sends,
    executions,
    policies,
    bindings,
    seedActor,
    enqueue,
    claim,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
  vi.stubEnv('SEND_EXECUTION_CREDENTIAL_KEY', 'k'.repeat(32));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe('OPTIONAL initial current-session binding', () => {
  it('queues an unbound task and freezes the first authorized actor at claim', async () => {
    const f = fixture();
    f.seedActor();
    const queued = await f.enqueue();
    expect(queued).toMatchObject({
      integrationId: null,
      accountSelectionMode: 'CURRENT_SESSION',
      accountResolution: 'AWAITING_CURRENT_ACTOR',
      publishMethod: 'EXTENSION',
    });
    expect(f.db.rows('sendExecution')).toHaveLength(0);
    const first = (await f.claim()).items[0];
    expect(first).toMatchObject({
      integrationId: 'one',
      targetAccount: { id: '123', idNamespace: 'x.rest_id' },
    });
    expect(f.db.rows('post')[0]).toMatchObject({
      integrationId: 'one',
      accountResolution: 'RESOLVED',
      routeRevision: 1,
    });
    expect(f.db.rows('sendIntent')[0]).toMatchObject({
      integrationId: 'one',
      routeRevision: 1,
    });
    expect(f.db.rows('sendQuotaReservation')).toHaveLength(0);
  });
  it('allows only one actor when two different terminals race', async () => {
    const f = fixture();
    f.seedActor();
    f.seedActor('two', '456');
    await f.enqueue();
    const results = await Promise.all([f.claim('one'), f.claim('two')]);
    expect(results.flatMap((r) => r.items)).toHaveLength(1);
    expect(f.db.rows('sendExecution')).toHaveLength(1);
    expect(f.db.rows('sendIntent')[0].integrationId).toBe('one');
  });
  it('never rereads a default added after the current-session task was queued', async () => {
    const f = fixture();
    f.seedActor();
    f.seedActor('two', '456');
    await f.enqueue();
    f.db.seed('projectSendBinding', {
      organizationId: 'org',
      projectId: 'project',
      platform: 'x',
      action: 'POST',
      integrationId: 'two',
    });
    expect((await f.claim()).items[0].integrationId).toBe('one');
  });
  it('retains the REQUIRED barrier even after the system is relaxed again', async () => {
    const f = fixture();
    f.seedActor();
    await f.enqueue();
    f.db.rows('settings').find(row => row.key === SEND_ACCOUNT_POLICY_KEY).value = {
      mode: 'OPTIONAL',
      revision: 3,
      lastRequiredRevision: 2,
    };
    expect((await f.claim()).items).toEqual([]);
    expect(f.db.rows('sendIntent')[0].integrationId).toBeNull();
    expect(f.db.rows('post')[0].accountResolution).toBe(
      'PRESELECTION_REQUIRED'
    );
  });
  it.each([
    'disabled-relation',
    'expired-session',
    'wrong-actor',
    'unaudited',
    'owner-left',
  ])('does not bind an ineligible actor: %s', async (reason) => {
    const f = fixture();
    f.seedActor();
    await f.enqueue();
    if (reason === 'disabled-relation')
      f.db.rows('integrationProject')[0].disabled = true;
    if (reason === 'expired-session')
      f.db.rows('extensionNodeSession')[0].verificationExpiresAt = now;
    if (reason === 'wrong-actor')
      f.db.rows('extensionNodeSession')[0].accountIdentity.id = '999';
    if (reason === 'unaudited')
      f.db.rows('accountWriteState')[0].rolloutReady = false;
    if (reason === 'owner-left')
      f.db.rows('userOrganization')[0].disabled = true;
    expect((await f.claim()).items).toEqual([]);
    expect(f.db.rows('sendIntent')[0].integrationId).toBeNull();
  });
  it('requires engageEnabled for a current-session reply', async () => {
    const f = fixture('REPLY');
    f.seedActor();
    await f.enqueue();
    f.db.rows('integrationProject')[0].engageEnabled = false;
    expect((await f.claim()).items).toEqual([]);
  });
  it('honors valid defaults and never treats an invalid default as unbound', async () => {
    const f = fixture();
    f.seedActor();
    f.db.seed('projectSendBinding', {
      organizationId: 'org',
      projectId: 'project',
      platform: 'x',
      action: 'POST',
      integrationId: 'one',
    });
    expect((await f.enqueue()).integrationId).toBe('one');
    const g = fixture();
    g.seedActor();
    g.db.seed('projectSendBinding', {
      organizationId: 'org',
      projectId: 'project',
      platform: 'x',
      action: 'POST',
      integrationId: 'missing',
    });
    await expect(g.enqueue()).rejects.toThrow('ACCOUNT_NOT_ASSIGNED');
  });
  it('respects a stricter owner preference', async () => {
    const f = fixture();
    f.db.seed('userSendPreference', {
      userId: 'owner',
      requirePreselectedAccount: true,
    });
    await expect(f.enqueue()).rejects.toThrow('SEND_BINDING_REQUIRED');
  });
  it('accepts the old API route field but queues new work only for the plugin', async () => {
    const f = fixture();
    f.seedActor();
    expect((await f.enqueue({ publishMethod: 'API' })).publishMethod).toBe(
      'EXTENSION'
    );
  });
});

it('rolls back first binding if reservation preparation fails in the same transaction', async () => {
  const f = fixture();
  f.seedActor();
  await f.enqueue();
  f.db.rows('post')[0].image = '[{}]';
  expect((await f.claim()).items).toEqual([]);
  expect(f.db.rows('sendIntent')[0]).toMatchObject({
    integrationId: null,
    routeRevision: 0,
  });
  expect(f.db.rows('post')[0]).toMatchObject({
    integrationId: null,
    accountResolution: 'AWAITING_CURRENT_ACTOR',
  });
  expect(f.db.rows('sendExecution')).toHaveLength(0);
});
it.each([true, false])(
  'serializes first binding and a system-policy tightening, binding first: %s',
  async (bindingFirst) => {
    const f = fixture();
    f.seedActor();
    await f.enqueue();
    f.db.seed('user', { id: 'admin', isSuperAdmin: true });
    const tighten = () =>
      f.policies.saveSystem('admin', {
        expectedRevision: 1,
        requestId: 'tighten',
        value: { mode: 'REQUIRED' },
      });
    // Invocation order is not lock order: discovery now precedes the short binding transaction.
    let locked!: () => void;
    const bindingLock = new Promise<void>((resolve) => { locked = resolve; });
    const lock = f.policies.lockSystemInTransaction.bind(f.policies);
    vi.spyOn(f.policies, 'lockSystemInTransaction').mockImplementation(async (tx) => {
      const result = await lock(tx);
      locked();
      return result;
    });
    const claiming = bindingFirst ? f.claim() : null;
    if (bindingFirst) await bindingLock;
    const results = bindingFirst
      ? await Promise.all([claiming!, tighten()])
      : await Promise.all([tighten(), f.claim()]);
    const claim: any = results[bindingFirst ? 0 : 1];
    expect(claim.items).toHaveLength(bindingFirst ? 1 : 0);
    expect(f.db.rows('sendIntent')[0].integrationId).toBe(
      bindingFirst ? 'one' : null
    );
  }
);
it('does not convert an explicit but missing account into CURRENT_SESSION', async () => {
  const f = fixture();
  f.db.rows('post')[0].accountSelectionMode = 'EXPLICIT';
  await expect(f.enqueue()).rejects.toThrow('SEND_BINDING_REQUIRED');
});
it('requires reconfirming an old draft whose account-selection provenance is unknown', async () => {
  const f = fixture();
  f.seedActor();
  f.db.rows('post')[0].integrationId = 'one';
  f.db.rows('post')[0].accountSelectionMode = null;
  await expect(f.enqueue()).rejects.toThrow(
    'SEND_BINDING_RECONFIRMATION_REQUIRED'
  );
  expect(
    (await f.enqueue({ explicitIntegrationId: 'one' })).integrationId
  ).toBe('one');
});

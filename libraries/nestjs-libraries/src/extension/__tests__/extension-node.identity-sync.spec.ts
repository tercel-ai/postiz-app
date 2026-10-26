import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionNodeService } from '../extension-node.service';
import { memorySendDatabase } from './support/memory-send-database';
import { canonicalSendAccount } from '../send-coordination.utils';
const now = new Date('2026-10-16T12:00:00Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function fixture() {
  const db = memorySendDatabase();
  db.seed('settings', {
    key: 'sending.organization_mode:org',
    value: { mode: 'CONTROLLED', revision: 1 },
  });
  for (const id of ['node-a', 'node-b'])
    db.seed('extensionNode', {
      id,
      nodeId: id,
      organizationId: 'org',
      status: 'ACTIVE',
      lastReportSequence: 0,
    });
  const service = new ExtensionNodeService(db as any);
  vi.spyOn(service, 'authenticateIn').mockImplementation(
    async (_tx, _org, _user, id) =>
      db.rows('extensionNode').find((n) => n.id === id)
  );
  const report = (
    id = 'node-a',
    patch = {},
    creation = { canCreateChannels: true, maxChannels: 2 }
  ) =>
    service.report(
      'org',
      'user',
      id,
      'token',
      {
        checkedAt: now.toISOString(),
        reportSequence:
          db.rows('extensionNode').find((n) => n.id === id).lastReportSequence +
          1,
        platforms: [
          {
            platform: 'x',
            id: '123',
            identityNamespace: 'x.rest_id',
            loggedIn: true,
            handle: 'alice',
            probeId: crypto.randomUUID(),
            evidenceKind: 'LIVE_COOKIE_ID',
            verificationStatus: 'VERIFIED',
            identityObservedAt: now.toISOString(),
            ...patch,
          },
        ],
      } as any,
      creation
    );
  return { db, service, report };
}
describe('terminal identity synchronization', () => {
  it('keeps social identity synchronization independent of account sending-state enrollment', async () => {
    const f = fixture();
    const result: any = await f.report();
    expect(result.results[0].verificationStatus).toBe('VERIFIED');
    expect(f.db.rows('accountWriteState')).toHaveLength(0);
    expect(f.db.rows('integrationProject')).toHaveLength(0);
  });
  it.each([false, true])(
    'does not change rolloutReady=%s or ownership/clocks during verified synchronization',
    async (ready) => {
      const f = fixture();
      f.db.seed('integration', {
        id: 'account',
        organizationId: 'org',
        providerIdentifier: 'x',
        identityNamespace: 'x.rest_id',
        internalId: '123',
        disabled: false,
      });
      const key = canonicalSendAccount('org', 'x', 'x.rest_id', '123');
      f.db.seed('accountWriteState', {
        id: key,
        organizationId: 'org',
        canonicalAccountKey: key,
        integrationId: 'account',
        rolloutReady: ready,
        revision: 0,
        activeExecutionId: null,
        firstConfirmedAt: now,
        lastConfirmedAt: now,
        nextWriteNotBefore: new Date(now.getTime() + 60000),
      });
      const before = structuredClone(f.db.rows('accountWriteState'));
      await f.report();
      await f.report('node-b');
      expect(f.db.rows('accountWriteState')).toEqual(before);
      expect(f.db.rows('sendExecution')).toHaveLength(0);
    }
  );
  it('keeps an occupied quarantined account unchanged on fresh identity verification', async () => {
    const f = fixture();
    f.db.seed('integration', {
      id: 'account',
      organizationId: 'org',
      providerIdentifier: 'x',
      identityNamespace: 'x.rest_id',
      internalId: '123',
      disabled: false,
    });
    const key = canonicalSendAccount('org', 'x', 'x.rest_id', '123');
    f.db.seed('accountWriteState', {
      id: key,
      organizationId: 'org',
      canonicalAccountKey: key,
      integrationId: 'account',
      rolloutReady: false,
      revision: 3,
      activeExecutionId: 'uncertain-owner',
    });
    const before = structuredClone(f.db.rows('accountWriteState'));
    await f.report();
    expect(f.db.rows('accountWriteState')).toEqual(before);
  });
  it('does not request browser probes when no controlled work is due', async () => {
    const f = fixture();
    f.db.rows('extensionNode')[0].capabilities = {
      x: { post: true, reply: true, strictAccountVerification: true },
    };
    expect(
      await f.service.identityProbePlatforms('org', 'user', 'node-a', 'token')
    ).toEqual({ platforms: [] });
  });
  it('requests only due platform identities and skips a still-fresh matching verified account', async () => {
    const f = fixture();
    f.db.rows('extensionNode')[0].capabilities = Object.fromEntries(
      ['x', 'reddit', 'medium'].map((p) => [
        p,
        { post: true, reply: true, strictAccountVerification: true },
      ])
    );
    const post = (id: string, platform: string, patch = {}) => {
      f.db.seed('sendIntent', {
        id: 'intent-' + id,
        organizationId: 'org',
        status: 'QUEUED',
        action: 'POST',
      });
      f.db.seed('post', {
        id,
        organizationId: 'org',
        state: 'QUEUE',
        parentPostId: null,
        executionProtocol: 'ACCOUNT_BOUND_V1',
        publishMethod: 'EXTENSION',
        providerIdentifier: platform,
        integrationId: 'account-' + platform,
        publishDate: now,
        sendIntentId: 'intent-' + id,
        ...patch,
      });
    };
    post('x', 'x');
    post('reddit', 'reddit');
    post('future', 'medium', {
      publishDate: new Date(now.getTime() + 3600000),
    });
    f.db.seed('extensionNodeSession', {
      extensionNodeId: 'node-a',
      organizationId: 'org',
      platform: 'reddit',
      actorKey: '',
      integrationId: 'account-reddit',
      verificationStatus: 'VERIFIED',
      verificationExpiresAt: new Date(now.getTime() + 120000),
    });
    expect(
      await f.service.identityProbePlatforms('org', 'user', 'node-a', 'token')
    ).toEqual({ platforms: ['x'] });
    expect(
      await f.service.identityProbePlatforms(
        'org',
        'user',
        'node-a',
        'token',
        'reddit'
      )
    ).toEqual({ platforms: [] });
    expect(f.db.rows('sendExecution')).toHaveLength(0);
  });
  it('creates one actor and associates independent verified sessions from two terminals', async () => {
    const f = fixture();
    const [a, b]: any[] = await Promise.all([f.report(), f.report('node-b')]);
    expect(a.results[0]).toMatchObject({
      registrationStatus: 'CREATED',
      verificationStatus: 'VERIFIED',
    });
    expect(b.results[0]).toMatchObject({
      registrationStatus: 'EXISTING',
      integrationId: a.results[0].integrationId,
    });
    expect(f.db.rows('extensionNodeSession')).toHaveLength(2);
    expect(f.db.rows('integration')).toHaveLength(1);
    expect(f.db.rows('integrationProject')).toHaveLength(0);
  });
  it('keeps unaudited legacy rows isolated without overwriting credentials or custom fields', async () => {
    const f = fixture();
    f.db.seed('integration', {
      id: 'oauth',
      organizationId: 'org',
      providerIdentifier: 'x',
      identityNamespace: 'legacy',
      internalId: '123',
      token: 'private',
      refreshToken: 'refresh',
      disabled: true,
      name: 'custom',
    });
    expect(((await f.report()) as any).results[0]).toMatchObject({
      integrationId: null,
      blockCode: 'ACCOUNT_IDENTITY_UNRESOLVED',
    });
    expect(f.db.rows('integration')[0]).toMatchObject({
      token: 'private',
      refreshToken: 'refresh',
      disabled: true,
      name: 'custom',
      identityNamespace: 'legacy',
    });
  });
  it('automatically verifies a unique legacy account from fresh live evidence for a controlled-mode administrator', async () => {
    const f = fixture();
    f.db.seed('userOrganization', {
      userId: 'user',
      organizationId: 'org',
      role: 'ADMIN',
      disabled: false,
    });
    f.db.seed('integration', {
      id: 'old',
      organizationId: 'org',
      providerIdentifier: 'x',
      identityNamespace: 'legacy',
      internalId: '123',
      token: 'old-secret',
      refreshNeeded: true,
      disabled: true,
      name: 'custom',
      metadata: { custom: 42 },
    });

    const result: any = await f.report();

    expect(result.results[0]).toMatchObject({
      integrationId: 'old',
      registrationStatus: 'EXISTING',
      verificationStatus: 'VERIFIED',
    });
    expect(f.db.rows('integration')).toHaveLength(1);
    expect(f.db.rows('integration')[0]).toMatchObject({
      id: 'old',
      identityNamespace: 'x.rest_id',
      token: 'old-secret',
      refreshNeeded: true,
      disabled: true,
      name: 'custom',
      metadata: {
        custom: 42,
        identityAudit: {
          method: 'CONTROLLED_AUTO_RECOVERY',
          verifiedByUserId: 'user',
        },
      },
    });
  });
  it('does not automatically verify a legacy account outside controlled mode', async () => {
    const f = fixture();
    f.db.rows('settings')[0].value = { mode: 'AUTONOMOUS', revision: 2 };
    f.db.seed('userOrganization', {
      userId: 'user',
      organizationId: 'org',
      role: 'ADMIN',
      disabled: false,
    });
    f.db.seed('integration', {
      id: 'old',
      organizationId: 'org',
      providerIdentifier: 'x',
      identityNamespace: 'legacy',
      internalId: '123',
      token: 'old-secret',
      name: 'custom',
    });

    const result: any = await f.report();

    expect(result.results[0]).toMatchObject({
      integrationId: null,
      recovery: {
        integrationId: 'old',
        action: 'VERIFY_LEGACY',
        name: 'custom',
      },
    });
    expect(f.db.rows('integration')[0].identityNamespace).toBe('legacy');
  });
  it('explicitly restores a deleted legacy account and preserves its identity/history', async () => {
    const f = fixture();
    f.db.seed('userOrganization', {
      userId: 'user',
      organizationId: 'org',
      role: 'ADMIN',
      disabled: false,
    });
    f.db.seed('integration', {
      id: 'old',
      organizationId: 'org',
      providerIdentifier: 'x',
      identityNamespace: 'legacy',
      internalId: '123',
      token: 'old-secret',
      refreshNeeded: true,
      disabled: true,
      name: 'custom',
      metadata: { custom: 42 },
      deletedAt: now,
    });
    const before: any = await f.report();
    expect(before.results[0]).toMatchObject({
      integrationId: null,
      recovery: {
        integrationId: 'old',
        action: 'RESTORE',
        name: 'custom',
      },
    });
    const result: any = await f.report('node-a', {
      accountRecovery: { integrationId: 'old', confirmed: true },
    });
    expect(result.results[0]).toMatchObject({
      integrationId: 'old',
      verificationStatus: 'VERIFIED',
    });
    expect(f.db.rows('integration')).toHaveLength(1);
    expect(f.db.rows('integration')[0]).toMatchObject({
      id: 'old',
      identityNamespace: 'x.rest_id',
      deletedAt: null,
      token: 'old-secret',
      refreshNeeded: true,
      disabled: true,
      name: 'custom',
      metadata: {
        custom: 42,
        identityAudit: {
          method: 'EXPLICIT_EXTENSION_RECOVERY',
          verifiedByUserId: 'user',
        },
      },
    });
    expect(f.db.rows('extensionNodeSession')[0]).toMatchObject({
      integrationId: 'old',
      verificationStatus: 'VERIFIED',
    });
  });
  it('requires an organization administrator for explicit account recovery', async () => {
    const f = fixture();
    f.db.seed('userOrganization', {
      userId: 'user',
      organizationId: 'org',
      role: 'USER',
      disabled: false,
    });
    await expect(
      f.report('node-a', {
        accountRecovery: { integrationId: 'old', confirmed: true },
      })
    ).rejects.toThrow('ACCOUNT_IDENTITY_ADMIN_REQUIRED');
    expect(f.db.rows('integration')).toHaveLength(0);
  });
  it.each([
    { evidenceKind: 'CACHED' },
    { verificationStatus: 'UNKNOWN' },
    { identityObservedAt: new Date(now.getTime() - 300001).toISOString() },
    { loggedIn: false },
  ])('rejects recovery without current live evidence: %j', async (patch) => {
    const f = fixture();
    f.db.seed('userOrganization', {
      userId: 'user',
      organizationId: 'org',
      role: 'ADMIN',
      disabled: false,
    });
    await expect(
      f.report('node-a', {
        ...patch,
        accountRecovery: { integrationId: 'old', confirmed: true },
      })
    ).rejects.toThrow('ACCOUNT_RECOVERY_EVIDENCE_REQUIRED');
    expect(f.db.rows('integration')).toHaveLength(0);
  });
  it('never restores another organization or creates a replacement when the confirmed account changed', async () => {
    const f = fixture();
    f.db.seed('userOrganization', {
      userId: 'user',
      organizationId: 'org',
      role: 'ADMIN',
      disabled: false,
    });
    f.db.seed('integration', {
      id: 'foreign',
      organizationId: 'other',
      providerIdentifier: 'x',
      identityNamespace: 'legacy',
      internalId: '123',
      deletedAt: now,
    });
    const result: any = await f.report('node-a', {
      accountRecovery: { integrationId: 'foreign', confirmed: true },
    });
    expect(result.results[0]).toMatchObject({
      integrationId: null,
      blockCode: 'ACCOUNT_RECOVERY_CHANGED',
    });
    expect(f.db.rows('integration')).toHaveLength(1);
    expect(f.db.rows('integration')[0].deletedAt).toEqual(now);
  });
  it('checks channel capacity before restoring a deleted account', async () => {
    const f = fixture();
    f.db.seed('userOrganization', {
      userId: 'user',
      organizationId: 'org',
      role: 'ADMIN',
      disabled: false,
    });
    f.db.seed('integration', {
      id: 'old',
      organizationId: 'org',
      providerIdentifier: 'x',
      identityNamespace: 'legacy',
      internalId: '123',
      deletedAt: now,
    });
    const result: any = await f.report(
      'node-a',
      { accountRecovery: { integrationId: 'old', confirmed: true } },
      { canCreateChannels: true, maxChannels: 0 }
    );
    expect(result.results[0]).toMatchObject({
      integrationId: null,
      blockCode: 'ACCOUNT_CHANNEL_LIMIT',
    });
    expect(f.db.rows('integration')[0].deletedAt).toEqual(now);
  });
  it.each([
    { evidenceKind: 'CACHED' },
    { identityObservedAt: new Date(now.getTime() - 300001).toISOString() },
    { identityNamespace: 'x.handle', id: 'alice' },
  ])(
    'never creates or promotes from insufficient identity evidence: %j',
    async (patch) => {
      const f = fixture();
      expect(
        ((await f.report('node-a', patch)) as any).results[0].verificationStatus
      ).toBe('UNKNOWN');
      expect(f.db.rows('integration')).toHaveLength(0);
      expect(f.db.rows('extensionNodeSession')).toHaveLength(1);
    }
  );
  it('preserves an unresolved observation and a stable report receipt when the account cap is reached', async () => {
    const f = fixture();
    const result: any = await f.report(
      'node-a',
      {},
      { canCreateChannels: true, maxChannels: 0 }
    );
    expect(result.results[0]).toMatchObject({
      integrationId: null,
      verificationStatus: 'UNKNOWN',
      blockCode: 'ACCOUNT_CHANNEL_LIMIT',
    });
    expect(f.db.rows('extensionNodeSession')[0].accountIdentity.id).toBe('123');
    expect(f.db.rows('extensionNodeReportReceipt')).toHaveLength(1);
  });
});

describe('LinkedIn company sessions', () => {
  it('keeps a member and multiple company actors on one terminal; reuses the company on another terminal', async () => {
    const f = fixture();
    const company = (id: string) => ({
      platform: 'linkedin',
      id,
      identityNamespace: 'linkedin.organization_id',
      handle: 'company-' + id,
      evidenceKind: 'LIVE_PAGE_ACTOR',
      actorContext: 'COMPANY_ADMIN',
      controllerId: 'ACoAlice',
    });
    const creation = { canCreateChannels: true, maxChannels: 5 };
    const personal: any = await f.report(
      'node-a',
      {
        platform: 'linkedin',
        id: 'ACoAlice',
        identityNamespace: 'linkedin.fs_miniProfile',
        evidenceKind: 'LIVE_PAGE_ACTOR',
      },
      creation
    );
    const first: any = await f.report('node-a', company('123'), creation);
    await f.report('node-a', company('456'), creation);
    const second: any = await f.report('node-b', company('123'), creation);
    expect(first.results[0]).toMatchObject({
      verificationStatus: 'VERIFIED',
      registrationStatus: 'CREATED',
    });
    expect(second.results[0]).toMatchObject({
      integrationId: first.results[0].integrationId,
      registrationStatus: 'EXISTING',
    });
    expect(first.results[0].integrationId).not.toBe(
      personal.results[0].integrationId
    );
    expect(f.db.rows('extensionNodeSession')).toHaveLength(4);
    expect(
      f.db
        .rows('integration')
        .filter((a) => a.providerIdentifier === 'linkedin-page')
    ).toHaveLength(2);
    expect(
      f.db
        .rows('extensionNodeSession')
        .filter((s) => s.extensionNodeId === 'node-a')
        .map((s) => s.actorKey)
    ).toEqual([
      '',
      'linkedin.organization_id:123',
      'linkedin.organization_id:456',
    ]);
  });
  it('does not verify a company from a personal identity or cached admin observation', async () => {
    const f = fixture();
    const r: any = await f.report('node-a', {
      platform: 'linkedin',
      id: '123',
      identityNamespace: 'linkedin.organization_id',
      evidenceKind: 'CACHED',
      actorContext: 'COMPANY_ADMIN',
      controllerId: 'ACoAlice',
    });
    expect(r.results[0].verificationStatus).toBe('UNKNOWN');
    expect(f.db.rows('integration')).toHaveLength(0);
  });
});

it('invalidates company eligibility on a LinkedIn member change or logout', async () => {
  const f = fixture();
  const company = {
    platform: 'linkedin',
    id: '123',
    identityNamespace: 'linkedin.organization_id',
    handle: 'acme',
    evidenceKind: 'LIVE_PAGE_ACTOR',
    actorContext: 'COMPANY_ADMIN',
    controllerId: 'ACoAlice',
  };
  await f.report(
    'node-a',
    {
      platform: 'linkedin',
      id: 'ACoAlice',
      identityNamespace: 'linkedin.fs_miniProfile',
    },
    { canCreateChannels: true, maxChannels: 4 }
  );
  await f.report('node-a', company, {
    canCreateChannels: true,
    maxChannels: 4,
  });
  await f.report(
    'node-a',
    {
      platform: 'linkedin',
      id: 'ACoBob',
      identityNamespace: 'linkedin.fs_miniProfile',
    },
    { canCreateChannels: true, maxChannels: 4 }
  );
  const session = f.db.rows('extensionNodeSession').find((s) => s.actorKey);
  expect(session.verificationStatus).toBe('UNKNOWN');
  expect(session.verificationExpiresAt).toBeNull();
});

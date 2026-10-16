import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionNodeService } from '../extension-node.service';
import { memorySendDatabase } from './support/memory-send-database';
const now = new Date('2026-10-16T12:00:00Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());
function fixture() {
  const db = memorySendDatabase();
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
    const company = (id: string) => ({ platform: 'linkedin', id, identityNamespace: 'linkedin.organization_id', handle: 'company-' + id, evidenceKind: 'LIVE_PAGE_ACTOR', actorContext: 'COMPANY_ADMIN', controllerId: 'ACoAlice' });
    const creation = { canCreateChannels: true, maxChannels: 5 };
    const personal: any = await f.report('node-a', { platform: 'linkedin', id: 'ACoAlice', identityNamespace: 'linkedin.fs_miniProfile', evidenceKind: 'LIVE_PAGE_ACTOR' }, creation);
    const first: any = await f.report('node-a', company('123'), creation);
    await f.report('node-a', company('456'), creation);
    const second: any = await f.report('node-b', company('123'), creation);
    expect(first.results[0]).toMatchObject({ verificationStatus: 'VERIFIED', registrationStatus: 'CREATED' });
    expect(second.results[0]).toMatchObject({ integrationId: first.results[0].integrationId, registrationStatus: 'EXISTING' });
    expect(first.results[0].integrationId).not.toBe(personal.results[0].integrationId);
    expect(f.db.rows('extensionNodeSession')).toHaveLength(4);
    expect(f.db.rows('integration').filter(a => a.providerIdentifier === 'linkedin-page')).toHaveLength(2);
    expect(f.db.rows('extensionNodeSession').filter(s => s.extensionNodeId === 'node-a').map(s => s.actorKey)).toEqual(['', 'linkedin.organization_id:123', 'linkedin.organization_id:456']);
  });
  it('does not verify a company from a personal identity or cached admin observation', async () => {
    const f = fixture();
    const r: any = await f.report('node-a', { platform: 'linkedin', id: '123', identityNamespace: 'linkedin.organization_id', evidenceKind: 'CACHED', actorContext: 'COMPANY_ADMIN', controllerId: 'ACoAlice' });
    expect(r.results[0].verificationStatus).toBe('UNKNOWN');
    expect(f.db.rows('integration')).toHaveLength(0);
  });
});

it('invalidates company eligibility on a LinkedIn member change or logout', async () => {
  const f = fixture();
  const company = { platform: 'linkedin', id: '123', identityNamespace: 'linkedin.organization_id', handle: 'acme', evidenceKind: 'LIVE_PAGE_ACTOR', actorContext: 'COMPANY_ADMIN', controllerId: 'ACoAlice' };
  await f.report('node-a', { platform: 'linkedin', id: 'ACoAlice', identityNamespace: 'linkedin.fs_miniProfile' }, { canCreateChannels: true, maxChannels: 4 });
  await f.report('node-a', company, { canCreateChannels: true, maxChannels: 4 });
  await f.report('node-a', { platform: 'linkedin', id: 'ACoBob', identityNamespace: 'linkedin.fs_miniProfile' }, { canCreateChannels: true, maxChannels: 4 });
  const session = f.db.rows('extensionNodeSession').find(s => s.actorKey);
  expect(session.verificationStatus).toBe('UNKNOWN');
  expect(session.verificationExpiresAt).toBeNull();
});

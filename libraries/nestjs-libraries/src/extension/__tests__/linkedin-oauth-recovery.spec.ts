import { afterEach, describe, expect, it, vi } from 'vitest';
import { SocialAccountIdentityService } from '../social-account-identity.service';
import { ExtensionNodeService } from '../extension-node.service';
import { memorySendDatabase } from './support/memory-send-database';

const browserId = 'ACoAAA07H24BGZjYnfpiSuwbLgBaajh84HUelEc';
const oauthId = 'RgLJrp5c7c';
const handle = 'kyd-feng-92640b62';
afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const db = memorySendDatabase();
  db.seed('integration', { id: 'old', organizationId: 'org', providerIdentifier: 'linkedin',
    type: 'social', identityNamespace: 'legacy', internalId: oauthId, profile: handle,
    token: 'old-token', refreshToken: 'old-refresh', name: 'Custom name', metadata: { custom: 42 } });
  const service = new SocialAccountIdentityService(db as any);
  const resolve = (extra = {}) => db.$transaction((tx: any) => service.resolveIn(tx, 'org', 'linkedin',
    'linkedin.fs_miniProfile', browserId, { source: 'EXTENSION', canCreate: true, maxChannels: 2, handle, ...extra }));
  const confirm = () => resolve({ extensionRecovery: {
    integrationId: 'old', verifiedByUserId: 'admin', probeId: 'fresh-proof',
  } });
  return { db, resolve, confirm };
}

describe('legacy LinkedIn OAuth/browser identity recovery', () => {
  it('offers an explicit recovery candidate without changing or creating accounts on refresh', async () => {
    const f = fixture();
    const before = structuredClone(f.db.rows('integration'));
    expect(await f.resolve()).toMatchObject({ blockCode: 'ACCOUNT_PROFILE_CONFLICT',
      recovery: { integrationId: 'old', action: 'VERIFY_LEGACY', name: 'Custom name' } });
    expect(f.db.rows('integration')).toEqual(before);
  });

  it('replaces the retired OAuth ID in place while preserving credentials, history and bindings', async () => {
    const f = fixture();
    f.db.seed('post', { id: 'historical-post', organizationId: 'org', integrationId: 'old' });
    f.db.seed('projectSendBinding', { id: 'binding', organizationId: 'org', integrationId: 'old' });
    const history = structuredClone({ posts: f.db.rows('post'), bindings: f.db.rows('projectSendBinding') });
    const result = await f.confirm();
    expect(result.account).toMatchObject({ id: 'old', internalId: browserId,
      identityNamespace: 'linkedin.fs_miniProfile', token: 'old-token', refreshToken: 'old-refresh',
      metadata: { custom: 42, identityAudit: { method: 'EXPLICIT_EXTENSION_RECOVERY', verifiedByUserId: 'admin' } } });
    expect(f.db.rows('integration')).toHaveLength(1);
    expect({ posts: f.db.rows('post'), bindings: f.db.rows('projectSendBinding') }).toEqual(history);
    expect((await f.resolve()).account?.id).toBe('old');
  });

  it.each(['ambiguous', 'stable-browser', 'deleted', 'other-organization'])(
    'does not suggest an incompatible legacy OAuth recovery: %s', async kind => {
      const f = fixture(); const old = f.db.rows('integration')[0];
      if (kind === 'ambiguous') f.db.seed('integration', { ...old, id: 'duplicate' });
      if (kind === 'stable-browser') old.identityNamespace = 'linkedin.fs_miniProfile';
      if (kind === 'deleted') old.deletedAt = new Date();
      if (kind === 'other-organization') old.organizationId = 'other';
      expect((await f.resolve()).recovery).toBeUndefined();
      expect((await f.confirm()).blockCode).toBe('ACCOUNT_RECOVERY_CHANGED');
    });

  it.each(['sendIntent', 'accountWriteState'])('protects identity already referenced by %s', async table => {
    const f = fixture(); f.db.seed(table, { organizationId: 'org', integrationId: 'old' });
    expect(await f.confirm()).toMatchObject({ blockCode: 'ACCOUNT_IDENTITY_IN_USE' });
    expect(f.db.rows('integration')[0].internalId).toBe(oauthId);
  });

  it('continues to block another canonical account owning the profile', async () => {
    const f = fixture();
    f.db.seed('integration', { ...f.db.rows('integration')[0], id: 'canonical',
      identityNamespace: 'linkedin.fs_miniProfile', internalId: 'ACoOther' });
    expect(await f.confirm()).toMatchObject({ blockCode: 'ACCOUNT_PROFILE_CONFLICT' });
    expect(f.db.rows('integration')[0].internalId).toBe(oauthId);
  });

  it('never auto-recovers different LinkedIn IDs, even for an administrator', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
    const f = fixture();
    f.db.seed('settings', { key: 'sending.organization_mode:org', value: { mode: 'CONTROLLED', revision: 1 } });
    f.db.seed('userOrganization', { organizationId: 'org', userId: 'admin', role: 'ADMIN', disabled: false });
    f.db.seed('extensionNode', { id: 'node', organizationId: 'org', status: 'ACTIVE', lastReportSequence: 0 });
    const service = new ExtensionNodeService(f.db as any);
    vi.spyOn(service, 'authenticateIn').mockImplementation(async () => f.db.rows('extensionNode')[0]);
    const report = (confirm: boolean, sequence: number) => service.report('org', 'admin', 'node', 'token', {
      checkedAt: new Date().toISOString(), reportSequence: sequence, platforms: [{
        platform: 'linkedin', identityNamespace: 'linkedin.fs_miniProfile', id: browserId, handle,
        loggedIn: true, verificationStatus: 'VERIFIED', evidenceKind: 'LIVE_PAGE_ACTOR',
        identityObservedAt: new Date().toISOString(), probeId: crypto.randomUUID(),
        ...(confirm ? { accountRecovery: { integrationId: 'old', confirmed: true } } : {}),
      }],
    } as any, { canCreateChannels: true, maxChannels: 2 });
    const observed: any = await report(false, 1);
    expect(observed.results[0]).toMatchObject({ integrationId: null, blockCode: 'ACCOUNT_PROFILE_CONFLICT',
      recovery: { integrationId: 'old', action: 'VERIFY_LEGACY' } });
    expect(f.db.rows('integration')[0].internalId).toBe(oauthId);
    const confirmed: any = await report(true, 2);
    expect(confirmed.results[0]).toMatchObject({ integrationId: 'old', verificationStatus: 'VERIFIED' });
    expect(f.db.rows('integration')[0]).toMatchObject({ internalId: browserId, identityNamespace: 'linkedin.fs_miniProfile' });
  });
});

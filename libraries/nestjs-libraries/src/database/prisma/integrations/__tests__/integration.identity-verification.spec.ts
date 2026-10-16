import { beforeEach, afterEach } from 'vitest';
beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());
import { describe, expect, it, vi } from 'vitest';
import { IntegrationRepository } from '../integration.repository';
import { SocialAccountIdentityService } from '../../../../extension/social-account-identity.service';
import { memorySendDatabase } from '../../../../extension/__tests__/support/memory-send-database';
function fixture() {
  const db = memorySendDatabase();
  db.seed('userOrganization', {
    userId: 'admin',
    organizationId: 'org',
    role: 'ADMIN',
    disabled: false,
  });
  db.seed('integration', {
    id: 'old',
    organizationId: 'org',
    providerIdentifier: 'x',
    identityNamespace: 'legacy',
    internalId: '123',
    token: 'old-token',
    refreshToken: 'old-refresh',
    name: 'custom',
  });
  const repository = new IntegrationRepository(
    { model: db } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  const probe = vi.fn(async () => ({ id: '123', idNamespace: 'x.rest_id' }));
  const verify = () =>
    repository.verifyStableIdentity('org', 'admin', 'old', probe);
  return { db, repository, probe, verify };
}
describe('protected legacy OAuth identity verification', () => {
  it('uses a live credential probe to normalize the same row and lets a terminal reuse it', async () => {
    const f = fixture();
    const projection = await f.verify();
    expect(projection).toEqual({
      integrationId: 'old',
      platform: 'x',
      identityNamespace: 'x.rest_id',
      internalId: '123',
    });
    expect(f.probe).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'old-token' })
    );
    const matched = await new SocialAccountIdentityService(f.db as any).resolve(
      'org',
      'x',
      'x.rest_id',
      '123',
      { source: 'EXTENSION', canCreate: false }
    );
    expect(matched.account).toMatchObject({
      id: 'old',
      token: 'old-token',
      refreshToken: 'old-refresh',
      name: 'custom',
    });
    expect(await f.verify()).toEqual(projection);
    expect(f.db.rows('integration')).toHaveLength(1);
    expect(f.db.rows('integration')[0].metadata.identityAudit).toMatchObject({
      method: 'OAUTH_CREDENTIAL_PROBE',
      verifiedByUserId: 'admin',
      id: '123',
    });
  });
  it('refuses to reinterpret a legacy numeric handle as another stable actor', async () => {
    const f = fixture();
    f.probe.mockResolvedValue({ id: '456', idNamespace: 'x.rest_id' });
    await expect(f.verify()).rejects.toThrow('ACCOUNT_IDENTITY_MISMATCH');
    expect(f.db.rows('integration')[0].identityNamespace).toBe('legacy');
  });
  it.each(['USER', 'DISABLED', 'MISSING'])(
    'requires an active organization administrator before probing: %s',
    async (permission) => {
      const f = fixture();
      if (permission === 'USER') f.db.rows('userOrganization')[0].role = 'USER';
      if (permission === 'DISABLED')
        f.db.rows('userOrganization')[0].disabled = true;
      if (permission === 'MISSING') f.db.rows('userOrganization').length = 0;
      await expect(f.verify()).rejects.toThrow(
        'ACCOUNT_IDENTITY_ADMIN_REQUIRED'
      );
      expect(f.probe).not.toHaveBeenCalled();
    }
  );
  it('rejects stale proof if credentials change while the remote probe is running', async () => {
    const f = fixture();
    f.probe.mockImplementation(async () => {
      f.db.rows('integration')[0].token = 'changed';
      return { id: '123', idNamespace: 'x.rest_id' };
    });
    await expect(f.verify()).rejects.toThrow('ACCOUNT_IDENTITY_CHANGED');
    expect(f.db.rows('integration')[0].identityNamespace).toBe('legacy');
  });
  it('does not reinterpret an identity with existing coordinated work', async () => {
    const f = fixture();
    f.db.seed('sendIntent', { organizationId: 'org', integrationId: 'old' });
    await expect(f.verify()).rejects.toThrow('ACCOUNT_IDENTITY_IN_USE');
  });
  it('does not merge duplicate rows or expose failed credential details', async () => {
    const f = fixture();
    f.db.seed('integration', {
      id: 'other',
      organizationId: 'org',
      providerIdentifier: 'x',
      identityNamespace: 'x.rest_id',
      internalId: '123',
    });
    await expect(f.verify()).rejects.toThrow('ACCOUNT_IDENTITY_CONFLICT');
    const g = fixture();
    g.probe.mockRejectedValue(new Error('private upstream detail'));
    await expect(g.verify()).rejects.toThrow(
      'ACCOUNT_IDENTITY_VERIFICATION_FAILED'
    );
    expect(g.db.rows('integration')[0].identityNamespace).toBe('legacy');
  });
  it('refuses session-only rows without attempting an OAuth probe', async () => {
    const f = fixture();
    f.db.rows('integration')[0].token = '';
    await expect(f.verify()).rejects.toThrow(
      'ACCOUNT_IDENTITY_VERIFICATION_UNAVAILABLE'
    );
    expect(f.probe).not.toHaveBeenCalled();
  });
});

it('normalizes an audited legacy LinkedIn page and reuses it from a browser without a second actor row', async () => {
  const f = fixture();
  f.db.rows('integration')[0].providerIdentifier = 'linkedin-page';
  f.probe.mockResolvedValue({ id: '123', idNamespace: 'linkedin.organization_id' });
  expect(await f.verify()).toMatchObject({ integrationId: 'old', platform: 'linkedin-page', identityNamespace: 'linkedin.organization_id' });
  const browser = await new SocialAccountIdentityService(f.db as any).resolve('org', 'linkedin-page', 'linkedin.organization_id', '123', { source: 'EXTENSION', canCreate: false });
  expect(browser.account?.id).toBe('old');
  expect(f.db.rows('integration')).toHaveLength(1);
});

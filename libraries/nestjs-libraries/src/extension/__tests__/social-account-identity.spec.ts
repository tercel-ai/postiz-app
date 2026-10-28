import { sendHash } from '../send-coordination.utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SocialAccountIdentityService } from '../social-account-identity.service';
import { memorySendDatabase } from './support/memory-send-database';

const options = {
  source: 'EXTENSION' as const,
  canCreate: true,
  maxChannels: 2,
  handle: 'alice',
};
function fixture() {
  const db = memorySendDatabase();
  const service = new SocialAccountIdentityService(db as any);
  const resolve = (
    platform = 'x',
    namespace = 'x.rest_id',
    id = '123',
    extra = {}
  ) =>
    db.$transaction((tx: any) =>
      service.resolveIn(tx, 'org', platform, namespace, id, {
        ...options,
        ...extra,
      })
    );
  return { db, service, resolve };
}
describe('shared stable social actor identity', () => {
  it('registers a dotted Medium handle and matches its existing account on later reports', async () => {
    const f = fixture();
    const first = await f.resolve('medium', 'medium.handle', 'tercel.yi', { handle: 'tercel.yi' });
    expect(first).toMatchObject({ registrationStatus: 'CREATED', account: {
      providerIdentifier: 'medium', identityNamespace: 'medium.handle', internalId: 'tercel.yi', profile: 'tercel.yi',
    } });
    const second = await f.resolve('medium', 'medium.handle', 'tercel.yi', { handle: 'tercel.yi' });
    expect(second).toMatchObject({ registrationStatus: 'EXISTING', account: { id: first.account!.id } });
    expect(f.db.rows('integration')).toHaveLength(1);
  });
  it.each(['alice/bob', 'alice?other=bob', 'alice#bob', 'alice%2ebob'])('rejects Medium path or URL syntax in the identity: %s', async id => {
    const f = fixture();
    expect(await f.resolve('medium', 'medium.handle', id)).toMatchObject({ blockCode: 'ACCOUNT_IDENTITY_UNRESOLVED' });
    expect(f.db.rows('integration')).toHaveLength(0);
  });
  it('promotes a uniquely matching legacy OAuth row in place without overwriting credentials or custom state', async () => {
    const f = fixture();
    f.db.seed('integration', {
      id: 'oauth-row',
      organizationId: 'org',
      providerIdentifier: 'x',
      identityNamespace: 'legacy',
      internalId: '123',
      token: 'secret',
      refreshToken: 'refresh',
      name: 'custom',
      disabled: true,
      metadata: { custom: 42 },
    });
    const result = await f.resolve('x', 'x.rest_id', '123', {
      source: 'OAUTH',
      legacyProof: {
        integrationId: 'oauth-row',
        credentialHash: sendHash(['secret', 'refresh']),
      },
    });
    expect(result).toMatchObject({
      registrationStatus: 'EXISTING',
      account: {
        id: 'oauth-row',
        identityNamespace: 'x.rest_id',
        internalId: '123',
        token: 'secret',
        refreshToken: 'refresh',
        name: 'custom',
        disabled: true,
        metadata: { custom: 42 },
      },
    });
    expect(f.db.rows('integration')).toHaveLength(1);
  });
  it('normalizes Reddit fullnames and case but never lowercases arbitrary provider IDs', async () => {
    const f = fixture();
    f.db.seed('integration', {
      id: 'reddit-row',
      organizationId: 'org',
      providerIdentifier: 'reddit',
      identityNamespace: 'legacy',
      internalId: 't2_AbC123',
      token: 'oauth',
    });
    expect(
      (
        await f.resolve('reddit', 'reddit.user_id', 'ABC123', {
          source: 'OAUTH',
          legacyProof: {
            integrationId: 'reddit-row',
            credentialHash: sendHash(['oauth', undefined]),
          },
        })
      ).account
    ).toMatchObject({
      id: 'reddit-row',
      internalId: 'abc123',
      identityNamespace: 'reddit.user_id',
    });
    expect(
      (await f.resolve('linkedin', 'linkedin.member_id', 'ABC123')).blockCode
    ).toBe('ACCOUNT_IDENTITY_UNRESOLVED');
  });
  it('creates one session-only account across concurrent terminal reports', async () => {
    const f = fixture();
    const results = await Promise.all([f.resolve(), f.resolve()]);
    expect(results.map((r) => r.account?.id)[0]).toBe(results[1].account?.id);
    expect(f.db.rows('integration')).toHaveLength(1);
    expect(f.db.rows('integration')[0]).toMatchObject({
      token: '',
      refreshToken: '',
      tokenExpiration: null,
      metadata: { credentialSource: 'SESSION_ONLY' },
    });
  });
  it('allows a second actor on the same platform and atomically respects the creation cap', async () => {
    const f = fixture();
    await f.resolve();
    const results = await Promise.all([
      f.resolve('x', 'x.rest_id', '456', { handle: 'bob' }),
      f.resolve('x', 'x.rest_id', '789', { handle: 'carol' }),
    ]);
    expect(results.filter((r) => r.account)).toHaveLength(1);
    expect(results.find((r) => r.blockCode)?.blockCode).toBe(
      'ACCOUNT_CHANNEL_LIMIT'
    );
    expect(f.db.rows('integration')).toHaveLength(2);
  });
  it('matches an existing actor even when creating another account is forbidden', async () => {
    const f = fixture();
    const first = await f.resolve();
    expect(
      (
        await f.resolve('x', 'x.rest_id', '123', {
          canCreate: false,
          maxChannels: 0,
        })
      ).account?.id
    ).toBe(first.account?.id);
    expect(
      (await f.resolve('x', 'x.rest_id', '456', { canCreate: false, handle: 'bob' })).blockCode
    ).toBe('ACCOUNT_CREATION_NOT_ALLOWED');
  });
  it('blocks a reused profile without merging different stable IDs', async () => {
    const f = fixture();
    const first = await f.resolve();
    const second = await f.resolve('x', 'x.rest_id', '456');
    expect(second).toEqual({ blockCode: 'ACCOUNT_PROFILE_CONFLICT' });
    expect(f.db.rows('integration')).toHaveLength(1);
    expect(f.db.rows('integration')[0].id).toBe(first.account?.id);
    expect(f.db.rows('integration')[0].internalId).toBe('123');
  });
  it('blocks a normalized profile collision with an unresolved old account', async () => {
    const f = fixture();
    f.db.seed('integration', {
      id: 'old', organizationId: 'org', providerIdentifier: 'x', type: 'social',
      identityNamespace: 'legacy', internalId: 'unknown', profile: ' @ALICE ',
    });
    expect(await f.resolve()).toEqual({ blockCode: 'ACCOUNT_PROFILE_CONFLICT' });
    expect(f.db.rows('integration')).toHaveLength(1);
    expect(f.db.rows('integration')[0].identityNamespace).toBe('legacy');
  });
  it('keeps an existing stable identity refresh working while old profile duplicates await cleanup', async () => {
    const f = fixture();
    const first = await f.resolve();
    f.db.seed('integration', {
      id: 'old-duplicate', organizationId: 'org', providerIdentifier: 'x', type: 'social',
      identityNamespace: 'legacy', internalId: 'old-handle', profile: '@Alice',
    });
    expect(await f.resolve('x', 'x.rest_id', '123', { handle: '@ALICE' }))
      .toMatchObject({ registrationStatus: 'EXISTING', account: { id: first.account!.id } });
    expect(f.db.rows('integration')).toHaveLength(2);
    expect(f.db.rows('integration').find(row => row.id === 'old-duplicate').identityNamespace).toBe('legacy');
  });
  it('blocks profile changes on an existing stable actor when another active actor owns that profile', async () => {
    const f = fixture();
    const first = await f.resolve();
    await f.resolve('x', 'x.rest_id', '456', { handle: 'bob' });
    expect(await f.resolve('x', 'x.rest_id', '123', { handle: '@BOB' }))
      .toEqual({ blockCode: 'ACCOUNT_PROFILE_CONFLICT' });
    expect(f.db.rows('integration').find(row => row.id === first.account?.id).profile).toBe('alice');
  });
  it('does not let deleted profiles reserve a handle or auto-restore a different identity', async () => {
    const f = fixture();
    const first = await f.resolve();
    f.db.rows('integration')[0].deletedAt = new Date();
    const second = await f.resolve('x', 'x.rest_id', '456');
    expect(second.account?.id).not.toBe(first.account?.id);
    expect(second.account?.profile).toBe('alice');
    expect(f.db.rows('integration')[0].deletedAt).not.toBeNull();
  });
  it('isolates ambiguous duplicates and different namespaces instead of choosing a row', async () => {
    const f = fixture();
    f.db.seed('integration', {
      id: 'legacy',
      organizationId: 'org',
      providerIdentifier: 'x',
      identityNamespace: 'legacy',
      internalId: '123',
    });
    f.db.seed('integration', {
      id: 'canonical',
      organizationId: 'org',
      providerIdentifier: 'x',
      identityNamespace: 'x.rest_id',
      internalId: '123',
    });
    expect((await f.resolve()).blockCode).toBe('ACCOUNT_IDENTITY_CONFLICT');
    expect((await f.resolve('x', 'x.handle', 'alice')).blockCode).toBe(
      'ACCOUNT_IDENTITY_UNRESOLVED'
    );
    expect(f.db.rows('integration')).toHaveLength(2);
  });
  it('does not reinterpret a legacy identity already referenced by coordinated execution', async () => {
    const f = fixture();
    f.db.seed('integration', {
      id: 'old',
      organizationId: 'org',
      providerIdentifier: 'x',
      identityNamespace: 'legacy',
      internalId: '123',
    });
    f.db.seed('sendIntent', { organizationId: 'org', integrationId: 'old' });
    expect(
      (
        await f.resolve('x', 'x.rest_id', '123', {
          source: 'OAUTH',
          legacyProof: {
            integrationId: 'old',
            credentialHash: sendHash([undefined, undefined]),
          },
        })
      ).blockCode
    ).toBe('ACCOUNT_IDENTITY_IN_USE');
    expect(f.db.rows('integration')[0].identityNamespace).toBe('legacy');
  });
  it('keeps organizations and providers isolated and does not revive deleted actors', async () => {
    const f = fixture();
    f.db.seed('integration', {
      id: 'other',
      organizationId: 'other',
      providerIdentifier: 'x',
      identityNamespace: 'x.rest_id',
      internalId: '123',
    });
    expect((await f.resolve()).account?.id).not.toBe('other');
    f.db.rows('integration').find((r) => r.organizationId === 'org').deletedAt =
      new Date();
    expect((await f.resolve()).blockCode).toBe('ACCOUNT_DELETED');
  });
  it.each(['', 'alice', '1e9', '00123'])(
    'rejects an invalid X platform ID: %s',
    async (id) => {
      const f = fixture();
      expect((await f.resolve('x', 'x.rest_id', id)).blockCode).toBe(
        'ACCOUNT_IDENTITY_UNRESOLVED'
      );
    }
  );
});

afterEach(() => vi.unstubAllEnvs());
it('rejects invalid creation limits and requires an explicit creation entitlement', async () => {
  const f = fixture();
  expect(
    (await f.resolve('x', 'x.rest_id', '123', { maxChannels: -1 })).blockCode
  ).toBe('ACCOUNT_CHANNEL_LIMIT_INVALID');
  expect(
    (await f.resolve('x', 'x.rest_id', '123', { maxChannels: undefined }))
      .blockCode
  ).toBe('ACCOUNT_CREATION_NOT_ALLOWED');
});
it('keeps expand compatibility until the legacy key is explicitly contracted', async () => {
  const f = fixture();
  f.db.seed('integration', {
    id: 'reddit',
    organizationId: 'org',
    providerIdentifier: 'reddit',
    identityNamespace: 'reddit.user_id',
    internalId: '123',
  });
  expect((await f.resolve()).blockCode).toBe('ACCOUNT_LEGACY_KEY_CONFLICT');
  f.db.identitySchema.legacyKey = false;
  expect(
    (
      await f.service.resolve('org', 'x', 'x.rest_id', '123', {
        ...options,
        maxChannels: null,
      })
    ).account?.providerIdentifier
  ).toBe('x');
});
it('does not create a parallel actor from a conflicting ID namespace', async () => {
  const f = fixture();
  f.db.seed('integration', {
    id: 'other-space',
    organizationId: 'org',
    providerIdentifier: 'x',
    identityNamespace: 'x.unknown',
    internalId: '123',
  });
  expect((await f.resolve()).blockCode).toBe('ACCOUNT_IDENTITY_UNRESOLVED');
  expect(f.db.rows('integration')).toHaveLength(1);
});
it('does not infer that a legacy numeric handle is a verified platform ID', async () => {
  const f = fixture();
  f.db.seed('integration', {
    id: 'old',
    organizationId: 'org',
    providerIdentifier: 'x',
    identityNamespace: 'legacy',
    internalId: '123',
    token: '123',
    profile: '123',
  });
  expect((await f.resolve()).blockCode).toBe('ACCOUNT_IDENTITY_UNRESOLVED');
  expect(f.db.rows('integration')[0].identityNamespace).toBe('legacy');
});

it('uses the same canonical key for Reddit bare IDs and case-insensitive fullnames', async () => {
  const { canonicalSendAccount, matchesSendActor } = await import(
    '../send-coordination.utils'
  );
  expect(
    canonicalSendAccount('org', 'reddit', 'reddit.user_id', 'T2_ABC')
  ).toBe(canonicalSendAccount('org', 'reddit', 'reddit.user_id', 'abc'));
  expect(
    matchesSendActor(
      { id: 'abc', idNamespace: 'reddit.user_id' },
      { id: 'T2_ABC', idNamespace: 'reddit.user_id' }
    )
  ).toBe(true);
});

it('never turns an absent Reddit ID into the string undefined',async()=>{
  const {stableSocialIdentity}=await import('../social-account-identity.service');
  expect(stableSocialIdentity('reddit','reddit.user_id',undefined as any)).toBeNull();
  expect(stableSocialIdentity('reddit','reddit.user_id','')).toBeNull();
});

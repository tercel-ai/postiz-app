import { describe, expect, it } from 'vitest';
import { SocialAccountIdentityService } from '../social-account-identity.service';
import { memorySendDatabase } from './support/memory-send-database';

const actors = [
  ['x', 'x.rest_id', '123', 'imported:old'],
  ['reddit', 'reddit.user_id', 'abc', 'imported:old'],
  ['linkedin', 'linkedin.fs_miniProfile', 'ACoAlice', 'RgOldOAuth'],
  ['linkedin-page', 'linkedin.organization_id', '123', 'imported:company'],
  ['medium', 'medium.handle', 'alice', 'imported:old'],
  ['quora', 'quora.user_id', '123', 'imported:old'],
  ['hackernews', 'hackernews.handle', 'alice', 'imported:old'],
  ['devto', 'devto.user_id', '123', 'imported:old'],
] as const;

function fixture(platform: string, namespace: string, id: string, oldId: string) {
  const db = memorySendDatabase();
  db.seed('integration', { id: 'old', organizationId: 'org', providerIdentifier: platform,
    type: 'social', identityNamespace: 'legacy', internalId: oldId, profile: ' @ALICE ',
    name: 'Custom name', token: 'credential', metadata: { custom: 42 } });
  const service = new SocialAccountIdentityService(db as any);
  const resolve = (extra = {}) => db.$transaction((tx: any) => service.resolveIn(tx, 'org', platform,
    namespace, id, { source: 'EXTENSION', canCreate: true, maxChannels: 2, handle: 'alice', ...extra }));
  const confirm = () => resolve({ extensionRecovery: {
    integrationId: 'old', verifiedByUserId: 'admin', probeId: 'live-proof',
  } });
  return { db, resolve, confirm };
}

describe('shared legacy profile recovery policy', () => {
  it.each(actors)('offers explicit recovery for an unresolved or incomparable legacy ID on %s', async (...actor) => {
    const f = fixture(...actor);
    f.db.seed('post', { id: 'historical-post', integrationId: 'old', content: 'Original content' });
    f.db.seed('integrationProject', { id: 'project-link', integrationId: 'old', projectId: 'project' });
    const before = structuredClone(f.db.rows('integration'));
    const history = structuredClone({ posts: f.db.rows('post'), projects: f.db.rows('integrationProject') });
    expect(await f.resolve()).toMatchObject({ blockCode: 'ACCOUNT_PROFILE_CONFLICT',
      recovery: { integrationId: 'old', action: 'VERIFY_LEGACY' } });
    expect(f.db.rows('integration')).toEqual(before);
    const result = await f.confirm();
    expect(result.account).toMatchObject({ id: 'old', internalId: actor[2], identityNamespace: actor[1],
      name: 'Custom name', token: 'credential', metadata: { custom: 42,
        identityAudit: { method: 'EXPLICIT_EXTENSION_RECOVERY', verifiedByUserId: 'admin' } } });
    expect(f.db.rows('integration')).toHaveLength(1);
    expect({ posts: f.db.rows('post'), projects: f.db.rows('integrationProject') }).toEqual(history);
    expect((await f.resolve()).account?.id).toBe('old');
  });

  it.each([
    ['x', 'x.rest_id', '123', '456'],
    ['reddit', 'reddit.user_id', 'abc', 't2_DEF'],
    ['linkedin-page', 'linkedin.organization_id', '123', '456'],
    ['medium', 'medium.handle', 'alice', 'bob'],
    ['quora', 'quora.user_id', '123', '456'],
    ['hackernews', 'hackernews.handle', 'alice', 'bob'],
    ['devto', 'devto.user_id', '123', '456'],
  ])('never replaces a different comparable platform ID on %s', async (...actor) => {
    const f = fixture(actor[0], actor[1], actor[2], actor[3]);
    expect((await f.resolve()).recovery).toBeUndefined();
    expect(await f.confirm()).toMatchObject({ blockCode: 'ACCOUNT_RECOVERY_CHANGED' });
    expect(f.db.rows('integration')[0].internalId).toBe(actor[3]);
  });

  it.each(actors)('keeps tenant, profile, ambiguity and canonical-identity guards on %s', async (...actor) => {
    for (const kind of ['foreign', 'other-profile', 'ambiguous', 'canonical', 'deleted']) {
      const f = fixture(...actor);
      const account = f.db.rows('integration')[0];
      if (kind === 'foreign') account.organizationId = 'other';
      if (kind === 'other-profile') account.profile = 'bob';
      if (kind === 'ambiguous') f.db.seed('integration', { ...account, id: 'duplicate' });
      if (kind === 'canonical') account.identityNamespace = actor[1];
      if (kind === 'deleted') account.deletedAt = new Date();
      expect((await f.resolve()).recovery, kind).toBeUndefined();
      expect(await f.confirm(), kind).toMatchObject({ blockCode: 'ACCOUNT_RECOVERY_CHANGED' });
      expect(f.db.rows('integration')[0].internalId, kind).toBe(actor[3]);
    }
  });

  it.each(actors)('keeps coordinated-work identity guards on %s', async (...actor) => {
    for (const table of ['sendIntent', 'accountWriteState']) {
      const f = fixture(...actor);
      f.db.seed(table, { organizationId: 'org', integrationId: 'old' });
      expect(await f.confirm()).toMatchObject({ blockCode: 'ACCOUNT_IDENTITY_IN_USE' });
      expect(f.db.rows('integration')[0].internalId).toBe(actor[3]);
    }
  });

  it.each(actors)('does not use an OAuth request or incomplete confirmation as browser proof on %s', async (...actor) => {
    const f = fixture(...actor);
    expect((await f.resolve({ source: 'OAUTH' })).recovery).toBeUndefined();
    expect((await f.resolve({ extensionRecovery: { integrationId: 'old', verifiedByUserId: '', probeId: '' } }))
      .blockCode).toBe('ACCOUNT_IDENTITY_UNRESOLVED');
    expect(f.db.rows('integration')[0].internalId).toBe(actor[3]);
  });
});


describe('recorded browser identity provenance', () => {
  it.each([
    { credentialSource: 'SESSION_ONLY' },
    { stableIdentity: { namespace: 'linkedin.fs_miniProfile', id: 'ACoPrevious' } },
  ])('does not replace a known LinkedIn browser identity: %j', async metadata => {
    const f = fixture('linkedin', 'linkedin.fs_miniProfile', 'ACoAlice', 'ACoPrevious');
    f.db.rows('integration')[0].metadata = metadata;
    expect((await f.resolve()).recovery).toBeUndefined();
    expect(await f.confirm()).toMatchObject({ blockCode: 'ACCOUNT_RECOVERY_CHANGED' });
    expect(f.db.rows('integration')[0].internalId).toBe('ACoPrevious');
  });
});

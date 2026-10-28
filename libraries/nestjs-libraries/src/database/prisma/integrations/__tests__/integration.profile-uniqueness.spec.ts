import { describe, expect, it, vi } from 'vitest';
import { IntegrationRepository } from '../integration.repository';
import { memorySendDatabase } from '../../../../extension/__tests__/support/memory-send-database';

function fixture() {
  const db = memorySendDatabase();
  const repository = new IntegrationRepository(
    { model: db } as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any
  );
  const seed = (data: Record<string, unknown>) => db.seed('integration', {
    organizationId: 'org', providerIdentifier: 'devto', type: 'social',
    identityNamespace: 'legacy', internalId: 'old', profile: '@Alice', ...data,
  });
  const connect = (username?: string, internalId = 'new', type: 'social' | 'article' = 'social') =>
    repository.createOrUpdateIntegration(undefined, false, 'org', 'Alice', undefined,
      type, internalId, 'devto', 'secret', '', 0, username);
  return { db, repository, seed, connect };
}

describe('active social profile uniqueness', () => {
  it('rejects a new identity using the normalized profile of an active account', async () => {
    const f = fixture(); f.seed({ id: 'original' });
    await expect(f.connect(' u/ALICE ')).rejects.toThrow('ACCOUNT_PROFILE_CONFLICT');
    expect(f.db.rows('integration')).toHaveLength(1);
    expect(f.db.rows('integration')[0].internalId).toBe('old');
  });

  it('keeps exact-identity reconnects and their settings on the same record', async () => {
    const f = fixture(); f.seed({ id: 'original' });
    expect((await f.connect('alice', 'old')).id).toBe('original');
    expect(f.db.rows('integration')).toHaveLength(1);
  });

  it('persists rotated credentials for an existing identity despite a pre-cleanup duplicate', async () => {
    const f = fixture();
    f.seed({ id: 'original', token: 'old-token' });
    f.seed({ id: 'preexisting-duplicate', internalId: 'different-id' });
    const result = await f.connect('alice', 'old');
    expect(result.id).toBe('original');
    expect(f.db.rows('integration').find(row => row.id === 'original').token).toBe('secret');
    expect(f.db.rows('integration').find(row => row.id === 'preexisting-duplicate').internalId).toBe('different-id');
  });

  it('allows an unchanged normalized profile in updates while historical duplicates await cleanup', async () => {
    const f = fixture();
    f.seed({ id: 'original' });
    f.seed({ id: 'preexisting-duplicate', internalId: 'different-id' });
    await expect(f.repository.updateIntegration('original', { profile: 'alice', token: 'rotated' }))
      .resolves.toMatchObject({ id: 'original', token: 'rotated' });
    await expect(f.repository.recordExtensionSession([
      { id: 'original', metadata: null },
    ], 'original', 'alice', new Date(), { profile: 'alice' })).resolves.toBeUndefined();
  });

  it('reserves the profile of disabled accounts until they are deleted', async () => {
    const f = fixture(); f.seed({ id: 'disabled', disabled: true });
    await expect(f.connect('alice')).rejects.toThrow('ACCOUNT_PROFILE_CONFLICT');
  });

  it('does not reserve profiles from deleted, other-organization or other-provider accounts', async () => {
    const f = fixture();
    f.seed({ id: 'deleted', deletedAt: new Date() });
    f.seed({ id: 'other-org', organizationId: 'another' });
    f.seed({ id: 'other-provider', providerIdentifier: 'linkedin-page' });
    f.seed({ id: 'article', type: 'article' });
    expect((await f.connect('alice')).internalId).toBe('new');
  });

  it('checks the retained profile when reconnect restores a deleted account without a username', async () => {
    const f = fixture();
    f.seed({ id: 'deleted', internalId: 'restored', deletedAt: new Date() });
    f.seed({ id: 'active' });
    await expect(f.connect(undefined, 'restored')).rejects.toThrow('ACCOUNT_PROFILE_CONFLICT');
    expect(f.db.rows('integration').find(row => row.id === 'deleted').deletedAt).not.toBeNull();
  });

  it('allows blank social profiles and article profiles', async () => {
    const f = fixture(); f.seed({ id: 'active' });
    await expect(f.connect(' @ ')).resolves.toBeDefined();
    await expect(f.connect('alice', 'article-new', 'article')).resolves.toBeDefined();
  });

  it('rejects colliding profile edits without changing either account', async () => {
    const f = fixture(); f.seed({ id: 'active' });
    f.seed({ id: 'edited', internalId: 'other', profile: 'bob' });
    await expect(f.repository.updateIntegration('edited', { profile: 'ALICE' }))
      .rejects.toThrow('ACCOUNT_PROFILE_CONFLICT');
    expect(f.db.rows('integration').find(row => row.id === 'edited').profile).toBe('bob');
  });

  it.each([
    [{ deletedAt: null }, { deletedAt: new Date() }],
    [{ organizationId: 'org' }, { organizationId: 'other' }],
    [{ providerIdentifier: 'devto' }, { providerIdentifier: 'other' }],
    [{ type: 'social' }, { type: 'article' }],
  ])('checks retained profiles when eligibility changes: %j', async (params, original) => {
    const f = fixture(); f.seed({ id: 'active' });
    f.seed({ id: 'edited', internalId: 'other', ...original });
    await expect(f.repository.updateIntegration('edited', params as any))
      .rejects.toThrow('ACCOUNT_PROFILE_CONFLICT');
  });

  it('permits deleting a duplicate and unrelated updates needed for cleanup', async () => {
    const f = fixture(); f.seed({ id: 'active' }); f.seed({ id: 'edited', internalId: 'other' });
    await expect(f.repository.updateIntegration('edited', { deletedAt: new Date() })).resolves.toBeDefined();
    await expect(f.repository.updateIntegration('active', { name: 'Renamed' })).resolves.toBeDefined();
  });

  it('rejects a session report that would rename a matched account to an occupied profile atomically', async () => {
    const f = fixture(); f.seed({ id: 'active' });
    f.seed({ id: 'matched', internalId: 'other', profile: 'bob', activeSessionClient: 'API' });
    await expect(f.repository.recordExtensionSession([
      { id: 'active', metadata: null }, { id: 'matched', metadata: null },
    ], 'matched', 'Alice', new Date(), { profile: '@Alice' }))
      .rejects.toThrow('ACCOUNT_PROFILE_CONFLICT');
    expect(f.db.rows('integration').find(row => row.id === 'matched').profile).toBe('bob');
    expect(f.db.rows('integration')[0].extensionSessionCheckedAt).toBeUndefined();
  });

  it('serializes concurrent profile claims and rejects the later identity', async () => {
    const f = fixture();
    const transaction = vi.spyOn(f.db, '$transaction');
    const results = await Promise.allSettled([f.connect('Alice', 'one'), f.connect('@alice', 'two')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(f.db.rows('integration')).toHaveLength(1);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });
});

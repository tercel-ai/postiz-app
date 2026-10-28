import { describe, expect, it, vi } from 'vitest';
import {
  analyzeProfiles,
  assertAuditDatabase,
  collectProfileAudit,
  parseOptions,
  type ProfileAccount,
} from './audit-integration-profiles';

const account = (id: string, extra: Partial<ProfileAccount> = {}): ProfileAccount => ({
  id,
  organizationId: 'org',
  providerIdentifier: 'x',
  name: id,
  profile: '0xabcc',
  internalId: id,
  identityNamespace: 'x.rest_id',
  disabled: false,
  deletedAt: null,
  ...extra,
});

describe('profile uniqueness audit', () => {
  it('groups normalized profiles without mistaking different stable IDs for one identity', () => {
    const result = analyzeProfiles([
      account('123', { profile: ' @0xAbcc ' }),
      account('456', { profile: '0xabcc' }),
    ]);
    expect(result.summary).toMatchObject({ duplicateGroups: 1, duplicateAccounts: 2 });
    expect(result.duplicates[0]).toMatchObject({
      organizationId: 'org', providerIdentifier: 'x', normalizedProfile: '0xabcc',
      identityComparison: 'DIFFERENT_IDENTITIES', nonDeletedAccounts: 2,
    });
    expect(result.duplicates[0].accounts.map(row => row.id)).toEqual(['123', '456']);
  });

  it('keeps organizations, providers, and LinkedIn actor types separate', () => {
    expect(analyzeProfiles([
      account('1'),
      account('2', { organizationId: 'other' }),
      account('3', { providerIdentifier: 'reddit' }),
      account('4', { providerIdentifier: 'linkedin' }),
      account('5', { providerIdentifier: 'linkedin-page' }),
    ]).duplicates).toEqual([]);
  });

  it('reports blank profiles separately instead of treating them as duplicates', () => {
    const result = analyzeProfiles([
      account('1', { profile: null }),
      account('2', { profile: '  ' }),
      account('3', { profile: '@' }),
      account('4', { profile: 'u/' }),
    ]);
    expect(result.duplicates).toEqual([]);
    expect(result.summary).toMatchObject({ scannedAccounts: 4, missingProfileAccounts: 4 });
    expect(result.missingProfiles.map(row => row.id)).toEqual(['1', '2', '3', '4']);
  });

  it('includes deleted and disabled rows and distinguishes historical collisions', () => {
    const deletedAt = new Date('2026-10-01T00:00:00Z');
    const result = analyzeProfiles([
      account('1'),
      account('2', { deletedAt, disabled: true }),
      account('3', { profile: 'old', deletedAt }),
      account('4', { profile: 'OLD', deletedAt }),
    ]);
    expect(result.summary).toMatchObject({
      duplicateGroups: 2, groupsWithMultipleNonDeletedAccounts: 0,
      groupsInvolvingDeletedAccounts: 2,
    });
    expect(result.duplicates[0].accounts[1]).toMatchObject({ disabled: true, deletedAt });
  });

  it('does not call legacy or missing identity fields verified', () => {
    const result = analyzeProfiles([
      account('1', { identityNamespace: 'legacy' }),
      account('2', { internalId: '' }),
      account('3', { identityNamespace: null }),
      account('4', { profile: 'different' }),
    ]);
    expect(result.summary.unresolvedIdentityAccounts).toBe(3);
    expect(result.unresolvedIdentities.map(row => row.id)).toEqual(['1', '2', '3']);
    expect(result.duplicates[0].identityComparison).toBe('UNRESOLVED_IDENTITY');
  });

  it('distinguishes equal canonical Reddit IDs from different namespaces', () => {
    expect(analyzeProfiles([
      account('1', { providerIdentifier: 'reddit', profile: 'u/Alice',
        identityNamespace: 'reddit.user_id', internalId: 'T2_ABC' }),
      account('2', { providerIdentifier: 'reddit', profile: 'alice',
        identityNamespace: 'reddit.user_id', internalId: 'abc' }),
    ]).duplicates[0].identityComparison).toBe('SAME_IDENTITY');
    expect(analyzeProfiles([
      account('1', { identityNamespace: 'x.rest_id', internalId: '123' }),
      account('2', { identityNamespace: 'x.other', internalId: '123' }),
    ]).duplicates[0].identityComparison).toBe('DIFFERENT_IDENTITIES');
  });
});

describe('read-only audit execution', () => {
  it.each([
    undefined, '', 'invalid', 'postgresql://user:secret@localhost/aisee_dev',
    'mysql://user:secret@localhost/aisee_postiz_dev',
  ])('rejects an absent, invalid or wrong database URL before connecting', value => {
    expect(() => assertAuditDatabase(value)).toThrow(/DATABASE_URL|aisee_postiz_dev/);
  });

  it('accepts only the expected Postiz database and never returns credentials', () => {
    expect(assertAuditDatabase('postgresql://user:secret@localhost/aisee_postiz_dev?schema=public'))
      .toBe('aisee_postiz_dev');
    expect(assertAuditDatabase('postgres://user:secret@localhost/aisee_postiz_dev'))
      .toBe('aisee_postiz_dev');
  });

  it('validates CLI filters and refuses write flags and unknown options', () => {
    expect(parseOptions([])).toEqual({ json: false, help: false });
    expect(parseOptions(['--org', 'org', '--platform', 'x', '--json']))
      .toEqual({ organizationId: 'org', platform: 'x', json: true, help: false });
    expect(parseOptions(['--help']).help).toBe(true);
    for (const args of [['--execute'], ['--org'], ['--platform', '--json'],
      ['--org', 'a', '--org', 'b'], ['--platfrom', 'x']]) {
      expect(() => parseOptions(args)).toThrow();
    }
  });

  it('uses only paginated findMany reads, intersects filters, and selects no credentials', async () => {
    const first = Array.from({ length: 500 }, (_, index) =>
      account(`id-${String(index).padStart(4, '0')}`, { profile: `handle-${index}` }));
    const last = account('id-0500', { profile: '@HANDLE-0' });
    const findMany = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce([last]);
    const result = await collectProfileAudit({ integration: { findMany } } as any,
      { organizationId: 'org', platform: 'x' });
    expect(result.summary.scannedAccounts).toBe(501);
    expect(result.summary.duplicateGroups).toBe(1);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { organizationId: 'org', providerIdentifier: 'x', type: 'social' },
      take: 500, orderBy: { id: 'asc' },
    });
    expect(findMany.mock.calls[1][0].where.id).toEqual({ gt: 'id-0499' });
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('deletedAt');
    expect(Object.keys(findMany.mock.calls[0][0].select).sort()).toEqual([
      'deletedAt', 'disabled', 'id', 'identityNamespace', 'internalId', 'name',
      'organizationId', 'profile', 'providerIdentifier',
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  analyzeLinkedinAccounts, parseOptions, validateDatabaseUrl,
  type AccountRow,
} from './diagnose-linkedin-profile';

const target = { id: 'ACoAlice', handle: 'alice' };
const row = (changes: Partial<AccountRow> = {}): AccountRow => ({
  id: 'old', organizationId: 'org', providerIdentifier: 'linkedin',
  type: 'social', profile: 'Alice', internalId: 'oauth-sub',
  identityNamespace: 'legacy', disabled: false, deletedAt: null, ...changes,
});

describe('LinkedIn profile diagnosis', () => {
  it('identifies a profile owner with an incompatible identity without merging it', () => {
    const report = analyzeLinkedinAccounts([row()], target, 'org')[0];
    expect(report.profileGate).toBe('ACCOUNT_PROFILE_CONFLICT');
    expect(report.conflictingIntegrationIds).toEqual(['old']);
    expect(report.matchedIntegrationId).toBeNull();
    expect(report.legacyRecoveryCandidateId).toBe('old');
    expect(report.legacyRecoveryEligibility).toBe('NOT_CHECKED');
    expect(report.nextStep).toContain('profile-only suggestion');
    expect(report.nextStep).toContain('Verify old account');
  });

  it('does not suggest a legacy recovery when matching profiles are ambiguous', () => {
    const report = analyzeLinkedinAccounts([row(), row({ id: 'duplicate' })], target, 'org')[0];
    expect(report.profileGate).toBe('ACCOUNT_PROFILE_CONFLICT');
    expect(report.legacyRecoveryCandidateId).toBeNull();
  });

  it('allows an unchanged stable claim even with historical active profile duplicates', () => {
    const reports = analyzeLinkedinAccounts([
      row(), row({ id: 'stable', internalId: target.id, identityNamespace: 'linkedin.fs_miniProfile' }),
    ], target, 'org');
    expect(reports[0].profileGate).toBe('NO_PROFILE_CONFLICT');
    expect(reports[0].matchedIntegrationId).toBe('stable');
    expect(reports[0].sameProfileIntegrationIds).toEqual(['old', 'stable']);
  });

  it('does not reserve deleted profiles but includes them as historical evidence', () => {
    const report = analyzeLinkedinAccounts([row({ deletedAt: '2026-01-01' })], target, 'org')[0];
    expect(report.profileGate).toBe('NO_PROFILE_CONFLICT');
    expect(report.conflictingIntegrationIds).toEqual([]);
    expect(report.relatedAccounts).toHaveLength(1);
  });

  it('keeps disabled profile reservations and normalizes display prefixes', () => {
    expect(analyzeLinkedinAccounts([row({ disabled: true, profile: ' @ALICE ' })], target, 'org')[0]
      .profileGate).toBe('ACCOUNT_PROFILE_CONFLICT');
  });

  it('checks profile uniqueness when restoring a stable account', () => {
    const report = analyzeLinkedinAccounts([
      row(), row({ id: 'stable', internalId: target.id, identityNamespace: 'linkedin.fs_miniProfile', deletedAt: '2026-01-01' }),
    ], target, 'org')[0];
    expect(report.profileGate).toBe('ACCOUNT_PROFILE_CONFLICT');
  });

  it('detects stable identity duplicates before checking profiles', () => {
    const report = analyzeLinkedinAccounts([
      row({ internalId: target.id }), row({ id: 'other', internalId: target.id, identityNamespace: 'linkedin.fs_miniProfile' }),
    ], target, 'org')[0];
    expect(report.profileGate).toBe('ACCOUNT_IDENTITY_CONFLICT');
  });

  it('does not compare equal IDs across namespaces', () => {
    const report = analyzeLinkedinAccounts([
      row({ internalId: target.id, identityNamespace: 'linkedin.oauth_sub' }),
    ], target, 'org')[0];
    expect(report.profileGate).toBe('ACCOUNT_IDENTITY_UNRESOLVED');
  });

  it('isolates organizations, excludes company accounts, and omits unrelated accounts', () => {
    const rows = [row(), row({ id: 'b', organizationId: 'org-b', profile: 'bob', internalId: target.id,
      identityNamespace: 'linkedin.fs_miniProfile' }), row({ id: 'company', providerIdentifier: 'linkedin-page' }),
      row({ id: 'unrelated', profile: 'carol', internalId: 'other' })];
    const reports = analyzeLinkedinAccounts(rows, target);
    expect(reports).toHaveLength(2);
    expect(reports[0].relatedAccounts.map(account => account.id)).toEqual(['old']);
    expect(reports[1].profileGate).toBe('NO_PROFILE_CONFLICT');
    expect(analyzeLinkedinAccounts(rows, target, 'org-c')[0].relatedAccounts).toEqual([]);
  });

  it('does not label missing data as a reproduced server conflict', () => {
    expect(analyzeLinkedinAccounts([], target)).toEqual([]);
    expect(analyzeLinkedinAccounts([], target, 'org')[0].profileGate).toBe('NO_PROFILE_CONFLICT');
  });
});

describe('diagnostic CLI guards', () => {
  it('parses explicit identity and optional organization', () => {
    expect(parseOptions(['--id', target.id, '--handle', '@alice', '--org', 'org']))
      .toMatchObject({ ...target, handle: '@alice', org: 'org' });
    expect(parseOptions(['--help']).help).toBe(true);
  });

  it.each([
    [], ['--id', 'bad/id', '--handle', 'alice'], ['--id', target.id],
    ['--id', target.id, '--handle', 'alice', '--apply'],
    ['--id', target.id, '--id', target.id, '--handle', 'alice'],
    ['--id', target.id, '--handle', 'alice', '--org'],
  ])('rejects invalid arguments: %j', (...args) => {
    expect(() => parseOptions(args as string[])).toThrow();
  });

  it('parses the configured database and never echoes credentials on rejection', () => {
    expect(validateDatabaseUrl('postgresql://user:secret@localhost/aisee_postiz')).toContain('/aisee_postiz?');
    expect(validateDatabaseUrl('postgresql://user:secret@localhost/aisee_postiz_dev')).toContain('connect_timeout=5');
    for (const url of ['bad', 'postgresql://user:secret@localhost/', 'https://host/aisee_postiz_dev']) {
      expect(() => validateDatabaseUrl(url)).toThrow('DATABASE_URL');
      try { validateDatabaseUrl(url); } catch (error) { expect(String(error)).not.toContain('secret'); }
    }
  });
});

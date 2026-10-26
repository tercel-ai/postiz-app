import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  databaseName,
  parseOptions,
  previewPlan,
  verifyThroughApi,
  collectCandidates,
} from './reconcile-legacy-identities';

describe('reconcile legacy identities CLI', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is preview-only by default and deduplicates user inputs', () => {
    expect(
      parseOptions(['--user', 'u1', '--users', 'u1,u2', '--org', 'org'])
    ).toMatchObject({
      apply: false,
      userIds: ['u1', 'u2'],
      organizationId: 'org',
      expectedDatabase: 'aisee_postiz_dev',
    });
  });

  it('requires the explicit apply flag before callers may mutate through the API', () => {
    expect(parseOptions(['--user', 'u1']).apply).toBe(false);
    expect(parseOptions(['--user', 'u1', '--apply']).apply).toBe(true);
  });

  it('supports an explicit all-user preview and individual social-account filters', () => {
    expect(parseOptions(['--all'])).toMatchObject({
      allUsers: true,
      apply: false,
    });
    expect(
      parseOptions(['--integration', 'a1', '--integrations', 'a1,a2'])
    ).toMatchObject({
      allUsers: false,
      integrationIds: ['a1', 'a2'],
      apply: false,
    });
  });

  it.each(
    [
      [],
      ['--all', '--user', 'u1'],
      ['--all', '--integration', 'a1'],
      ['--users'],
      ['--users', '--all'],
      ['--users', ','],
      ['--al'],
      ['--org', 'org1', '--org', 'org2'],
    ].map((argv) => ({ argv }))
  )('rejects ambiguous or missing targeting options: $argv', ({ argv }) => {
    expect(() => parseOptions(argv)).toThrow();
  });

  it('supports organization-only scope and intersecting user/account filters', () => {
    expect(parseOptions(['--org', 'org'])).toMatchObject({
      organizationId: 'org',
      allUsers: false,
    });
    expect(parseOptions(['--user', 'u1', '--integration', 'a1'])).toMatchObject(
      {
        userIds: ['u1'],
        integrationIds: ['a1'],
      }
    );
  });

  function database() {
    return {
      user: { findMany: vi.fn().mockResolvedValue([{ id: 'u1' }]) },
      integration: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'a1',
            organizationId: 'org1',
            providerIdentifier: 'x',
            token: 'secret',
          },
          {
            id: 'a2',
            organizationId: 'org2',
            providerIdentifier: 'reddit',
            token: 'secret',
          },
        ]),
      },
      userOrganization: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'm1', userId: 'admin1', organizationId: 'org1' },
          { id: 'm2', userId: 'admin2', organizationId: 'org2' },
        ]),
      },
      settings: {
        findMany: vi.fn().mockResolvedValue([
          {
            key: 'sending.organization_mode:org1',
            value: { mode: 'CONTROLLED', revision: 1 },
          },
          {
            key: 'sending.organization_mode:org2',
            value: { mode: 'CONTROLLED', revision: 2 },
          },
        ]),
      },
    };
  }

  it('discovers all users through organization ownership without requiring a user list', async () => {
    const db = database();
    const result = await collectCandidates(db as any, parseOptions(['--all']));

    expect(
      result.candidates.map((candidate) => candidate.integrationId)
    ).toEqual(['a1', 'a2']);
    expect(result.candidates[1]).toMatchObject({
      userId: 'admin2',
      membershipId: 'm2',
      organizationId: 'org2',
    });
    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(db.integration.findMany.mock.calls[0][0].where).toEqual({
      identityNamespace: 'legacy',
      deletedAt: null,
    });
    expect(db.userOrganization.findMany.mock.calls[0][0].where).toMatchObject({
      disabled: false,
      role: { in: ['ADMIN', 'SUPERADMIN'] },
      user: { activated: true },
    });
  });

  it('keeps selected users, organizations and social accounts in the same intersection', async () => {
    const db = database();
    db.integration.findMany.mockResolvedValueOnce([
      {
        id: 'a1',
        organizationId: 'org1',
        providerIdentifier: 'x',
        token: 'secret',
      },
    ]);
    const result = await collectCandidates(
      db as any,
      parseOptions([
        '--user',
        'u1',
        '--user',
        'missing',
        '--org',
        'org1',
        '--integrations',
        'a1,other',
      ])
    );

    expect(
      result.candidates.map((candidate) => candidate.integrationId)
    ).toEqual(['a1']);
    expect(result.missingUserIds).toEqual(['missing']);
    expect(result.unmatchedIntegrationIds).toEqual(['other']);
    expect(db.integration.findMany.mock.calls[0][0].where).toMatchObject({
      organizationId: 'org1',
      id: { in: ['a1', 'other'] },
      organization: {
        users: { some: { userId: { in: ['u1', 'missing'] }, disabled: false } },
      },
    });
  });

  it('reports organizations that are not controlled or have no active administrator', async () => {
    const db = database();
    db.settings.findMany.mockResolvedValueOnce([]);
    const autonomous = await collectCandidates(
      db as any,
      parseOptions(['--all'])
    );
    expect(autonomous.candidates).toEqual([]);
    expect(autonomous.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: 'a1',
          code: 'ORGANIZATION_NOT_CONTROLLED',
        }),
      ])
    );

    db.userOrganization.findMany.mockResolvedValueOnce([]);
    const noAdmin = await collectCandidates(db as any, parseOptions(['--all']));
    expect(noAdmin.candidates).toEqual([]);
    expect(noAdmin.skipped[0].code).toBe('ORGANIZATION_ADMIN_REQUIRED');
  });

  it('classifies OAuth-verifiable and session-only rows without exposing credentials', () => {
    expect(previewPlan({ providerIdentifier: 'x', token: 'secret' })).toEqual({
      action: 'VERIFY_OAUTH',
      reason: null,
    });
    expect(previewPlan({ providerIdentifier: 'quora', token: '' })).toEqual({
      action: 'WAIT_FOR_SESSION',
      reason: 'OAUTH_VERIFICATION_UNAVAILABLE',
    });
  });

  it('extracts and decodes the exact database name used by the safety guard', () => {
    expect(
      databaseName('postgresql://u:p@localhost:5432/aisee_postiz_dev')
    ).toBe('aisee_postiz_dev');
    expect(databaseName('not a url')).toBeNull();
  });

  it('uses the organization membership ID for protected API impersonation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'verified' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await verifyThroughApi('https://api.example.test/', 'token', {
      userId: 'user-id',
      membershipId: 'membership-id',
      organizationId: 'organization-id',
      integrationId: 'integration/id',
      providerIdentifier: 'x',
      token: 'oauth-token',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/integrations/integration%2Fid/identity/verify',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          showorg: 'organization-id',
          impersonate: 'membership-id',
        }),
      })
    );
  });
});

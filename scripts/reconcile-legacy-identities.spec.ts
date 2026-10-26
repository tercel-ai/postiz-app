import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  databaseName,
  parseOptions,
  previewPlan,
  verifyThroughApi,
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

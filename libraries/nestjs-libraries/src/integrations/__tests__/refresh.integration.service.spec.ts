import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RefreshIntegrationService,
  TransientRefreshError,
  isTransientRefreshError,
} from '../refresh.integration.service';

// ---------------------------------------------------------------------------
// isTransientRefreshError — classification matrix
// ---------------------------------------------------------------------------

describe('isTransientRefreshError', () => {
  it('classifies 5xx HTTP status as transient', () => {
    expect(isTransientRefreshError({ response: { status: 500 } })).toBe(true);
    expect(isTransientRefreshError({ response: { status: 502 } })).toBe(true);
    expect(isTransientRefreshError({ response: { status: 503 } })).toBe(true);
    expect(isTransientRefreshError({ response: { status: 504 } })).toBe(true);
    expect(isTransientRefreshError({ status: 599 })).toBe(true);
  });

  it('classifies 429 / 408 / 425 as transient', () => {
    expect(isTransientRefreshError({ response: { status: 429 } })).toBe(true);
    expect(isTransientRefreshError({ status: 408 })).toBe(true);
    expect(isTransientRefreshError({ statusCode: 425 })).toBe(true);
  });

  it('classifies other 4xx as permanent', () => {
    expect(isTransientRefreshError({ response: { status: 400 } })).toBe(false);
    expect(isTransientRefreshError({ response: { status: 401 } })).toBe(false);
    expect(isTransientRefreshError({ response: { status: 403 } })).toBe(false);
    expect(isTransientRefreshError({ status: 404 })).toBe(false);
  });

  it('classifies node network error codes as transient', () => {
    expect(isTransientRefreshError({ code: 'ECONNRESET' })).toBe(true);
    expect(isTransientRefreshError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isTransientRefreshError({ code: 'ENOTFOUND' })).toBe(true);
    expect(isTransientRefreshError({ code: 'EAI_AGAIN' })).toBe(true);
    expect(isTransientRefreshError({ code: 'UND_ERR_SOCKET' })).toBe(true);
  });

  it('classifies OAuth permanent error codes as permanent (overrides HTTP 5xx)', () => {
    // Some platforms return 500 with body { error: "invalid_grant" } — the
    // body wins because the token is genuinely revoked.
    expect(
      isTransientRefreshError({
        response: { status: 500, data: { error: 'invalid_grant' } },
      })
    ).toBe(false);
    expect(isTransientRefreshError({ data: { error: 'invalid_token' } })).toBe(false);
    expect(isTransientRefreshError({ error: 'unauthorized_client' })).toBe(false);
    expect(isTransientRefreshError({ body: { error: 'access_denied' } })).toBe(false);
  });

  it('classifies OAuth rate-limit error codes as transient', () => {
    expect(isTransientRefreshError({ data: { error: 'rate_limit' } })).toBe(true);
    expect(
      isTransientRefreshError({ data: { error: 'temporarily_unavailable' } })
    ).toBe(true);
  });

  it('classifies AbortError / TimeoutError by name as transient', () => {
    expect(isTransientRefreshError({ name: 'AbortError' })).toBe(true);
    expect(isTransientRefreshError({ name: 'TimeoutError' })).toBe(true);
  });

  it('defaults to permanent for unknown error shapes (conservative)', () => {
    expect(isTransientRefreshError({})).toBe(false);
    expect(isTransientRefreshError(null)).toBe(false);
    expect(isTransientRefreshError(undefined)).toBe(false);
    expect(isTransientRefreshError('string error')).toBe(false);
    expect(isTransientRefreshError(new Error('generic boom'))).toBe(false);
  });

  it('does not confuse HTTP status (number) with error code (string)', () => {
    // 401 as a number = HTTP status (permanent). "401" as a code string would
    // not match networkCodes and would be permanent. The number takes priority.
    expect(isTransientRefreshError({ code: 401 })).toBe(false);
    // String code that isn't in network whitelist → permanent.
    expect(isTransientRefreshError({ code: 'SOME_UNKNOWN_CODE' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RefreshIntegrationService.refresh — happy + sad paths
// ---------------------------------------------------------------------------

function buildService(overrides: {
  providerRefresh: (rt: string) => Promise<any>;
  isTokenPermanent?: (t: string) => boolean;
  reConnect?: undefined | ((root: string, internal: string, token: string) => Promise<any>);
}) {
  const refreshNeeded = vi.fn().mockResolvedValue(undefined);
  const informAboutRefreshError = vi.fn().mockResolvedValue(undefined);
  const disconnectChannel = vi.fn().mockResolvedValue(undefined);
  const createOrUpdateIntegration = vi.fn().mockResolvedValue(undefined);
  const setBetweenRefreshSteps = vi.fn().mockResolvedValue(undefined);
  // Default: re-read finds no concurrent winner, so the benign-race guard is
  // inert and permanent failures still flag refreshNeeded as before.
  const getByIdForAdmin = vi.fn().mockResolvedValue(undefined);

  const socialProvider: any = {
    refreshToken: overrides.providerRefresh,
    isTokenPermanent: overrides.isTokenPermanent,
    oneTimeToken: false,
    reConnect: overrides.reConnect,
    refreshWait: false,
  };

  const integrationManager: any = {
    getSocialIntegration: vi.fn().mockReturnValue(socialProvider),
  };

  const integrationService: any = {
    refreshNeeded,
    informAboutRefreshError,
    disconnectChannel,
    createOrUpdateIntegration,
    setBetweenRefreshSteps,
    getByIdForAdmin,
  };

  const temporalService: any = {
    client: { getRawClient: () => ({ workflow: { start: vi.fn() } }) },
  };

  const svc = new RefreshIntegrationService(
    integrationManager,
    integrationService,
    temporalService
  );

  return {
    svc,
    mocks: {
      refreshNeeded,
      informAboutRefreshError,
      disconnectChannel,
      createOrUpdateIntegration,
      setBetweenRefreshSteps,
      getByIdForAdmin,
    },
  };
}

function makeIntegration(overrides: Partial<any> = {}) {
  return {
    id: 'int-1',
    organizationId: 'org-1',
    providerIdentifier: 'x',
    name: 'Test',
    picture: 'pic.png',
    internalId: 'x-uid',
    rootInternalId: 'x-uid',
    token: 'access-token',
    refreshToken: 'refresh-token',
    refreshNeeded: false,
    disabled: false,
    inBetweenSteps: false,
    tokenExpiration: new Date(Date.now() + 60_000),
    deletedAt: null,
    ...overrides,
  } as any;
}

describe('RefreshIntegrationService.refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws TransientRefreshError on a transient platform error (5xx) — DOES NOT mark refreshNeeded', async () => {
    const { svc, mocks } = buildService({
      providerRefresh: vi.fn().mockRejectedValue({ response: { status: 503 } }),
    });

    await expect(svc.refresh(makeIntegration())).rejects.toBeInstanceOf(
      TransientRefreshError
    );

    // Critical: do NOT permanently break the integration on a transient blip.
    expect(mocks.refreshNeeded).not.toHaveBeenCalled();
    expect(mocks.disconnectChannel).not.toHaveBeenCalled();
    expect(mocks.informAboutRefreshError).not.toHaveBeenCalled();
  });

  it('throws TransientRefreshError on network error (ECONNRESET) — DOES NOT mark refreshNeeded', async () => {
    const { svc, mocks } = buildService({
      providerRefresh: vi.fn().mockRejectedValue({ code: 'ECONNRESET', message: 'reset' }),
    });

    await expect(svc.refresh(makeIntegration())).rejects.toBeInstanceOf(
      TransientRefreshError
    );
    expect(mocks.refreshNeeded).not.toHaveBeenCalled();
  });

  it('throws TransientRefreshError on 429 rate limit — DOES NOT mark refreshNeeded', async () => {
    const { svc, mocks } = buildService({
      providerRefresh: vi.fn().mockRejectedValue({ response: { status: 429 } }),
    });

    await expect(svc.refresh(makeIntegration())).rejects.toBeInstanceOf(
      TransientRefreshError
    );
    expect(mocks.refreshNeeded).not.toHaveBeenCalled();
  });

  it('marks refreshNeeded + disconnects when the REFRESH endpoint itself returns 401 (refresh_token expired)', async () => {
    // When the call to the platform's /oauth/token endpoint returns 401, it
    // means the refresh_token we sent is itself dead — the user must
    // re-authorize. isTransientRefreshError must classify this as permanent
    // (not transient) so refreshProcess sets refreshNeeded=true instead of
    // retrying forever.
    const { svc, mocks } = buildService({
      providerRefresh: vi.fn().mockRejectedValue({ response: { status: 401 } }),
    });

    const result = await svc.refresh(makeIntegration());
    expect(result).toBe(false);

    expect(mocks.refreshNeeded).toHaveBeenCalledOnce();
    expect(mocks.disconnectChannel).toHaveBeenCalledOnce();
    expect(mocks.informAboutRefreshError).toHaveBeenCalledOnce();
  });

  it('marks refreshNeeded + disconnects on invalid_grant (permanent revoke)', async () => {
    const { svc, mocks } = buildService({
      providerRefresh: vi
        .fn()
        .mockRejectedValue({ response: { status: 400, data: { error: 'invalid_grant' } } }),
    });

    const result = await svc.refresh(makeIntegration());
    expect(result).toBe(false);

    expect(mocks.refreshNeeded).toHaveBeenCalledOnce();
    expect(mocks.disconnectChannel).toHaveBeenCalledOnce();
    expect(mocks.informAboutRefreshError).toHaveBeenCalledOnce();
  });

  it('does NOT flag refreshNeeded on invalid_grant when a concurrent refresh already rotated the token (benign race)', async () => {
    // X refresh tokens are single-use: the LOSER of a concurrent refresh gets
    // invalid_grant even though the WINNER already saved a fresh token. The
    // re-read shows tokenExpiration advanced into the future + refreshNeeded
    // cleared, so we must NOT flag/disconnect a healthy account.
    const { svc, mocks } = buildService({
      providerRefresh: vi
        .fn()
        .mockRejectedValue({ response: { status: 400, data: { error: 'invalid_grant' } } }),
    });
    mocks.getByIdForAdmin.mockResolvedValue({
      id: 'int-1',
      refreshNeeded: false,
      tokenExpiration: new Date(Date.now() + 3_600_000),
    });

    const result = await svc.refresh(
      makeIntegration({ tokenExpiration: new Date(Date.now() - 1_000) })
    );
    expect(result).toBe(false);

    expect(mocks.refreshNeeded).not.toHaveBeenCalled();
    expect(mocks.disconnectChannel).not.toHaveBeenCalled();
    expect(mocks.informAboutRefreshError).not.toHaveBeenCalled();
  });

  it('STILL flags refreshNeeded on invalid_grant when the re-read shows no concurrent winner (real revoke)', async () => {
    // Genuine revoke: tokenExpiration did NOT advance, so the guard stays inert.
    const { svc, mocks } = buildService({
      providerRefresh: vi
        .fn()
        .mockRejectedValue({ response: { status: 400, data: { error: 'invalid_grant' } } }),
    });
    mocks.getByIdForAdmin.mockResolvedValue({
      id: 'int-1',
      refreshNeeded: false,
      tokenExpiration: new Date(Date.now() - 1_000), // unchanged / still expired
    });

    const result = await svc.refresh(
      makeIntegration({ tokenExpiration: new Date(Date.now() - 1_000) })
    );
    expect(result).toBe(false);

    expect(mocks.refreshNeeded).toHaveBeenCalledOnce();
    expect(mocks.disconnectChannel).toHaveBeenCalledOnce();
  });

  it('marks refreshNeeded + disconnects when provider returns falsy (no token)', async () => {
    const { svc, mocks } = buildService({
      providerRefresh: vi.fn().mockResolvedValue(false),
    });

    const result = await svc.refresh(makeIntegration());
    expect(result).toBe(false);
    expect(mocks.refreshNeeded).toHaveBeenCalledOnce();
    expect(mocks.disconnectChannel).toHaveBeenCalledOnce();
  });

  it('marks refreshNeeded on generic non-classifiable thrown error (conservative)', async () => {
    const { svc, mocks } = buildService({
      providerRefresh: vi.fn().mockRejectedValue(new Error('weird unknown failure')),
    });

    const result = await svc.refresh(makeIntegration());
    // Generic Error is treated as PERMANENT — falls through to refreshNeeded path.
    expect(result).toBe(false);
    expect(mocks.refreshNeeded).toHaveBeenCalledOnce();
  });

  it('returns false without side effects when token is permanent (OAuth 1.0a)', async () => {
    const providerRefresh = vi.fn();
    const { svc, mocks } = buildService({
      providerRefresh,
      isTokenPermanent: () => true,
    });

    const result = await svc.refresh(makeIntegration());
    expect(result).toBe(false);
    // No platform call, no refreshNeeded mutation.
    expect(providerRefresh).not.toHaveBeenCalled();
    expect(mocks.refreshNeeded).not.toHaveBeenCalled();
    expect(mocks.disconnectChannel).not.toHaveBeenCalled();
  });

  it('persists the new token on successful refresh', async () => {
    const { svc, mocks } = buildService({
      providerRefresh: vi.fn().mockResolvedValue({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresIn: 3600,
      }),
    });

    const result = await svc.refresh(makeIntegration());
    expect(result).toMatchObject({ accessToken: 'new-access' });
    expect(mocks.createOrUpdateIntegration).toHaveBeenCalledOnce();
    expect(mocks.refreshNeeded).not.toHaveBeenCalled();
    expect(mocks.disconnectChannel).not.toHaveBeenCalled();
  });
});

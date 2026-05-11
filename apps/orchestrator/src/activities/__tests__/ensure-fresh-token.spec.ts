import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PostActivity } from '../post.activity';
import { TransientRefreshError } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------
// ensureFreshToken touches three dependencies:
//   - _integrationService.getIntegrationById  (Prisma read)
//   - _integrationManager.getSocialIntegration (provider lookup, sync)
//   - _refreshIntegrationService.refresh (the actual OAuth refresh call)
//
// We mock all three. The activity instance is constructed with `as any`
// holes for the dependencies we don't exercise (postService, notification,
// webhook, temporal).

const FUTURE_60_MIN = new Date(Date.now() + 60 * 60 * 1000);
const FUTURE_5_MIN = new Date(Date.now() + 5 * 60 * 1000);

function makeIntegration(overrides: Partial<any> = {}) {
  return {
    id: 'int-1',
    organizationId: 'org-1',
    providerIdentifier: 'linkedin',
    name: 'Test LinkedIn',
    picture: 'pic.png',
    internalId: 'li-uid',
    rootInternalId: 'li-uid',
    token: 'access-token-current',
    refreshToken: 'refresh-token-current',
    refreshNeeded: false,
    disabled: false,
    inBetweenSteps: false,
    deletedAt: null,
    tokenExpiration: FUTURE_60_MIN,
    ...overrides,
  } as any;
}

function buildActivity(opts: {
  /** What getIntegrationById returns (1st = pre-refresh, 2nd = post-refresh) */
  freshIntegrations?: any[];
  socialProvider?: Partial<{
    refreshCron: boolean;
    refreshWait: boolean;
    isTokenPermanent: (token: string) => boolean;
  }>;
  refreshResult?: any | (() => Promise<any>) | (() => never);
}) {
  const freshQueue = (opts.freshIntegrations ?? [makeIntegration()]).slice();
  const getIntegrationById = vi.fn(async () => {
    return freshQueue.length > 1 ? freshQueue.shift() : freshQueue[0];
  });

  const socialProvider: any = {
    refreshCron: false,
    refreshWait: false,
    isTokenPermanent: undefined,
    ...opts.socialProvider,
  };

  const refresh = vi.fn(
    typeof opts.refreshResult === 'function'
      ? (opts.refreshResult as any)
      : async () => opts.refreshResult
  );

  const integrationManager = {
    getSocialIntegration: vi.fn().mockReturnValue(socialProvider),
  };

  const integrationService = { getIntegrationById };
  const refreshIntegrationService = {
    refresh,
    setBetweenSteps: vi.fn().mockResolvedValue(undefined),
  };

  const activity = new PostActivity(
    {} as any, // postService
    {} as any, // notificationService
    integrationManager as any,
    integrationService as any,
    refreshIntegrationService as any,
    {} as any, // webhookService
    {} as any // temporalService
  );

  return {
    activity,
    mocks: {
      getIntegrationById,
      refresh,
      setBetweenSteps: refreshIntegrationService.setBetweenSteps,
      getSocialIntegration: integrationManager.getSocialIntegration,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostActivity.ensureFreshToken', () => {
  let consoleSpy: { info: any; warn: any; error: any };

  beforeEach(() => {
    consoleSpy = {
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------- early-return guards --------

  it('returns null when integration is missing in DB', async () => {
    const { activity, mocks } = buildActivity({ freshIntegrations: [null] });
    const result = await activity.ensureFreshToken(makeIntegration());
    expect(result).toBeNull();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('returns null when integration is deleted/disabled/refreshNeeded', async () => {
    for (const state of [
      { deletedAt: new Date() },
      { disabled: true },
      { refreshNeeded: true },
    ]) {
      const { activity, mocks } = buildActivity({
        freshIntegrations: [makeIntegration(state)],
      });
      const result = await activity.ensureFreshToken(makeIntegration());
      expect(result).toBeNull();
      expect(mocks.refresh).not.toHaveBeenCalled();
    }
  });

  it('returns null when integration has no tokenExpiration (OAuth 1.0a permanent)', async () => {
    const { activity, mocks } = buildActivity({
      freshIntegrations: [makeIntegration({ tokenExpiration: null })],
    });
    const result = await activity.ensureFreshToken(makeIntegration());
    expect(result).toBeNull();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('returns null when inBetweenSteps is true (another refresh in flight — defer)', async () => {
    const { activity, mocks } = buildActivity({
      freshIntegrations: [makeIntegration({ inBetweenSteps: true })],
    });
    const result = await activity.ensureFreshToken(makeIntegration());
    expect(result).toBeNull();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('returns null when provider declares the token permanent', async () => {
    const { activity, mocks } = buildActivity({
      socialProvider: { isTokenPermanent: () => true },
    });
    const result = await activity.ensureFreshToken(makeIntegration());
    expect(result).toBeNull();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  // -------- the W1 race-prevention fix --------

  it('SKIPS refresh for refreshCron=true providers (Layer 1 owns this — prevents the race)', async () => {
    const fresh = makeIntegration({
      providerIdentifier: 'x',
      tokenExpiration: FUTURE_5_MIN, // would normally trigger refresh
    });
    const { activity, mocks } = buildActivity({
      freshIntegrations: [fresh],
      socialProvider: { refreshCron: true },
    });

    const result = await activity.ensureFreshToken(makeIntegration());

    // The fresh DB row is returned (so caller benefits from any concurrent
    // Layer-1 rotation), but refresh() is NEVER called from this path.
    expect(result).toEqual(fresh);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  // -------- happy path --------

  it('returns fresh DB row unchanged when token is comfortably fresh (msToExpiry > buffer)', async () => {
    const fresh = makeIntegration({ tokenExpiration: FUTURE_60_MIN });
    const { activity, mocks } = buildActivity({ freshIntegrations: [fresh] });

    const result = await activity.ensureFreshToken(makeIntegration(), 10 * 60 * 1000);

    expect(result).toEqual(fresh);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('refreshes when token expires within the buffer window; re-reads DB; logs success', async () => {
    const fresh = makeIntegration({ tokenExpiration: FUTURE_5_MIN });
    const refreshed = makeIntegration({
      token: 'access-token-NEW',
      tokenExpiration: new Date(Date.now() + 2 * 60 * 60 * 1000),
    });
    const { activity, mocks } = buildActivity({
      freshIntegrations: [fresh, refreshed],
      refreshResult: { accessToken: 'access-token-NEW', expiresIn: 7200 },
    });

    const result = await activity.ensureFreshToken(makeIntegration(), 10 * 60 * 1000);

    expect(mocks.refresh).toHaveBeenCalledOnce();
    // The post-refresh DB read returns the updated integration row.
    expect(result).toEqual(refreshed);
    expect(mocks.getIntegrationById).toHaveBeenCalledTimes(2);
    expect(console.info).toHaveBeenCalled();
  });

  // -------- the W3 best-effort fix: NEVER park on unknown error --------

  it('does NOT setBetweenSteps on transient errors (lets reactive 401 path handle)', async () => {
    const { activity, mocks } = buildActivity({
      freshIntegrations: [makeIntegration({ tokenExpiration: FUTURE_5_MIN })],
      refreshResult: () => {
        throw new TransientRefreshError('platform 503');
      },
    });

    const result = await activity.ensureFreshToken(makeIntegration(), 10 * 60 * 1000);

    expect(result).toBe(false);
    expect(mocks.setBetweenSteps).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('does NOT setBetweenSteps on UNKNOWN errors either — pre-flight is best-effort, must not disable healthy accounts', async () => {
    // This is the W3 fix: a Prisma blip / unexpected error must NOT cause
    // ensureFreshToken to disable an integration. Previously, anything that
    // wasn't a TransientRefreshError landed in setBetweenSteps.
    const { activity, mocks } = buildActivity({
      freshIntegrations: [makeIntegration({ tokenExpiration: FUTURE_5_MIN })],
      refreshResult: () => {
        throw new Error('Prisma P2024 connection pool timeout');
      },
    });

    const result = await activity.ensureFreshToken(makeIntegration(), 10 * 60 * 1000);

    expect(result).toBe(false);
    expect(mocks.setBetweenSteps).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('returns false (without crashing) when refresh returns falsy/no accessToken', async () => {
    const { activity, mocks } = buildActivity({
      freshIntegrations: [makeIntegration({ tokenExpiration: FUTURE_5_MIN })],
      refreshResult: false, // refreshProcess returned false (permanent failure already handled)
    });

    const result = await activity.ensureFreshToken(makeIntegration(), 10 * 60 * 1000);

    expect(result).toBe(false);
    expect(mocks.setBetweenSteps).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });
});

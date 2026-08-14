import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataTicksService } from '../data-ticks.service';
import { RefreshToken } from '@gitroom/nestjs-libraries/integrations/social.abstract';

vi.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {
    keys: vi.fn().mockResolvedValue([]),
    del: vi.fn().mockResolvedValue(0),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  },
}));

const ORG_ID = 'org-1';
const INT_ID = 'int-1';

// tokenExpiration far in the future: the proactive refresh never fires, which is
// exactly the production case — X answered 401 on a token the DB still believed
// was valid, so every sweep re-hit the platform with a dead token.
const INTEGRATION = {
  id: INT_ID,
  organizationId: ORG_ID,
  providerIdentifier: 'x',
  internalId: 'x-internal-1',
  token: 'dead-token',
  refreshToken: 'refresh-token',
  tokenExpiration: new Date('2099-01-01T00:00:00.000Z'),
  deletedAt: null,
  disabled: false,
  refreshNeeded: false,
} as any;

function createMocks(accountMetrics: ReturnType<typeof vi.fn>) {
  return {
    dataTicksRepository: {},
    dashboardRepository: {
      updateAccountMetrics: vi.fn().mockResolvedValue(undefined),
    },
    postsService: {},
    integrationManager: {
      getSocialIntegration: vi.fn().mockReturnValue({ accountMetrics }),
    },
    refreshIntegrationService: {
      refresh: vi.fn(),
    },
    postsRepository: {},
    postAnalyticsCredit: {},
  };
}

function createService(mocks: ReturnType<typeof createMocks>) {
  return new DataTicksService(
    mocks.dataTicksRepository as any,
    mocks.dashboardRepository as any,
    mocks.postsService as any,
    mocks.integrationManager as any,
    mocks.refreshIntegrationService as any,
    mocks.postsRepository as any,
    mocks.postAnalyticsCredit as any
  );
}

describe('DataTicksService.syncSingleAccountMetrics — dead token', () => {
  let accountMetrics: ReturnType<typeof vi.fn>;
  let mocks: ReturnType<typeof createMocks>;
  let service: DataTicksService;

  beforeEach(() => {
    vi.clearAllMocks();
    accountMetrics = vi.fn();
    mocks = createMocks(accountMetrics);
    service = createService(mocks);
  });

  it('refreshes reactively and retries once when the provider rejects the token', async () => {
    accountMetrics
      .mockRejectedValueOnce(new RefreshToken('x', '{}', '', 'X token expired'))
      .mockResolvedValueOnce({ followers: 42 });
    mocks.refreshIntegrationService.refresh.mockResolvedValue({
      accessToken: 'fresh-token',
    });

    const metrics = await service.syncSingleAccountMetrics(INTEGRATION);

    expect(metrics).toEqual({ followers: 42 });
    expect(mocks.refreshIntegrationService.refresh).toHaveBeenCalledWith(INTEGRATION);
    expect(accountMetrics).toHaveBeenNthCalledWith(2, 'x-internal-1', 'fresh-token');
    expect(mocks.dashboardRepository.updateAccountMetrics).toHaveBeenCalledWith(
      INT_ID,
      { followers: 42 }
    );
  });

  it('gives up quietly when the refresh returns no token', async () => {
    accountMetrics.mockRejectedValue(new RefreshToken('x', '{}', '', 'X token expired'));
    mocks.refreshIntegrationService.refresh.mockResolvedValue(false);

    const metrics = await service.syncSingleAccountMetrics(INTEGRATION);

    expect(metrics).toBeNull();
    expect(accountMetrics).toHaveBeenCalledTimes(1);
    expect(mocks.dashboardRepository.updateAccountMetrics).not.toHaveBeenCalled();
  });

  // The recovery itself must not escalate: a transient refresh failure, or a
  // retry that hits the same 401, still degrades to "no metrics this round".
  it('swallows a throwing refresh instead of failing the sync', async () => {
    accountMetrics.mockRejectedValue(new RefreshToken('x', '{}', '', 'X token expired'));
    mocks.refreshIntegrationService.refresh.mockRejectedValue(
      new Error('transient refresh failure')
    );

    await expect(service.syncSingleAccountMetrics(INTEGRATION)).resolves.toBeNull();
  });

  it('swallows a retry that is rejected again', async () => {
    accountMetrics.mockRejectedValue(new RefreshToken('x', '{}', '', 'X token expired'));
    mocks.refreshIntegrationService.refresh.mockResolvedValue({
      accessToken: 'fresh-token',
    });

    await expect(service.syncSingleAccountMetrics(INTEGRATION)).resolves.toBeNull();
    expect(accountMetrics).toHaveBeenCalledTimes(2);
  });

  // Without this guard a revoked channel re-enters the refresh path on EVERY
  // sweep, and each permanent failure notifies the user twice (by email too) —
  // forever, because disconnectChannel sets refreshNeeded, never `disabled`,
  // and neither sweep query filters it.
  it('skips an integration already flagged for reconnect', async () => {
    const metrics = await service.syncSingleAccountMetrics({
      ...INTEGRATION,
      refreshNeeded: true,
    });

    expect(metrics).toBeNull();
    expect(accountMetrics).not.toHaveBeenCalled();
    expect(mocks.refreshIntegrationService.refresh).not.toHaveBeenCalled();
  });

  it('propagates non-auth provider errors untouched', async () => {
    accountMetrics.mockRejectedValue(new Error('platform 500'));

    await expect(service.syncSingleAccountMetrics(INTEGRATION)).rejects.toThrow(
      'platform 500'
    );
    expect(mocks.refreshIntegrationService.refresh).not.toHaveBeenCalled();
  });
});

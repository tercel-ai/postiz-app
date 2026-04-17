import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataTicksService } from '../data-ticks.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
const PLATFORM = 'x';

const DAY_START = new Date('2026-04-04T00:00:00.000Z');
const PRIOR_DAY = new Date('2026-04-02T00:00:00.000Z');

const POST = {
  id: 'post-1',
  integrationId: INT_ID,
  releaseId: 'rel-1',
  integration: { providerIdentifier: PLATFORM },
};

const FULL_INTEGRATION = {
  id: INT_ID,
  organizationId: ORG_ID,
  providerIdentifier: PLATFORM,
  internalId: 'x-internal-1',
  token: 'fake-token',
  // Far future so refresh path is not triggered
  tokenExpiration: new Date('2099-01-01T00:00:00.000Z'),
  deletedAt: null,
  disabled: false,
} as any;

function createMocks() {
  // batchPostAnalytics returning {} → for-loop in _syncOrgDailyTicks ends
  // with postsAnalyzed = 0 → integration enters the carry-forward branch.
  const failingProvider = {
    batchPostAnalytics: vi.fn().mockResolvedValue({}),
    // no accountMetrics → syncSingleAccountMetrics is a no-op
  };

  return {
    dataTicksRepository: {
      getAllActiveIntegrationsByOrg: vi
        .fn()
        .mockResolvedValue(new Map([[ORG_ID, [{ id: INT_ID, platform: PLATFORM }]]])),
      findLatestUpTo: vi.fn(),
      upsertMany: vi.fn().mockResolvedValue([]),
      query: vi.fn().mockResolvedValue([]),
    },
    dashboardRepository: {
      getPublishedPostsWithRelease: vi.fn().mockResolvedValue([POST]),
      getActiveIntegrations: vi.fn().mockResolvedValue([FULL_INTEGRATION]),
      getIntegrationById: vi.fn().mockResolvedValue(FULL_INTEGRATION),
      updateAccountMetrics: vi.fn().mockResolvedValue(undefined),
    },
    postsService: {},
    integrationManager: {
      getSocialIntegration: vi.fn().mockReturnValue(failingProvider),
    },
    refreshIntegrationService: {
      refresh: vi.fn(),
    },
    postsRepository: {
      batchUpdatePostAnalytics: vi.fn().mockResolvedValue(undefined),
    },
    failingProvider,
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
  );
}

// ---------------------------------------------------------------------------
// Tests — carry-forward branch in _syncOrgDailyTicks
// ---------------------------------------------------------------------------

describe('DataTicksService.syncDailyTicks — carry-forward on failed fetch', () => {
  let mocks: ReturnType<typeof createMocks>;
  let service: DataTicksService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    service = createService(mocks);
  });

  it('writes carry-forward when prior data exists and dayStart row is absent', async () => {
    // findLatestUpTo returns yesterday's row for both impressions and traffic
    mocks.dataTicksRepository.findLatestUpTo.mockResolvedValue([
      {
        organizationId: ORG_ID,
        integrationId: INT_ID,
        platform: PLATFORM,
        userId: null,
        type: 'impressions',
        statisticsTime: PRIOR_DAY,
        value: BigInt(1000),
        postsAnalyzed: 5,
      },
      {
        organizationId: ORG_ID,
        integrationId: INT_ID,
        platform: PLATFORM,
        userId: null,
        type: 'traffic',
        statisticsTime: PRIOR_DAY,
        value: BigInt(50),
        postsAnalyzed: 5,
      },
    ]);

    await service.syncDailyTicks(DAY_START);

    expect(mocks.dataTicksRepository.findLatestUpTo).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      integrationIds: [INT_ID],
      types: ['impressions', 'traffic'],
      upTo: DAY_START,
    });

    expect(mocks.dataTicksRepository.upsertMany).toHaveBeenCalledTimes(1);
    const records = mocks.dataTicksRepository.upsertMany.mock.calls[0][0];
    expect(records).toHaveLength(2);

    const impressions = records.find((r: any) => r.type === 'impressions');
    const traffic = records.find((r: any) => r.type === 'traffic');

    expect(impressions).toMatchObject({
      organizationId: ORG_ID,
      integrationId: INT_ID,
      platform: PLATFORM,
      type: 'impressions',
      timeUnit: 'day',
      statisticsTime: DAY_START,
      value: BigInt(1000),
      postsAnalyzed: 0,
    });
    expect(traffic).toMatchObject({
      type: 'traffic',
      statisticsTime: DAY_START,
      value: BigInt(50),
      postsAnalyzed: 0,
    });
  });

  it('writes nothing when integration has no prior data at all', async () => {
    mocks.dataTicksRepository.findLatestUpTo.mockResolvedValue([]);

    await service.syncDailyTicks(DAY_START);

    expect(mocks.dataTicksRepository.findLatestUpTo).toHaveBeenCalled();
    // upsertMany either not called, or called with no records.
    if (mocks.dataTicksRepository.upsertMany.mock.calls.length > 0) {
      const records = mocks.dataTicksRepository.upsertMany.mock.calls[0][0];
      expect(records).toHaveLength(0);
    }
  });

  it('does NOT overwrite an existing real row at dayStart (C1 regression)', async () => {
    // findLatestUpTo returns a row whose statisticsTime IS dayStart
    // (a successful earlier run today). Carry-forward must skip it.
    mocks.dataTicksRepository.findLatestUpTo.mockResolvedValue([
      {
        organizationId: ORG_ID,
        integrationId: INT_ID,
        platform: PLATFORM,
        userId: null,
        type: 'impressions',
        statisticsTime: new Date(DAY_START), // exact same instant as dayStart
        value: BigInt(2000),
        postsAnalyzed: 7, // real row
      },
      {
        organizationId: ORG_ID,
        integrationId: INT_ID,
        platform: PLATFORM,
        userId: null,
        type: 'traffic',
        statisticsTime: new Date(DAY_START),
        value: BigInt(120),
        postsAnalyzed: 7,
      },
    ]);

    await service.syncDailyTicks(DAY_START);

    // Either upsertMany was not called, or was called with zero records.
    if (mocks.dataTicksRepository.upsertMany.mock.calls.length > 0) {
      const records = mocks.dataTicksRepository.upsertMany.mock.calls[0][0];
      expect(records).toHaveLength(0);
    }
  });

  it('also skips when the existing dayStart row is itself a prior carry-forward', async () => {
    // statisticsTime == dayStart, postsAnalyzed=0 (an earlier carry-forward
    // from this same day's run). Skip is unconditional, not just for real rows.
    mocks.dataTicksRepository.findLatestUpTo.mockResolvedValue([
      {
        organizationId: ORG_ID,
        integrationId: INT_ID,
        platform: PLATFORM,
        userId: null,
        type: 'impressions',
        statisticsTime: new Date(DAY_START),
        value: BigInt(900),
        postsAnalyzed: 0,
      },
    ]);

    await service.syncDailyTicks(DAY_START);

    if (mocks.dataTicksRepository.upsertMany.mock.calls.length > 0) {
      const records = mocks.dataTicksRepository.upsertMany.mock.calls[0][0];
      expect(records).toHaveLength(0);
    }
  });

  it('continues sync gracefully if findLatestUpTo throws', async () => {
    mocks.dataTicksRepository.findLatestUpTo.mockRejectedValue(
      new Error('db down'),
    );

    // Should not throw to caller — error is caught and logged.
    await expect(service.syncDailyTicks(DAY_START)).resolves.toBeDefined();
  });

  it('coexists with successful integrations: writes both real and carry-forward records', async () => {
    // Two integrations in the same org: one succeeds, one fails.
    // The success path and the carry-forward path must both produce records
    // and they must end up in the same upsertMany call.
    const SUCCESS_INT_ID = 'int-success';
    const FAIL_INT_ID = 'int-fail';

    const successProvider = {
      // Returns one impressions data point so postsAnalyzed > 0 for this int.
      batchPostAnalytics: vi.fn().mockResolvedValue({
        'rel-success': [
          {
            label: 'Impressions',
            percentageChange: 0,
            data: [{ total: '500', date: '2026-04-04' }],
          },
        ],
      }),
    };
    const failProvider = {
      batchPostAnalytics: vi.fn().mockResolvedValue({}), // empty → postsAnalyzed=0
    };

    const successInt = { ...FULL_INTEGRATION, id: SUCCESS_INT_ID, internalId: 'x-success' };
    const failInt = { ...FULL_INTEGRATION, id: FAIL_INT_ID, internalId: 'x-fail' };

    mocks.dataTicksRepository.getAllActiveIntegrationsByOrg.mockResolvedValue(
      new Map([
        [
          ORG_ID,
          [
            { id: SUCCESS_INT_ID, platform: PLATFORM },
            { id: FAIL_INT_ID, platform: PLATFORM },
          ],
        ],
      ]),
    );
    mocks.dashboardRepository.getPublishedPostsWithRelease.mockResolvedValue([
      {
        id: 'post-success',
        integrationId: SUCCESS_INT_ID,
        releaseId: 'rel-success',
        integration: { providerIdentifier: PLATFORM },
      },
      {
        id: 'post-fail',
        integrationId: FAIL_INT_ID,
        releaseId: 'rel-fail',
        integration: { providerIdentifier: PLATFORM },
      },
    ]);
    mocks.dashboardRepository.getActiveIntegrations.mockResolvedValue([
      successInt,
      failInt,
    ]);

    // Provider lookup returns the right mock based on internalId
    mocks.integrationManager.getSocialIntegration.mockImplementation(
      () => successProvider, // both call the same path; we differentiate via batchPostAnalytics return
    );
    // Override per-call: success returns data for rel-success, empty for rel-fail
    successProvider.batchPostAnalytics.mockImplementation(
      async (_internalId: string, _token: string, releaseIds: string[]) => {
        const result: Record<string, any[]> = {};
        for (const id of releaseIds) {
          if (id === 'rel-success') {
            result[id] = [
              {
                label: 'Impressions',
                percentageChange: 0,
                data: [{ total: '500', date: '2026-04-04' }],
              },
            ];
          }
          // rel-fail: omitted → empty
        }
        return result;
      },
    );

    // Failed integration has prior data to carry forward.
    mocks.dataTicksRepository.findLatestUpTo.mockResolvedValue([
      {
        organizationId: ORG_ID,
        integrationId: FAIL_INT_ID,
        platform: PLATFORM,
        userId: null,
        type: 'impressions',
        statisticsTime: PRIOR_DAY,
        value: BigInt(800),
        postsAnalyzed: 4,
      },
      {
        organizationId: ORG_ID,
        integrationId: FAIL_INT_ID,
        platform: PLATFORM,
        userId: null,
        type: 'traffic',
        statisticsTime: PRIOR_DAY,
        value: BigInt(40),
        postsAnalyzed: 4,
      },
    ]);

    await service.syncDailyTicks(DAY_START);

    // findLatestUpTo is now called for every active integration — it
    // powers both the clamp path (real fetch) and the carry-forward path
    // (failed fetch / dormant integration).
    expect(mocks.dataTicksRepository.findLatestUpTo).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      integrationIds: expect.arrayContaining([SUCCESS_INT_ID, FAIL_INT_ID]),
      types: ['impressions', 'traffic'],
      upTo: DAY_START,
    });

    expect(mocks.dataTicksRepository.upsertMany).toHaveBeenCalledTimes(1);
    const records = mocks.dataTicksRepository.upsertMany.mock.calls[0][0];

    // Expect 4 records: 2 real (success int) + 2 carry-forward (fail int)
    expect(records).toHaveLength(4);

    const successRecords = records.filter((r: any) => r.integrationId === SUCCESS_INT_ID);
    const failRecords = records.filter((r: any) => r.integrationId === FAIL_INT_ID);

    expect(successRecords).toHaveLength(2);
    expect(failRecords).toHaveLength(2);

    // Real records have postsAnalyzed > 0
    for (const r of successRecords) {
      expect(r.postsAnalyzed).toBeGreaterThan(0);
    }
    // Carry-forward records have postsAnalyzed == 0 and copy prior values
    const failImp = failRecords.find((r: any) => r.type === 'impressions');
    const failTraffic = failRecords.find((r: any) => r.type === 'traffic');
    expect(failImp).toMatchObject({
      postsAnalyzed: 0,
      value: BigInt(800),
      statisticsTime: DAY_START,
    });
    expect(failTraffic).toMatchObject({
      postsAnalyzed: 0,
      value: BigInt(40),
      statisticsTime: DAY_START,
    });
  });

  it('clamps fetched value to prior when the platform returns a smaller cumulative', async () => {
    // Simulates: user deleted a top post on X between yesterday and today,
    // so the re-aggregated cumulative impressions would be *smaller* than
    // yesterday's stored value. The write must clamp to yesterday so the
    // series never decreases.
    const successProvider = {
      batchPostAnalytics: vi.fn().mockResolvedValue({
        'rel-1': [
          {
            label: 'Impressions',
            percentageChange: 0,
            // Fetched cumulative = 300, lower than yesterday's 1000.
            data: [{ total: '300', date: '2026-04-04' }],
          },
        ],
      }),
    };
    mocks.integrationManager.getSocialIntegration.mockReturnValue(
      successProvider,
    );

    mocks.dataTicksRepository.findLatestUpTo.mockResolvedValue([
      {
        organizationId: ORG_ID,
        integrationId: INT_ID,
        platform: PLATFORM,
        userId: null,
        type: 'impressions',
        statisticsTime: PRIOR_DAY,
        value: BigInt(1000),
        postsAnalyzed: 8,
      },
      {
        organizationId: ORG_ID,
        integrationId: INT_ID,
        platform: PLATFORM,
        userId: null,
        type: 'traffic',
        statisticsTime: PRIOR_DAY,
        value: BigInt(50),
        postsAnalyzed: 8,
      },
    ]);

    await service.syncDailyTicks(DAY_START);

    expect(mocks.dataTicksRepository.upsertMany).toHaveBeenCalledTimes(1);
    const records = mocks.dataTicksRepository.upsertMany.mock.calls[0][0];
    const imp = records.find((r: any) => r.type === 'impressions');

    // Value clamped to prior 1000 (not fetched 300). postsAnalyzed stays
    // > 0 because a real fetch did happen; only the value is pinned.
    expect(imp.value).toBe(BigInt(1000));
    expect(imp.postsAnalyzed).toBeGreaterThan(0);
  });

  it('writes a carry-forward row for a dormant integration (no posts in lookback)', async () => {
    // The live bug: an integration whose most recent post has aged out of
    // the 30-day lookback window produces no row at all under the old
    // logic, so the dashboard sum drops. Now we must carry forward from
    // the last known tick.
    const DORMANT_ID = 'int-dormant';
    const ACTIVE_ID = 'int-active';

    mocks.dataTicksRepository.getAllActiveIntegrationsByOrg.mockResolvedValue(
      new Map([
        [
          ORG_ID,
          [
            { id: ACTIVE_ID, platform: PLATFORM },
            { id: DORMANT_ID, platform: PLATFORM },
          ],
        ],
      ]),
    );
    mocks.dashboardRepository.getActiveIntegrations.mockResolvedValue([
      { ...FULL_INTEGRATION, id: ACTIVE_ID, internalId: 'x-active' },
      { ...FULL_INTEGRATION, id: DORMANT_ID, internalId: 'x-dormant' },
    ]);

    // Only the active integration has posts in lookback. Dormant absent
    // from postsByIntegration entirely.
    mocks.dashboardRepository.getPublishedPostsWithRelease.mockResolvedValue([
      {
        id: 'post-active',
        integrationId: ACTIVE_ID,
        releaseId: 'rel-active',
        integration: { providerIdentifier: PLATFORM },
      },
    ]);

    const activeProvider = {
      batchPostAnalytics: vi.fn().mockResolvedValue({
        'rel-active': [
          {
            label: 'Impressions',
            percentageChange: 0,
            data: [{ total: '211', date: '2026-04-04' }],
          },
        ],
      }),
    };
    mocks.integrationManager.getSocialIntegration.mockReturnValue(
      activeProvider,
    );

    // Dormant has a prior tick; active has none (first time).
    mocks.dataTicksRepository.findLatestUpTo.mockResolvedValue([
      {
        organizationId: ORG_ID,
        integrationId: DORMANT_ID,
        platform: PLATFORM,
        userId: null,
        type: 'impressions',
        statisticsTime: PRIOR_DAY,
        value: BigInt(86),
        postsAnalyzed: 3,
      },
      {
        organizationId: ORG_ID,
        integrationId: DORMANT_ID,
        platform: PLATFORM,
        userId: null,
        type: 'traffic',
        statisticsTime: PRIOR_DAY,
        value: BigInt(12),
        postsAnalyzed: 3,
      },
    ]);

    await service.syncDailyTicks(DAY_START);

    const records = mocks.dataTicksRepository.upsertMany.mock.calls[0][0];

    // 2 real (active) + 2 carry-forward (dormant) = 4
    expect(records).toHaveLength(4);

    const dormantRecords = records.filter(
      (r: any) => r.integrationId === DORMANT_ID,
    );
    expect(dormantRecords).toHaveLength(2);
    for (const r of dormantRecords) {
      expect(r.postsAnalyzed).toBe(0);
      expect(r.statisticsTime).toEqual(DAY_START);
    }
    const dormantImp = dormantRecords.find(
      (r: any) => r.type === 'impressions',
    );
    expect(dormantImp.value).toBe(BigInt(86));
  });

  it('emits [DataTicks] carry-forward warn for BOTH impressions and traffic', async () => {
    // F-05/F-02 regression guard: the logs ARE the operational signal that
    // tells on-call "this tick is synthetic". A silent refactor that drops
    // either warn is a real bug. Previously the traffic branch was missing
    // its warn — pin both now.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.dataTicksRepository.findLatestUpTo.mockResolvedValue([
      {
        organizationId: ORG_ID,
        integrationId: INT_ID,
        platform: PLATFORM,
        userId: null,
        type: 'impressions',
        statisticsTime: PRIOR_DAY,
        value: BigInt(1000),
        postsAnalyzed: 5,
      },
      {
        organizationId: ORG_ID,
        integrationId: INT_ID,
        platform: PLATFORM,
        userId: null,
        type: 'traffic',
        statisticsTime: PRIOR_DAY,
        value: BigInt(50),
        postsAnalyzed: 5,
      },
    ]);

    await service.syncDailyTicks(DAY_START);

    const impressionsWarn = warnSpy.mock.calls.find(
      (args) =>
        typeof args[0] === 'string' &&
        args[0].includes('[DataTicks] carry-forward') &&
        args[0].includes('type=impressions'),
    );
    const trafficWarn = warnSpy.mock.calls.find(
      (args) =>
        typeof args[0] === 'string' &&
        args[0].includes('[DataTicks] carry-forward') &&
        args[0].includes('type=traffic'),
    );

    expect(impressionsWarn).toBeDefined();
    expect(trafficWarn).toBeDefined();

    warnSpy.mockRestore();
  });

  it('emits [DataTicks] clamp warn for BOTH impressions and traffic on regression', async () => {
    // Platform returns a cumulative value lower than the prior snapshot for
    // both types. Both clamp warns must fire so on-call can correlate.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const successProvider = {
      batchPostAnalytics: vi.fn().mockResolvedValue({
        'rel-1': [
          {
            label: 'Impressions',
            percentageChange: 0,
            data: [{ total: '100', date: '2026-04-04' }],
          },
        ],
      }),
    };
    mocks.integrationManager.getSocialIntegration.mockReturnValue(
      successProvider,
    );

    mocks.dataTicksRepository.findLatestUpTo.mockResolvedValue([
      {
        organizationId: ORG_ID,
        integrationId: INT_ID,
        platform: PLATFORM,
        userId: null,
        type: 'impressions',
        statisticsTime: PRIOR_DAY,
        value: BigInt(500),
        postsAnalyzed: 5,
      },
      {
        organizationId: ORG_ID,
        integrationId: INT_ID,
        platform: PLATFORM,
        userId: null,
        type: 'traffic',
        statisticsTime: PRIOR_DAY,
        value: BigInt(80),
        postsAnalyzed: 5,
      },
    ]);

    await service.syncDailyTicks(DAY_START);

    const impressionsClampWarn = warnSpy.mock.calls.find(
      (args) =>
        typeof args[0] === 'string' &&
        args[0].includes('[DataTicks] clamp') &&
        args[0].includes('type=impressions'),
    );
    const trafficClampWarn = warnSpy.mock.calls.find(
      (args) =>
        typeof args[0] === 'string' &&
        args[0].includes('[DataTicks] clamp') &&
        args[0].includes('type=traffic'),
    );

    expect(impressionsClampWarn).toBeDefined();
    expect(trafficClampWarn).toBeDefined();

    warnSpy.mockRestore();
  });

  it('carries forward only the type that has prior history (partial-prior dormant)', async () => {
    // Dormant integration has prior impressions but NO prior traffic
    // (realistic for early-adopter data migrated from before traffic
    // tracking existed). The two if-blocks must independently handle this.
    const DORMANT_ID = 'int-dormant-partial';

    mocks.dataTicksRepository.getAllActiveIntegrationsByOrg.mockResolvedValue(
      new Map([
        [ORG_ID, [{ id: DORMANT_ID, platform: PLATFORM }]],
      ]),
    );
    mocks.dashboardRepository.getActiveIntegrations.mockResolvedValue([
      { ...FULL_INTEGRATION, id: DORMANT_ID, internalId: 'x-dormant' },
    ]);
    // Dormant: no posts in lookback.
    mocks.dashboardRepository.getPublishedPostsWithRelease.mockResolvedValue(
      [],
    );
    // Only impressions prior exists; traffic prior is absent.
    mocks.dataTicksRepository.findLatestUpTo.mockResolvedValue([
      {
        organizationId: ORG_ID,
        integrationId: DORMANT_ID,
        platform: PLATFORM,
        userId: null,
        type: 'impressions',
        statisticsTime: PRIOR_DAY,
        value: BigInt(42),
        postsAnalyzed: 2,
      },
    ]);

    await service.syncDailyTicks(DAY_START);

    const records = mocks.dataTicksRepository.upsertMany.mock.calls[0][0];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      integrationId: DORMANT_ID,
      type: 'impressions',
      value: BigInt(42),
      postsAnalyzed: 0,
    });
  });
});

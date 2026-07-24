import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashboardService } from '../dashboard.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK') },
}));

function createMocks() {
  return {
    dashboardRepository: {
      getTrafficByPlatform: vi.fn().mockResolvedValue([]),
      getPostsForImpressionsSeries: vi.fn().mockResolvedValue([]),
    },
    postsService: {},
    integrationManager: {},
    refreshIntegrationService: {},
    dataTicksService: {
      getTrafficSummaryByPlatform: vi.fn().mockResolvedValue([]),
      getImpressionsByPlatform: vi.fn().mockResolvedValue([]),
    },
    usersService: {},
  };
}

function createService(mocks: ReturnType<typeof createMocks>) {
  return new DashboardService(
    mocks.dashboardRepository as any,
    mocks.postsService as any,
    mocks.integrationManager as any,
    mocks.refreshIntegrationService as any,
    mocks.dataTicksService as any,
    mocks.usersService as any,
  );
}

const fakeOrg = { id: 'org-1' } as any;

describe('DashboardService.getTraffics / getImpressions — project scoping', () => {
  let mocks: ReturnType<typeof createMocks>;
  let service: DashboardService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    service = createService(mocks);
  });

  // -----------------------------------------------------------------------
  // getTraffics
  // -----------------------------------------------------------------------

  it('getTraffics: without projectId, reads from DataTicks (channel-level)', async () => {
    mocks.dataTicksService.getTrafficSummaryByPlatform.mockResolvedValue([
      { platform: 'x', value: 100, percentage: 100 },
    ]);

    const result = await service.getTraffics(fakeOrg, undefined, undefined, undefined, undefined, undefined);

    expect(mocks.dataTicksService.getTrafficSummaryByPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' })
    );
    expect(mocks.dashboardRepository.getTrafficByPlatform).not.toHaveBeenCalled();
    expect(result).toEqual([{ platform: 'x', value: 100, percentage: 100 }]);
  });

  it('getTraffics: with projectId, reads Post-level data instead of DataTicks (avoids channel-sharing leak)', async () => {
    mocks.dashboardRepository.getTrafficByPlatform.mockResolvedValue([
      { platform: 'x', value: 300 },
      { platform: 'reddit', value: 100 },
    ]);

    const result = await service.getTraffics(fakeOrg, undefined, undefined, undefined, undefined, 'project-1');

    expect(mocks.dashboardRepository.getTrafficByPlatform).toHaveBeenCalledWith(
      'org-1',
      undefined,
      undefined,
      undefined,
      undefined,
      'project-1'
    );
    expect(mocks.dataTicksService.getTrafficSummaryByPlatform).not.toHaveBeenCalled();
    expect(result).toEqual([
      { platform: 'x', value: 300, percentage: 75 },
      { platform: 'reddit', value: 100, percentage: 25 },
    ]);
  });

  it('getTraffics: with projectId and no matching posts, returns []', async () => {
    mocks.dashboardRepository.getTrafficByPlatform.mockResolvedValue([]);

    const result = await service.getTraffics(fakeOrg, undefined, undefined, undefined, undefined, 'project-1');

    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // getImpressions
  // -----------------------------------------------------------------------

  it('getImpressions: without projectId, reads from DataTicks (channel-level)', async () => {
    mocks.dataTicksService.getImpressionsByPlatform.mockResolvedValue([
      { date: '2026-07-01', value: 500, platform: 'x' },
    ]);

    const result = await service.getImpressions(fakeOrg, 'daily', undefined, undefined, undefined, undefined, undefined);

    expect(mocks.dataTicksService.getImpressionsByPlatform).toHaveBeenCalled();
    expect(mocks.dashboardRepository.getPostsForImpressionsSeries).not.toHaveBeenCalled();
    expect(result).toEqual([{ date: '2026-07-01', value: 500, platform: 'x' }]);
  });

  it('getImpressions: with projectId, buckets Post.impressions by publishDate + platform instead of DataTicks', async () => {
    mocks.dashboardRepository.getPostsForImpressionsSeries.mockResolvedValue([
      {
        publishDate: new Date('2026-07-01T10:00:00.000Z'),
        impressions: 100,
        integration: { providerIdentifier: 'x' },
      },
      {
        publishDate: new Date('2026-07-01T15:00:00.000Z'),
        impressions: 50,
        integration: { providerIdentifier: 'x' },
      },
      {
        publishDate: new Date('2026-07-02T09:00:00.000Z'),
        impressions: 30,
        integration: { providerIdentifier: 'reddit' },
      },
    ]);

    const result = await service.getImpressions(fakeOrg, 'daily', undefined, undefined, undefined, undefined, 'project-1');

    expect(mocks.dashboardRepository.getPostsForImpressionsSeries).toHaveBeenCalledWith(
      'org-1',
      expect.any(Date),
      expect.any(Date),
      undefined,
      undefined,
      'project-1'
    );
    expect(mocks.dataTicksService.getImpressionsByPlatform).not.toHaveBeenCalled();
    expect(result).toEqual([
      { date: '2026-07-01', platform: 'x', value: 150 },
      { date: '2026-07-02', platform: 'reddit', value: 30 },
    ]);
  });

  it('getImpressions: with projectId and no matching posts, returns []', async () => {
    mocks.dashboardRepository.getPostsForImpressionsSeries.mockResolvedValue([]);

    const result = await service.getImpressions(fakeOrg, 'daily', undefined, undefined, undefined, undefined, 'project-1');

    expect(result).toEqual([]);
  });
});

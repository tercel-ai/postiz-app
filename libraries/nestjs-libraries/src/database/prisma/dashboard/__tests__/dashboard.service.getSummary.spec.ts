import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashboardService } from '../dashboard.service';

// ---------------------------------------------------------------------------
// Mocks — only getSummary dependencies
// ---------------------------------------------------------------------------

vi.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK') },
}));

function createMocks() {
  return {
    dashboardRepository: {
      getChannelCount: vi.fn().mockResolvedValue(2),
      getActiveIntegrations: vi.fn().mockResolvedValue([]),
      getPostsStats: vi.fn().mockResolvedValue([]),
    },
    postsService: {
      countPostsFromDay: vi.fn().mockResolvedValue(0),
    },
    integrationManager: {},
    refreshIntegrationService: {},
    dataTicksService: {
      getImpressionsSummaryByPlatform: vi.fn().mockResolvedValue([]),
      getTrafficSummaryByPlatform: vi.fn().mockResolvedValue([]),
    },
    usersService: {
      getUserLimits: vi.fn().mockResolvedValue({
        postChannelLimit: 10,
        postSendLimit: 20,
        periodStart: '2026-03-15T00:00:00.000Z',
        periodEnd: '2026-04-15T00:00:00.000Z',
      }),
    },
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DashboardService.getSummary — published_this_period uses billing period', () => {
  let mocks: ReturnType<typeof createMocks>;
  let service: DashboardService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    service = createService(mocks);
  });

  // -----------------------------------------------------------------------
  // Billing period from Aisee
  // -----------------------------------------------------------------------

  it('uses Aisee periodStart (not calendar month) for countPostsFromDay', async () => {
    mocks.postsService.countPostsFromDay.mockResolvedValue(5);

    const result = await service.getSummary(fakeOrg, 'user-1');

    expect(mocks.usersService.getUserLimits).toHaveBeenCalledWith('user-1');
    expect(mocks.postsService.countPostsFromDay).toHaveBeenCalledWith(
      'org-1',
      new Date('2026-03-15T00:00:00.000Z'),
    );
    expect(result.published_this_period).toBe(5);
  });

  it('includes post_send_limit and period_end from Aisee', async () => {
    mocks.postsService.countPostsFromDay.mockResolvedValue(3);

    const result = await service.getSummary(fakeOrg, 'user-1');

    expect(result.post_send_limit).toBe(20);
    expect(result.period_end).toBe('2026-04-15T00:00:00.000Z');
  });

  it('Dashboard and overage billing use the same countPostsFromDay', async () => {
    mocks.postsService.countPostsFromDay.mockResolvedValue(7);

    const result = await service.getSummary(fakeOrg, 'user-1');

    // Same method, same periodStart — consistent with PostOverageService
    expect(result.published_this_period).toBe(7);
    expect(mocks.postsService.countPostsFromDay).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Fallback to calendar month
  // -----------------------------------------------------------------------

  it('falls back to calendar month when userId is undefined', async () => {
    mocks.postsService.countPostsFromDay.mockResolvedValue(10);

    await service.getSummary(fakeOrg, undefined);

    expect(mocks.usersService.getUserLimits).not.toHaveBeenCalled();
    // Should use start-of-month, not Aisee periodStart
    const calledDate = mocks.postsService.countPostsFromDay.mock.calls[0][1] as Date;
    expect(calledDate.getDate()).toBe(1); // first of month
  });

  it('falls back to calendar month when getUserLimits fails', async () => {
    mocks.usersService.getUserLimits.mockRejectedValue(new Error('API down'));
    mocks.postsService.countPostsFromDay.mockResolvedValue(4);

    const result = await service.getSummary(fakeOrg, 'user-1');

    expect(result.published_this_period).toBe(4);
    const calledDate = mocks.postsService.countPostsFromDay.mock.calls[0][1] as Date;
    expect(calledDate.getDate()).toBe(1);
  });

  it('falls back to calendar month when limits have no periodStart', async () => {
    mocks.usersService.getUserLimits.mockResolvedValue({
      postChannelLimit: 0,
      postSendLimit: 0,
    });
    mocks.postsService.countPostsFromDay.mockResolvedValue(2);

    const result = await service.getSummary(fakeOrg, 'user-1');

    expect(result.published_this_period).toBe(2);
    const calledDate = mocks.postsService.countPostsFromDay.mock.calls[0][1] as Date;
    expect(calledDate.getDate()).toBe(1);
  });

  it('does not include post_send_limit when falling back', async () => {
    await service.getSummary(fakeOrg, undefined);

    const result = await service.getSummary(fakeOrg, undefined);
    expect(result).not.toHaveProperty('post_send_limit');
    expect(result).not.toHaveProperty('period_end');
  });
});

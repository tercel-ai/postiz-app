import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataTicksService } from '../data-ticks.service';

vi.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {
    keys: vi.fn().mockResolvedValue([]),
    del: vi.fn().mockResolvedValue(0),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  },
}));

const ORG_ID = 'org-1';

type Tick = {
  organizationId: string;
  integrationId: string;
  platform: string;
  type: string;
  statisticsTime: Date;
  value: bigint;
};

function tick(
  integrationId: string,
  platform: string,
  date: string,
  value: number,
  type = 'impressions'
): Tick {
  return {
    organizationId: ORG_ID,
    integrationId,
    platform,
    type,
    statisticsTime: new Date(`${date}T00:00:00.000Z`),
    value: BigInt(value),
  };
}

function createService(ticks: Tick[]) {
  const mocks = {
    dataTicksRepository: {
      query: vi.fn().mockImplementation(async (params: any) => {
        return ticks
          .filter(
            (t) =>
              t.type === params.type &&
              t.statisticsTime >= params.startTime &&
              t.statisticsTime <= params.endTime
          )
          .sort(
            (a, b) =>
              a.statisticsTime.getTime() - b.statisticsTime.getTime()
          );
      }),
    },
  };
  const service = new DataTicksService(
    mocks.dataTicksRepository as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  return { service, mocks };
}

describe('DataTicksService.getImpressionsSummaryByPlatform — max per integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('takes the max value per integration, not the latest', async () => {
    // F-01 regression: historical regression in the DB (e.g. fetched=300
    // written before write-side clamp shipped, after a prior 1000). Summary
    // must report 1000 so it agrees with the time-series endpoint which
    // clamps regressions.
    const { service } = createService([
      tick('intA', 'x', '2026-04-10', 1000),
      tick('intA', 'x', '2026-04-11', 300), // regression — must be hidden
      tick('intA', 'x', '2026-04-12', 300),
    ]);

    const result = await service.getImpressionsSummaryByPlatform({
      organizationId: ORG_ID,
      startDate: new Date('2026-04-10T00:00:00.000Z'),
      endDate: new Date('2026-04-12T23:59:59.999Z'),
    });

    expect(result).toEqual([
      { platform: 'x', value: 1000, percentage: 100 },
    ]);
  });

  it('sums max-per-integration across platforms correctly', async () => {
    // Two x integrations (max 200 + max 500) + one linkedin (max 50).
    // Output: x=700 (≈93.33%), linkedin=50 (≈6.67%).
    const { service } = createService([
      tick('intX1', 'x', '2026-04-10', 150),
      tick('intX1', 'x', '2026-04-11', 200),
      tick('intX1', 'x', '2026-04-12', 180), // dip — ignored by max
      tick('intX2', 'x', '2026-04-10', 500),
      tick('intLI', 'linkedin', '2026-04-10', 50),
    ]);

    const result = await service.getImpressionsSummaryByPlatform({
      organizationId: ORG_ID,
      startDate: new Date('2026-04-10T00:00:00.000Z'),
      endDate: new Date('2026-04-12T23:59:59.999Z'),
    });

    // Sorted by value DESC.
    expect(result).toEqual([
      { platform: 'x', value: 700, percentage: 93.33 },
      { platform: 'linkedin', value: 50, percentage: 6.67 },
    ]);
  });

  it('returns empty array when no ticks in the window', async () => {
    const { service } = createService([]);

    const result = await service.getImpressionsSummaryByPlatform({
      organizationId: ORG_ID,
      startDate: new Date('2026-04-10T00:00:00.000Z'),
      endDate: new Date('2026-04-12T23:59:59.999Z'),
    });

    expect(result).toEqual([]);
  });

  it('agrees with time-series endpoint on the terminal value', async () => {
    // Cross-endpoint consistency: for a single integration with a
    // regression, summary should return the same value as the last
    // bucket of the time-series (which is clamped).
    const { service } = createService([
      tick('intA', 'x', '2026-04-10', 100),
      tick('intA', 'x', '2026-04-11', 200),
      tick('intA', 'x', '2026-04-12', 150), // regression
    ]);

    const [summary, timeSeries] = await Promise.all([
      service.getImpressionsSummaryByPlatform({
        organizationId: ORG_ID,
        startDate: new Date('2026-04-10T00:00:00.000Z'),
        endDate: new Date('2026-04-12T23:59:59.999Z'),
      }),
      service.getImpressionsByPlatform({
        organizationId: ORG_ID,
        period: 'daily',
        startDate: new Date('2026-04-10T00:00:00.000Z'),
        endDate: new Date('2026-04-12T23:59:59.999Z'),
      }),
    ]);

    const summaryX = summary.find((r: any) => r.platform === 'x')!;
    const lastTimeSeriesBucket = timeSeries
      .filter((r: any) => r.platform === 'x')
      .slice(-1)[0];

    expect(summaryX.value).toBe(lastTimeSeriesBucket.value);
  });
});

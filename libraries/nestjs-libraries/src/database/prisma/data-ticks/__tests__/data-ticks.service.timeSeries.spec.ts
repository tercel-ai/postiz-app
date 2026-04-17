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

describe('DataTicksService.getImpressionsByPlatform — forward-fill + monotonic repair', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forward-fills missing buckets within the global window', async () => {
    // intA has ticks all 5 days; intB is missing day 3 and day 5.
    const { service } = createService([
      tick('intA', 'x', '2026-04-10', 100),
      tick('intA', 'x', '2026-04-11', 110),
      tick('intA', 'x', '2026-04-12', 120),
      tick('intA', 'x', '2026-04-13', 130),
      tick('intA', 'x', '2026-04-14', 140),
      tick('intB', 'x', '2026-04-10', 50),
      tick('intB', 'x', '2026-04-11', 55),
      // 04-12 missing
      tick('intB', 'x', '2026-04-13', 65),
      // 04-14 missing
    ]);

    const result = await service.getImpressionsByPlatform({
      organizationId: ORG_ID,
      period: 'daily',
      startDate: new Date('2026-04-10T00:00:00.000Z'),
      endDate: new Date('2026-04-14T23:59:59.999Z'),
    });

    // Day 04-12: intB missing → filled with 55 → total = 120 + 55 = 175
    // Day 04-14: intB missing → filled with 65 → total = 140 + 65 = 205
    expect(result).toEqual([
      { date: '2026-04-10', platform: 'x', value: 150 },
      { date: '2026-04-11', platform: 'x', value: 165 },
      { date: '2026-04-12', platform: 'x', value: 175 },
      { date: '2026-04-13', platform: 'x', value: 195 },
      { date: '2026-04-14', platform: 'x', value: 205 },
    ]);
  });

  it('clamps regressions so cumulative series never decreases', async () => {
    // intA's value drops from 297 to 211 — should be clamped to 297.
    const { service } = createService([
      tick('intA', 'x', '2026-04-13', 297),
      tick('intA', 'x', '2026-04-14', 297),
      tick('intA', 'x', '2026-04-15', 211),
      tick('intA', 'x', '2026-04-16', 211),
    ]);

    const result = await service.getImpressionsByPlatform({
      organizationId: ORG_ID,
      period: 'daily',
      startDate: new Date('2026-04-13T00:00:00.000Z'),
      endDate: new Date('2026-04-16T23:59:59.999Z'),
    });

    expect(result.map((r) => r.value)).toEqual([297, 297, 297, 297]);
  });

  it('handles the live bug: integration falls out of lookback after some day', async () => {
    // Two x integrations; intB stops producing ticks after 04-14.
    // Without forward-fill, totals on 04-15 and 04-16 would drop.
    const { service } = createService([
      tick('intA', 'x', '2026-04-13', 211),
      tick('intA', 'x', '2026-04-14', 211),
      tick('intA', 'x', '2026-04-15', 211),
      tick('intA', 'x', '2026-04-16', 211),
      tick('intB', 'x', '2026-04-13', 86),
      tick('intB', 'x', '2026-04-14', 86),
      // intB absent 04-15, 04-16
    ]);

    const result = await service.getImpressionsByPlatform({
      organizationId: ORG_ID,
      period: 'daily',
      startDate: new Date('2026-04-13T00:00:00.000Z'),
      endDate: new Date('2026-04-16T23:59:59.999Z'),
    });

    expect(result.map((r) => r.value)).toEqual([297, 297, 297, 297]);
  });

  it('does not emit buckets before an integration first appears', async () => {
    // intLinkedIn first appears on 04-12; earlier days must not contain a
    // linkedin row.
    const { service } = createService([
      tick('intX', 'x', '2026-04-10', 100),
      tick('intX', 'x', '2026-04-11', 110),
      tick('intX', 'x', '2026-04-12', 120),
      tick('intLinkedIn', 'linkedin', '2026-04-12', 5),
    ]);

    const result = await service.getImpressionsByPlatform({
      organizationId: ORG_ID,
      period: 'daily',
      startDate: new Date('2026-04-10T00:00:00.000Z'),
      endDate: new Date('2026-04-12T23:59:59.999Z'),
    });

    expect(result).toEqual([
      { date: '2026-04-10', platform: 'x', value: 100 },
      { date: '2026-04-11', platform: 'x', value: 110 },
      { date: '2026-04-12', platform: 'linkedin', value: 5 },
      { date: '2026-04-12', platform: 'x', value: 120 },
    ]);
  });

  it('returns an empty series when no ticks exist in the window', async () => {
    const { service } = createService([]);

    const result = await service.getImpressionsByPlatform({
      organizationId: ORG_ID,
      period: 'daily',
      startDate: new Date('2026-04-10T00:00:00.000Z'),
      endDate: new Date('2026-04-14T23:59:59.999Z'),
    });

    expect(result).toEqual([]);
  });

  it('forward-fills across weekly buckets (ISO Monday-start)', async () => {
    // 2026-04-06 is a Monday. Bucket key = Monday of the ISO week. The
    // 7-day stride in nextBucketKey assumes cursors already land on a
    // Monday, so a tick on a Sunday must still be normalized to the
    // preceding Monday by bucketKeyOf.
    const { service } = createService([
      tick('intA', 'x', '2026-04-06', 100), // Monday
      // week of 04-13 has no tick
      tick('intA', 'x', '2026-04-26', 150), // Sunday → ISO week starts 04-20
    ]);

    const result = await service.getImpressionsByPlatform({
      organizationId: ORG_ID,
      period: 'weekly',
      startDate: new Date('2026-04-06T00:00:00.000Z'),
      endDate: new Date('2026-04-26T23:59:59.999Z'),
    });

    expect(result).toEqual([
      { date: '2026-04-06', platform: 'x', value: 100 },
      { date: '2026-04-13', platform: 'x', value: 100 }, // carried forward
      { date: '2026-04-20', platform: 'x', value: 150 }, // Sunday tick → ISO Monday 04-20
    ]);
  });

  it('pins walker baseline correctly when the first bucket has value 0', async () => {
    // Edge case: an integration's first in-window tick can legitimately
    // be 0 (e.g. linkedin integration where the single posted item has
    // no impressions yet). Later buckets must NOT be clamped to 0 if a
    // real >0 tick arrives.
    const { service } = createService([
      tick('intA', 'linkedin', '2026-04-10', 0),
      tick('intA', 'linkedin', '2026-04-11', 0),
      tick('intA', 'linkedin', '2026-04-12', 5),
      // 04-13 missing — must forward-fill with 5, not 0
      tick('intA', 'linkedin', '2026-04-14', 5),
    ]);

    const result = await service.getImpressionsByPlatform({
      organizationId: ORG_ID,
      period: 'daily',
      startDate: new Date('2026-04-10T00:00:00.000Z'),
      endDate: new Date('2026-04-14T23:59:59.999Z'),
    });

    expect(result).toEqual([
      { date: '2026-04-10', platform: 'linkedin', value: 0 },
      { date: '2026-04-11', platform: 'linkedin', value: 0 },
      { date: '2026-04-12', platform: 'linkedin', value: 5 },
      { date: '2026-04-13', platform: 'linkedin', value: 5 },
      { date: '2026-04-14', platform: 'linkedin', value: 5 },
    ]);
  });

  it('forward-fills across monthly buckets too', async () => {
    // March has one tick; April and May have no ticks; period=monthly.
    const { service } = createService([
      tick('intA', 'x', '2026-03-05', 100),
      tick('intA', 'x', '2026-05-10', 150),
      // April missing entirely
    ]);

    const result = await service.getImpressionsByPlatform({
      organizationId: ORG_ID,
      period: 'monthly',
      startDate: new Date('2026-03-01T00:00:00.000Z'),
      endDate: new Date('2026-05-31T23:59:59.999Z'),
    });

    expect(result).toEqual([
      { date: '2026-03', platform: 'x', value: 100 },
      { date: '2026-04', platform: 'x', value: 100 },
      { date: '2026-05', platform: 'x', value: 150 },
    ]);
  });
});

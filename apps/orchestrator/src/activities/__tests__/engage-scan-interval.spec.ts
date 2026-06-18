import { describe, it, expect, vi } from 'vitest';
import { EngageScanActivity } from '../engage-scan.activity';
import { TokenPool } from '@gitroom/nestjs-libraries/engage/scan/token-pool';

// Bare activity; we drive the private scan helpers directly and stub _scanUnit
// to capture the (scanKey, cadenceMs, keywords) each unit is scheduled with.
function buildActivity() {
  return new EngageScanActivity(
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any
  );
}

// Activity wired to a mocked EngageScanCursor repo, for driving _claimCursor
// against the bucketed `__global__:<hours>` key directly.
function buildWithCursor(row: any, claimCount = 1) {
  const upsert = vi.fn().mockResolvedValue(row);
  const updateMany = vi.fn().mockResolvedValue({ count: claimCount });
  const update = vi.fn().mockResolvedValue({});
  const cursorRepo = { model: { engageScanCursor: { upsert, updateMany, update } } };
  const activity = new EngageScanActivity(
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any,
    cursorRepo as any,
    {} as any
  );
  return { activity, upsert, updateMany };
}

const H = 3_600_000;

function captureScanUnit(activity: EngageScanActivity) {
  const calls: Array<{ scanKey: string; cadenceMs: number; keywords: string[] }> = [];
  (activity as any)._scanUnit = vi.fn(async (args: any) => {
    calls.push({ scanKey: args.scanKey, cadenceMs: args.cadenceMs, keywords: args.keywords });
    return { ran: true, posts: [] };
  });
  return calls;
}

describe('EngageScanActivity keyword bucketing by scan interval', () => {
  it('buckets each keyword by the MIN interval across owning orgs', async () => {
    const activity = buildActivity();
    const calls = captureScanUnit(activity);

    // Pro org (6h) and a Starter org (24h). "ai" is shared → lands in the 6h
    // bucket; "ml" is Starter-only → 24h bucket.
    const orgContexts = [
      { organizationId: 'pro', keywords: [{ keyword: 'ai' }] },
      { organizationId: 'starter', keywords: [{ keyword: 'ai' }, { keyword: 'ml' }] },
    ] as any;
    const intervalByOrg = new Map([
      ['pro', 6],
      ['starter', 24],
    ]);

    await (activity as any)._scanKeywordUnits(
      orgContexts,
      intervalByOrg,
      new TokenPool(['tok']),
      'reddit-token',
      false
    );

    // 2 buckets × 2 platforms = 4 units.
    expect(calls).toHaveLength(4);

    const sixHour = calls.filter((c) => c.cadenceMs === 6 * H);
    const dayLong = calls.filter((c) => c.cadenceMs === 24 * H);
    expect(sixHour).toHaveLength(2); // x + reddit
    expect(dayLong).toHaveLength(2);

    for (const c of sixHour) {
      expect(c.scanKey).toBe('__global__:6');
      expect(c.keywords).toEqual(['ai']);
    }
    for (const c of dayLong) {
      expect(c.scanKey).toBe('__global__:24');
      expect(c.keywords).toEqual(['ml']);
    }
  });

  it('uses the default 24h interval for orgs missing from the interval map', async () => {
    const activity = buildActivity();
    const calls = captureScanUnit(activity);

    const orgContexts = [
      { organizationId: 'unknown', keywords: [{ keyword: 'seo' }] },
    ] as any;

    await (activity as any)._scanKeywordUnits(
      orgContexts,
      new Map(), // empty → fallback to DEFAULT_SCAN_INTERVAL_HOURS (24)
      new TokenPool(['tok']),
      'reddit-token',
      false
    );

    expect(calls).toHaveLength(2); // 1 bucket × 2 platforms
    for (const c of calls) {
      expect(c.cadenceMs).toBe(24 * H);
      expect(c.scanKey).toBe('__global__:24');
    }
  });
});

describe('EngageScanActivity cursor claim with bucketed keyword key (shared lease)', () => {
  it('upserts the cursor under the composite __global__:<hours> key and claims it when due', async () => {
    const row = {
      id: 'cur6',
      platform: 'x',
      scanType: 'keyword',
      scanKey: '__global__:6',
      status: 'IDLE',
      cooldownUntil: null as Date | null,
      lastScanStartedAt: null as Date | null,
    };
    const { activity, upsert, updateMany } = buildWithCursor(row);

    const claimed = await (activity as any)._lease.claim({
      platform: 'x',
      scanType: 'keyword',
      scanKey: '__global__:6',
      cadenceMs: 6 * H,
      force: false,
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { platform_scanType_scanKey: { platform: 'x', scanType: 'keyword', scanKey: '__global__:6' } },
      })
    );
    expect(updateMany).toHaveBeenCalledTimes(1); // IDLE → SCANNING claim (CAS)
    expect(claimed?.id).toBe('cur6');
    expect(claimed?.leaseToken).toMatch(/^[0-9a-f]{48}$/);
  });

  it('skips a bucket scanned within its cadence (not due — no claim)', async () => {
    const row = {
      id: 'cur24',
      platform: 'x',
      scanType: 'keyword',
      scanKey: '__global__:24',
      status: 'IDLE',
      cooldownUntil: null as Date | null,
      lastScanStartedAt: new Date(),
    };
    const { activity, updateMany } = buildWithCursor(row);

    const claimed = await (activity as any)._lease.claim({
      platform: 'x',
      scanType: 'keyword',
      scanKey: '__global__:24',
      cadenceMs: 24 * H,
      force: false,
    });

    expect(claimed).toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('EngageScanActivity channel/tracked per-unit cadence', () => {
  it('scans each subreddit at the min interval of its monitoring orgs', async () => {
    const activity = buildActivity();
    const calls = captureScanUnit(activity);
    // Post-scan bookkeeping touches the (unstubbed) channel repo — bypass it.
    (activity as any)._markChannelsScanned = vi.fn().mockResolvedValue(undefined);

    const orgContexts = [
      {
        organizationId: 'pro',
        monitoredChannels: [{ platform: 'reddit', channelId: 'SEO' }],
      },
      {
        organizationId: 'starter',
        monitoredChannels: [
          { platform: 'reddit', channelId: 'SEO' },
          { platform: 'reddit', channelId: 'marketing' },
        ],
      },
    ] as any;
    const intervalByOrg = new Map([
      ['pro', 6],
      ['starter', 24],
    ]);

    await (activity as any)._scanChannelUnits(
      orgContexts,
      intervalByOrg,
      ['kw'],
      'reddit-token',
      false
    );

    const bySubreddit = Object.fromEntries(calls.map((c) => [c.scanKey, c.cadenceMs]));
    expect(bySubreddit['SEO']).toBe(6 * H); // shared with Pro → 6h
    expect(bySubreddit['marketing']).toBe(24 * H); // Starter-only → 24h
  });
});

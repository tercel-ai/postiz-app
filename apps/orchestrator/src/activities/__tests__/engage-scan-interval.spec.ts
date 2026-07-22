import { describe, it, expect, vi, afterEach } from 'vitest';
import { EngageScanActivity, xScanEnabled } from '../engage-scan.activity';
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
  const calls: Array<{
    scanKey: string;
    cadenceMs: number;
    keywords: string[];
    scope?: any;
  }> = [];
  (activity as any)._scanUnit = vi.fn(async (args: any) => {
    calls.push({
      scanKey: args.scanKey,
      cadenceMs: args.cadenceMs,
      keywords: args.keywords,
      scope: args.scope,
    });
    return { ran: true, posts: [] };
  });
  return calls;
}

describe('EngageScanActivity per-keyword scan units (by scan interval)', () => {
  it('scans each keyword as its own unit at the MIN interval across owning orgs', async () => {
    const activity = buildActivity();
    const calls = captureScanUnit(activity);

    // Pro org (6h) and a Starter org (24h). "ai" is shared → its own unit at the
    // MIN 6h; "ml" is Starter-only → its own unit at 24h.
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

    // 2 keywords × 2 platforms = 4 units.
    expect(calls).toHaveLength(4);

    const sixHour = calls.filter((c) => c.cadenceMs === 6 * H);
    const dayLong = calls.filter((c) => c.cadenceMs === 24 * H);
    expect(sixHour).toHaveLength(2); // x + reddit
    expect(dayLong).toHaveLength(2);

    for (const c of sixHour) {
      expect(c.scanKey).toBe('ai'); // per-keyword cursor key (normalized)
      expect(c.keywords).toEqual(['ai']);
    }
    for (const c of dayLong) {
      expect(c.scanKey).toBe('ml');
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

    expect(calls).toHaveLength(2); // 1 keyword × 2 platforms
    for (const c of calls) {
      expect(c.cadenceMs).toBe(24 * H);
      expect(c.scanKey).toBe('seo');
      expect(c.keywords).toEqual(['seo']);
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

describe('xScanEnabled (X kill switch)', () => {
  const saved = {
    enabled: process.env.ENGAGE_X_SCAN_ENABLED,
    platforms: process.env.ENGAGE_SUPPORTED_PLATFORMS,
  };
  afterEach(() => {
    process.env.ENGAGE_X_SCAN_ENABLED = saved.enabled;
    process.env.ENGAGE_SUPPORTED_PLATFORMS = saved.platforms;
    if (saved.enabled === undefined) delete process.env.ENGAGE_X_SCAN_ENABLED;
    if (saved.platforms === undefined) delete process.env.ENGAGE_SUPPORTED_PLATFORMS;
  });

  it('defaults to enabled when nothing is set', () => {
    delete process.env.ENGAGE_X_SCAN_ENABLED;
    delete process.env.ENGAGE_SUPPORTED_PLATFORMS;
    expect(xScanEnabled()).toBe(true);
  });

  it('is disabled by the explicit ENGAGE_X_SCAN_ENABLED=false toggle', () => {
    delete process.env.ENGAGE_SUPPORTED_PLATFORMS;
    process.env.ENGAGE_X_SCAN_ENABLED = 'false';
    expect(xScanEnabled()).toBe(false);
  });

  it('is disabled when ENGAGE_SUPPORTED_PLATFORMS excludes x (shared with extension)', () => {
    delete process.env.ENGAGE_X_SCAN_ENABLED;
    process.env.ENGAGE_SUPPORTED_PLATFORMS = 'reddit';
    expect(xScanEnabled()).toBe(false);
  });

  it('stays enabled when the allowlist includes x', () => {
    delete process.env.ENGAGE_X_SCAN_ENABLED;
    process.env.ENGAGE_SUPPORTED_PLATFORMS = 'x,reddit';
    expect(xScanEnabled()).toBe(true);
  });

  it('honours a resolved allowlist argument over the env var', () => {
    // Simulates settings.operation_plan.allowed_platforms winning: env still lists
    // x, but the resolved allowlist (passed in) does not → X disabled.
    delete process.env.ENGAGE_X_SCAN_ENABLED;
    process.env.ENGAGE_SUPPORTED_PLATFORMS = 'x,reddit';
    expect(xScanEnabled(['reddit', 'linkedin'])).toBe(false);
    expect(xScanEnabled(['x', 'reddit'])).toBe(true);
  });

  it('explicit ENGAGE_X_SCAN_ENABLED=false still wins over a resolved allowlist with x', () => {
    process.env.ENGAGE_X_SCAN_ENABLED = 'false';
    expect(xScanEnabled(['x', 'reddit'])).toBe(false);
  });
});

describe('EngageScanActivity per-account tracked units', () => {
  it('scans each tracked account as its own unit at the MIN interval (not OR-merged)', async () => {
    const activity = buildActivity();
    const calls = captureScanUnit(activity);
    (activity as any)._updateTrackedAccountsFromPosts = vi
      .fn()
      .mockResolvedValue(undefined);

    // Pro tracks Alice+BOB (6h); Starter tracks carol (24h). Each account is its
    // own unit keyed by its normalized username — no OR-merge, no shared cursor.
    const orgContexts = [
      {
        organizationId: 'pro',
        trackedAccounts: [{ username: 'Alice' }, { username: 'BOB' }],
      },
      {
        organizationId: 'starter',
        trackedAccounts: [{ username: 'carol' }],
      },
    ] as any;
    const intervalByOrg = new Map([
      ['pro', 6],
      ['starter', 24],
    ]);

    await (activity as any)._scanTrackedUnits(
      orgContexts,
      intervalByOrg,
      ['ai'],
      new TokenPool(['tok']),
      false
    );

    // 3 accounts → 3 units (was 2 merged buckets).
    expect(calls).toHaveLength(3);
    const byKey = Object.fromEntries(calls.map((c) => [c.scanKey, c]));

    // Normalized username = the per-account cursor key; single-key tracked scope.
    expect(byKey['alice'].cadenceMs).toBe(6 * H);
    expect(byKey['alice'].scope).toEqual({ type: 'tracked', key: 'alice' });
    expect(byKey['alice'].keywords).toEqual(['ai']); // keywords still OR-filtered per account
    expect(byKey['bob'].cadenceMs).toBe(6 * H);
    expect(byKey['carol'].cadenceMs).toBe(24 * H);
    expect(byKey['carol'].scope.key).toBe('carol');
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

/**
 * Per-platform opportunity TTL: resolution (settings → env → legacy → default)
 * and the ingest gate that refuses to persist a post already published before
 * its platform's cutoff.
 *
 * The gate matters because an expired opportunity supports no action at all —
 * storing one buys an LLM intent call, a feed row nobody can reply to, and a
 * sweep to clean it up later. A uniform 7 days was wrong in both directions:
 * too long for a timeline post, far too short for a dev.to article.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_OPPORTUNITY_TTL_DAYS_BY_PLATFORM,
  ENGAGE_OPPORTUNITY_TTL_DAYS_BY_PLATFORM_KEY,
  ENGAGE_OPPORTUNITY_TTL_DAYS_KEY,
  ENGAGE_SCAN_PACING_KEY,
  EngageScanConfigService,
  SCANNABLE_PLATFORMS,
  fallbackOpportunityTtlDays,
  opportunityExpiryCutoff,
  resolveOpportunityTtlFor,
} from '../engage-scan-config.service';
import { EngageScanIngestService } from '../engage-scan-ingest.service';

const DAY = 86_400_000;

function settingsMock(store: Record<string, any> = {}) {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    set: vi.fn(async (key: string, value: any) => {
      store[key] = value;
    }),
    _store: store,
  } as any;
}

describe('opportunity TTL resolution (per platform)', () => {
  const envBackup = { ...process.env };
  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('defaults differ per platform: dev.to outlives X by weeks', async () => {
    const svc = new EngageScanConfigService(settingsMock());
    expect(await svc.getOpportunityTtlDays('devto')).toBe(30);
    expect(await svc.getOpportunityTtlDays('x')).toBe(3);
    expect(await svc.getOpportunityTtlDays('hackernews')).toBe(2);
  });

  it('prefers the stored per-platform map; an unset sibling falls through', async () => {
    const svc = new EngageScanConfigService(
      settingsMock({ [ENGAGE_OPPORTUNITY_TTL_DAYS_BY_PLATFORM_KEY]: { devto: 14 } })
    );
    expect(await svc.resolveOpportunityTtlDays('devto')).toEqual({
      value: 14,
      source: 'db',
    });
    expect((await svc.resolveOpportunityTtlDays('x')).value).toBe(3);
  });

  it('falls back to the per-platform env var, then to the legacy single-value setting', async () => {
    process.env.ENGAGE_MEDIUM_OPPORTUNITY_TTL_DAYS = '45';
    const svc = new EngageScanConfigService(
      settingsMock({ [ENGAGE_OPPORTUNITY_TTL_DAYS_KEY]: 9 })
    );
    expect(await svc.resolveOpportunityTtlDays('medium')).toEqual({
      value: 45,
      source: 'env',
    });
    // No per-platform value anywhere → the legacy key still governs, so an
    // existing deployment keeps the number it configured.
    expect(await svc.resolveOpportunityTtlDays('quora')).toEqual({
      value: 9,
      source: 'db',
    });
  });

  it('seeds the per-platform map from the legacy value so an upgrade changes nothing', async () => {
    const settings = settingsMock({
      [ENGAGE_SCAN_PACING_KEY]: { workflow: {} },
      [ENGAGE_OPPORTUNITY_TTL_DAYS_KEY]: 5,
    });
    await new EngageScanConfigService(settings).onModuleInit();
    const seeded = settings._store[ENGAGE_OPPORTUNITY_TTL_DAYS_BY_PLATFORM_KEY];
    expect(Object.keys(seeded).sort()).toEqual([...SCANNABLE_PLATFORMS].sort());
    expect(new Set(Object.values(seeded))).toEqual(new Set([5]));
  });

  it('seeds the per-platform defaults when no legacy value was ever configured', async () => {
    const settings = settingsMock({ [ENGAGE_SCAN_PACING_KEY]: { workflow: {} } });
    await new EngageScanConfigService(settings).onModuleInit();
    expect(settings._store[ENGAGE_OPPORTUNITY_TTL_DAYS_BY_PLATFORM_KEY]).toEqual(
      DEFAULT_OPPORTUNITY_TTL_DAYS_BY_PLATFORM
    );
  });

  it('getOpportunityTtlDaysMap covers every scannable platform', async () => {
    const svc = new EngageScanConfigService(settingsMock());
    const map = await svc.getOpportunityTtlDaysMap();
    expect(Object.keys(map).sort()).toEqual([...SCANNABLE_PLATFORMS].sort());
  });

  it('fallbackOpportunityTtlDays mirrors the env/default rungs without Settings', () => {
    expect(fallbackOpportunityTtlDays('devto')).toBe(30);
  });

  it('resolves the whole map from ONE pair of Settings reads', async () => {
    // The ingest gate runs this per batch and SettingsService.get is an
    // uncached findUnique, so resolving platform-by-platform would put 7-14
    // round-trips on the hot path.
    const settings = settingsMock({
      [ENGAGE_OPPORTUNITY_TTL_DAYS_BY_PLATFORM_KEY]: { x: 3 },
    });
    await new EngageScanConfigService(settings).getOpportunityTtlDaysMap();
    expect(settings.get).toHaveBeenCalledTimes(2);
  });

  it('does NOT let the legacy value shadow a platform missing from a stored map', () => {
    // A platform added to SCANNABLE_PLATFORMS later is absent from the stored
    // map; the legacy key (seeded to 7 on every fresh install) must not quietly
    // override the default chosen for it.
    expect(resolveOpportunityTtlFor('devto', { x: 3 }, 7)).toEqual({
      value: 30,
      source: 'default',
    });
    // With no map at all, the legacy value still governs — that is the upgrade
    // path for a deployment that configured the old key.
    expect(resolveOpportunityTtlFor('devto', null, 7)).toEqual({
      value: 7,
      source: 'db',
    });
  });
});

describe('opportunityExpiryCutoff', () => {
  it('returns now - days for a configured platform', () => {
    const now = 1_800_000_000_000;
    expect(opportunityExpiryCutoff('x', { x: 3 }, now)).toEqual(
      new Date(now - 3 * DAY)
    );
  });

  it('returns null for a platform with no configured TTL, so nothing is dropped', () => {
    // A scanner for a brand-new platform must not silently ingest zero rows
    // just because the TTL map has not been extended yet.
    expect(opportunityExpiryCutoff('mastodon', { x: 3 })).toBeNull();
    expect(opportunityExpiryCutoff('x', { x: 0 } as any)).toBeNull();
  });
});

// ─── ingest gate ─────────────────────────────────────────────────────────────

function post(over: any = {}): any {
  return {
    id: 'p1',
    platform: 'reddit',
    externalPostId: 't3_1',
    externalPostUrl: 'https://reddit.com/1',
    authorUsername: 'u1',
    postContent: 'react and nextjs',
    postPublishedAt: new Date(Date.now() - 60 * 60 * 1000),
    channelId: 'webdev',
    metricLikes: 0, metricReplies: 0, metricRetweets: 0, metricQuotes: 0,
    metricScore: 200, metricComments: 50,
    score: 70, scoreKeyword: 30, scoreTracked: 0,
    scoreHeat: 18, scoreAuthority: 8, scoreRecency: 4,
    matchedKeywords: ['react'],
    intentTags: ['support'], primaryIntent: 'support', intentScore: 0.8,
    ...over,
  };
}

function buildIngest(ttl?: Record<string, number>) {
  const oppFindFirst = vi.fn(async () => null);
  const oppUpsert = vi.fn(async (args: any) => ({
    id: `opp_${args.where.platform_externalPostId.externalPostId}`,
  }));
  const stateFindFirst = vi.fn(async () => null);
  const stateCreate = vi.fn(async () => ({ id: 'st1' }));
  const scanConfig = ttl
    ? ({ getOpportunityTtlDaysMap: vi.fn(async () => ttl) } as any)
    : undefined;
  const svc = new EngageScanIngestService(
    { model: { engageOpportunity: { findFirst: oppFindFirst, upsert: oppUpsert, update: vi.fn() } } } as any,
    { model: { engageOpportunityState: { findFirst: stateFindFirst, create: stateCreate, update: vi.fn(), upsert: vi.fn() } } } as any,
    { model: { engageKeyword: { findMany: vi.fn(async () => []), update: vi.fn() } } } as any,
    { classifyBatch: vi.fn(async () => ({})) } as any,
    { model: { $transaction: vi.fn(async (ops: any[]) => ops) } } as any,
    scanConfig
  );
  return { svc, oppUpsert, stateCreate };
}

describe('EngageScanIngestService TTL gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('judges each post against ITS OWN platform, not the batch', async () => {
    // Same age (5 days) — expired for X (3d) but fresh for dev.to (30d). A
    // per-batch cutoff would wrongly keep or drop both.
    const { svc } = buildIngest({ x: 3, devto: 30 });
    const age = new Date(Date.now() - 5 * DAY);
    const { kept, dropped } = await svc.filterExpiredByPublishTime([
      post({ platform: 'x', postPublishedAt: age }),
      post({ platform: 'devto', postPublishedAt: age }),
    ]);
    expect(dropped).toBe(1);
    expect(kept.map((p: any) => p.platform)).toEqual(['devto']);
  });

  it('keeps a post whose platform has no configured TTL', async () => {
    const { svc } = buildIngest({ x: 3 });
    const { kept, dropped } = await svc.filterExpiredByPublishTime([
      post({ platform: 'mastodon', postPublishedAt: new Date(Date.now() - 400 * DAY) }),
    ]);
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(1);
  });

  it('persistOpportunities writes nothing for an expired post (the workflow path)', async () => {
    // The Temporal scan activity calls persistOpportunities directly, bypassing
    // ingestForOrg — so the gate has to hold here, not only in ingestForOrg.
    const { svc, oppUpsert, stateCreate } = buildIngest({ reddit: 7 });
    await svc.persistOpportunities('org1', null, [
      post({ postPublishedAt: new Date(Date.now() - 8 * DAY) }),
    ]);
    expect(oppUpsert).not.toHaveBeenCalled();
    expect(stateCreate).not.toHaveBeenCalled();
  });

  it('persistOpportunities still writes a post inside the window', async () => {
    const { svc, oppUpsert } = buildIngest({ reddit: 7 });
    await svc.persistOpportunities('org1', null, [
      post({ postPublishedAt: new Date(Date.now() - 6 * DAY) }),
    ]);
    expect(oppUpsert).toHaveBeenCalledTimes(1);
  });

  it('ingestForOrg drops an expired post before paying for intent classification', async () => {
    const { svc, oppUpsert } = buildIngest({ reddit: 7 });
    const classify = vi.spyOn(svc, 'classifyIntents');
    const n = await svc.ingestForOrg(
      {
        organizationId: 'org1',
        projectId: null,
        keywords: [{ id: 'k1', keyword: 'react', type: 'GLOBAL', enabled: true } as any],
        trackedAccounts: [],
        monitoredChannels: [],
      },
      [post({ postPublishedAt: new Date(Date.now() - 30 * DAY) })]
    );
    expect(n).toBe(0);
    expect(classify).not.toHaveBeenCalled();
    expect(oppUpsert).not.toHaveBeenCalled();
  });

  it('attributeExisting does not resurrect an expired opportunity', async () => {
    const { svc, stateCreate } = buildIngest({ reddit: 7 });
    const written = await svc.attributeExisting(
      {
        organizationId: 'org1',
        projectId: null,
        keywords: [{ id: 'k1', keyword: 'react', type: 'GLOBAL', enabled: true } as any],
        trackedAccounts: [],
        monitoredChannels: [],
      },
      [
        {
          id: 'opp1',
          platform: 'reddit',
          externalPostId: 't3_1',
          externalPostUrl: 'https://reddit.com/1',
          channelId: 'webdev',
          channelName: null,
          channelFollowers: 5000,
          authorUsername: 'u1',
          authorDisplayName: null,
          authorFollowers: null,
          authorAvatarUrl: null,
          title: null,
          postContent: 'react and nextjs are great',
          postPublishedAt: new Date(Date.now() - 60 * DAY),
          metricLikes: 0, metricReplies: 0, metricRetweets: 0, metricQuotes: 0,
          metricBookmarks: 0, metricViews: 0, metricShares: 0, metricSaves: 0,
          metricScore: 200, metricUpvoteRatio: null, metricComments: 50,
        },
      ]
    );
    expect(written).toBe(0);
    expect(stateCreate).not.toHaveBeenCalled();
  });

  it('degrades to env/default TTLs when no config service is wired', async () => {
    const { svc } = buildIngest(); // no EngageScanConfigService
    const { dropped } = await svc.filterExpiredByPublishTime([
      post({ platform: 'x', postPublishedAt: new Date(Date.now() - 10 * DAY) }),
      post({ platform: 'devto', postPublishedAt: new Date(Date.now() - 10 * DAY) }),
    ]);
    expect(dropped).toBe(1); // x (3d) drops, devto (30d) survives
  });
});

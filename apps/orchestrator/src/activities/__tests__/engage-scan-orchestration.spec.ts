import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngageScanActivity } from '../engage-scan.activity';
import { TokenPool } from '@gitroom/nestjs-libraries/engage/scan/token-pool';
import type { ScanResult } from '@gitroom/nestjs-libraries/engage/scan/platform-scan-adapter';
import { getRedditUserAbout } from '@gitroom/nestjs-libraries/engage/engage-author';

// The Reddit author /about lookup hits Redis + network; stub it so _fanOutToOrg
// enrichment is deterministic.
vi.mock('@gitroom/nestjs-libraries/engage/engage-author', () => ({
  getRedditUserAbout: vi.fn().mockResolvedValue({ followers: 0 }),
}));

// Builds an activity wired to a fake EngageScanCursor repo. `row` is what the
// claim upsert returns; `claimCount` is what the IDLE→SCANNING updateMany
// reports (1 = won the single-flight, 0 = lost it).
function build(row: any, claimCount = 1) {
  const upsert = vi.fn().mockResolvedValue(row);
  const updateMany = vi.fn().mockResolvedValue({ count: claimCount });
  const update = vi.fn().mockResolvedValue({});
  const cursorRepo = {
    model: { engageScanCursor: { upsert, updateMany, update } },
  };
  const activity = new EngageScanActivity(
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any,
    cursorRepo as any,
    {} as any
  );
  return { activity, upsert, updateMany, update };
}

const IDLE_ROW = {
  id: 'cur1',
  status: 'IDLE',
  cooldownUntil: null as Date | null,
  lastSeenExternalId: '100',
  lastSeenAt: new Date('2026-01-01T00:00:00Z'),
};

function fakeAdapter(result: ScanResult) {
  return { platform: 'x', caps: {} as any, searchScoped: vi.fn().mockResolvedValue(result) };
}

function scanArgs(over: Record<string, unknown> = {}) {
  return {
    platform: 'x',
    scanType: 'keyword',
    scanKey: '__global__',
    scope: { type: 'keyword' },
    keywords: ['AI'],
    cadenceMs: 24 * 3_600_000,
    xPool: new TokenPool(['tkn']),
    ...over,
  };
}

describe('EngageScanActivity._scanUnit (cursor lifecycle)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('claims IDLE→SCANNING, passes the stored cursor to the adapter, then completes', async () => {
    const { activity, upsert, updateMany, update } = build(IDLE_ROW);
    const result: ScanResult = {
      posts: [{ externalPostId: 'x1' } as any],
      nextCursor: { lastSeenExternalId: '200', lastSeenAt: new Date('2026-02-02T00:00:00Z') },
      rate: { limited: false },
    };
    const adapter = fakeAdapter(result);
    (activity as any)._xAdapter = adapter;

    const out = await (activity as any)._scanUnit(scanArgs());

    expect(upsert).toHaveBeenCalledTimes(1);
    // Claim: IDLE→SCANNING + lastScanStartedAt.
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cur1', status: 'IDLE' },
        data: expect.objectContaining({ status: 'SCANNING' }),
      })
    );
    // Adapter received the persisted incremental cursor.
    expect(adapter.searchScoped).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { lastSeenExternalId: '100', lastSeenAt: IDLE_ROW.lastSeenAt },
      })
    );
    // Complete: advance cursor, IDLE, clear cooldown.
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cur1' },
        data: expect.objectContaining({
          status: 'IDLE',
          lastSeenExternalId: '200',
          cooldownUntil: null,
        }),
      })
    );
    expect(out.posts).toHaveLength(1);
  });

  it('skips a cooling-down unit without calling the adapter', async () => {
    const future = new Date(Date.now() + 60_000);
    const { activity, updateMany } = build({ ...IDLE_ROW, cooldownUntil: future });
    const adapter = fakeAdapter({ posts: [], nextCursor: {}, rate: { limited: false } });
    (activity as any)._xAdapter = adapter;

    const out = await (activity as any)._scanUnit(scanArgs());

    expect(out.posts).toEqual([]);
    expect(updateMany).not.toHaveBeenCalled(); // never claimed
    expect(adapter.searchScoped).not.toHaveBeenCalled();
  });

  it('skips a unit already SCANNING (single-flight)', async () => {
    const { activity, updateMany } = build({ ...IDLE_ROW, status: 'SCANNING' });
    const adapter = fakeAdapter({ posts: [], nextCursor: {}, rate: { limited: false } });
    (activity as any)._xAdapter = adapter;

    const out = await (activity as any)._scanUnit(scanArgs());
    expect(out.posts).toEqual([]);
    expect(updateMany).not.toHaveBeenCalled();
    expect(adapter.searchScoped).not.toHaveBeenCalled();
  });

  it('returns empty when it loses the claim race (updateMany count 0)', async () => {
    const { activity, update } = build(IDLE_ROW, 0);
    const adapter = fakeAdapter({ posts: [], nextCursor: {}, rate: { limited: false } });
    (activity as any)._xAdapter = adapter;

    const out = await (activity as any)._scanUnit(scanArgs());
    expect(out.posts).toEqual([]);
    expect(adapter.searchScoped).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('cools down (does NOT advance cursor) when the adapter reports a rate limit', async () => {
    const { activity, update } = build(IDLE_ROW);
    const adapter = fakeAdapter({
      posts: [],
      nextCursor: { lastSeenExternalId: '999' },
      rate: { limited: true, retryAfterMs: 30_000 },
    });
    (activity as any)._xAdapter = adapter;

    await (activity as any)._scanUnit(scanArgs());

    const call = update.mock.calls[0][0];
    expect(call.data.cooldownUntil).toBeInstanceOf(Date);
    // Cursor must NOT be advanced on a rate-limit (retry from the same point).
    expect(call.data).not.toHaveProperty('lastSeenExternalId');
  });

  it('releases the cursor without advancing when call budget is exhausted with backlog remaining', async () => {
    const { activity, update } = build(IDLE_ROW);
    const adapter = fakeAdapter({
      posts: [{ externalPostId: 'x1' } as any],
      nextCursor: { lastSeenExternalId: '999' },
      rate: { limited: false },
      backlogRemaining: true,
    });
    (activity as any)._xAdapter = adapter;

    const out = await (activity as any)._scanUnit(scanArgs());

    expect(out).toEqual({
      ran: true,
      posts: [{ externalPostId: 'x1' }],
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cur1' }, data: { status: 'IDLE' } })
    );
    expect(update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastSeenExternalId: '999' }),
      })
    );
  });

  it('releases the SCANNING lock when the adapter throws', async () => {
    const { activity, update } = build(IDLE_ROW);
    const adapter = { platform: 'x', caps: {} as any, searchScoped: vi.fn().mockRejectedValue(new Error('boom')) };
    (activity as any)._xAdapter = adapter;

    const out = await (activity as any)._scanUnit(scanArgs());
    expect(out.posts).toEqual([]);
    // Released to IDLE, cursor untouched.
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cur1' }, data: { status: 'IDLE' } })
    );
  });

  it('skips an X unit (releasing the lock) when the token pool is exhausted', async () => {
    const { activity, update } = build(IDLE_ROW);
    const adapter = fakeAdapter({ posts: [], nextCursor: {}, rate: { limited: false } });
    (activity as any)._xAdapter = adapter;

    const out = await (activity as any)._scanUnit(scanArgs({ xPool: new TokenPool([]) }));
    expect(out.posts).toEqual([]);
    expect(adapter.searchScoped).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cur1' }, data: { status: 'IDLE' } })
    );
  });

  it('skips a unit scanned within its cadence (not due)', async () => {
    // keyword cadence defaults to 24h; lastScanStartedAt 1h ago → not due.
    const recent = new Date(Date.now() - 60 * 60 * 1000);
    const { activity, updateMany } = build({ ...IDLE_ROW, lastScanStartedAt: recent });
    const adapter = fakeAdapter({ posts: [], nextCursor: {}, rate: { limited: false } });
    (activity as any)._xAdapter = adapter;

    const out = await (activity as any)._scanUnit(scanArgs());
    expect(out.ran).toBe(false);
    expect(updateMany).not.toHaveBeenCalled(); // cadence gate → never claimed
    expect(adapter.searchScoped).not.toHaveBeenCalled();
  });

  it('force bypasses the cadence gate', async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000); // well within 24h cadence
    const { activity, updateMany } = build({ ...IDLE_ROW, lastScanStartedAt: recent });
    const adapter = fakeAdapter({
      posts: [],
      nextCursor: { lastSeenExternalId: '5' },
      rate: { limited: false },
    });
    (activity as any)._xAdapter = adapter;

    const out = await (activity as any)._scanUnit(scanArgs({ force: true }));
    expect(out.ran).toBe(true);
    expect(updateMany).toHaveBeenCalled(); // claimed despite the recent scan
    expect(adapter.searchScoped).toHaveBeenCalled();
  });
});

describe('EngageScanActivity._fanOutAndFinalize (per-org isolation)', () => {
  beforeEach(() => vi.clearAllMocks());

  // Regression for review W7: one org's persist failure must NOT abort the tick
  // for the other orgs (cursors have already advanced; the activity runs with
  // maximumAttempts:1, so an aborted tick silently drops opportunities org-wide).
  it('isolates a single org fan-out failure; still expires + finalizes every org', async () => {
    const { activity } = build(IDLE_ROW);
    const orgs = [
      { organizationId: 'a', keywords: ['x'], trackedAccounts: [] },
      { organizationId: 'b', keywords: ['x'], trackedAccounts: [] },
      { organizationId: 'c', keywords: ['x'], trackedAccounts: [] },
    ] as any[];

    const fanOut = vi
      .spyOn(activity as any, '_fanOutToOrg')
      .mockImplementation(async (ctx: any) => {
        if (ctx.organizationId === 'b') throw new Error('transient persist error');
      });
    const expire = vi
      .spyOn(activity as any, '_expireStaleOpportunities')
      .mockResolvedValue(undefined);
    const finalize = vi
      .spyOn(activity as any, '_finalizeAllOrgs')
      .mockResolvedValue(undefined);

    const posts = [{ platform: 'x', externalPostId: '1', authorUsername: 'u' }] as any[];

    // Must not throw despite org 'b' rejecting.
    await expect(
      (activity as any)._fanOutAndFinalize(orgs, posts)
    ).resolves.toBeUndefined();

    expect(fanOut).toHaveBeenCalledTimes(3);
    // Expiry runs once per org regardless of fan-out outcome (no double-call).
    expect(expire).toHaveBeenCalledTimes(3);
    // Finalize still runs for the whole set.
    expect(finalize).toHaveBeenCalledTimes(1);
  });
});

describe('EngageScanActivity keyword initial scans', () => {
  const initialSettings = {
    enabledPlatforms: ['reddit'],
    lookbackHours: 24,
    maxAttempts: 3,
    retryMs: 15 * 60 * 1000,
    staleMs: 30 * 60 * 1000,
    budget: {
      reddit: { maxUnits: 10, maxCalls: 2 },
      x: { maxUnits: 5, maxCalls: 1 },
    },
  };

  beforeEach(() => vi.clearAllMocks());

  it('lazily creates missing initial scan rows for enabled platforms', async () => {
    const { activity } = build(IDLE_ROW);
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    (activity as any)._keywordInitialScan = {
      model: { engageKeywordInitialScan: { createMany } },
    };

    await (activity as any)._ensureMissingKeywordInitialScans(
      [
        {
          organizationId: 'org1',
          keywords: [
            { id: 'kw1', keyword: 'storage' },
            { id: 'kw2', keyword: 'AI PC' },
          ],
        },
      ],
      ['reddit', 'x']
    );

    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          organizationId: 'org1',
          keywordId: 'kw1',
          keyword: 'storage',
          platform: 'reddit',
          status: 'PENDING',
        },
        {
          organizationId: 'org1',
          keywordId: 'kw1',
          keyword: 'storage',
          platform: 'x',
          status: 'PENDING',
        },
        {
          organizationId: 'org1',
          keywordId: 'kw2',
          keyword: 'AI PC',
          platform: 'reddit',
          status: 'PENDING',
        },
        {
          organizationId: 'org1',
          keywordId: 'kw2',
          keyword: 'AI PC',
          platform: 'x',
          status: 'PENDING',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('loads initial scan config from Settings with env/default fallback', async () => {
    const { activity } = build(IDLE_ROW);
    (activity as any)._settingsService = {
      listByPrefix: vi.fn().mockResolvedValue([
        {
          key: 'engage.keyword_initial_scan.enabled_platforms',
          value: ['reddit', 'x'],
        },
        {
          key: 'engage.keyword_initial_scan.reddit.max_units',
          value: 12,
        },
        {
          key: 'engage.keyword_initial_scan.x.max_calls',
          value: 2,
        },
      ]),
    };

    await expect((activity as any)._loadInitialScanSettings()).resolves.toEqual(
      expect.objectContaining({
        enabledPlatforms: ['reddit', 'x'],
        budget: {
          reddit: { maxUnits: 12, maxCalls: 2 },
          x: { maxUnits: 5, maxCalls: 2 },
        },
      })
    );
  });

  it('claims pending reddit keyword initial scans, scans them in one batch, then marks them DONE', async () => {
    const { activity } = build(IDLE_ROW);
    const initialFindMany = vi.fn().mockResolvedValue([
      {
        id: 'init1',
        organizationId: 'org1',
        keywordId: 'kw1',
        keyword: 'storage',
        platform: 'reddit',
        status: 'PENDING',
        keywordRef: {
          id: 'kw1',
          organizationId: 'org1',
          keyword: 'storage',
          enabled: true,
        },
      },
      {
        id: 'init2',
        organizationId: 'org1',
        keywordId: 'kw2',
        keyword: 'AI PC',
        platform: 'reddit',
        status: 'PENDING',
        keywordRef: {
          id: 'kw2',
          organizationId: 'org1',
          keyword: 'AI PC',
          enabled: true,
        },
      },
    ]);
    const initialUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    (activity as any)._keywordInitialScan = {
      model: {
        engageKeywordInitialScan: {
          findMany: initialFindMany,
          updateMany: initialUpdateMany,
        },
      },
    };
    const post = {
      platform: 'reddit',
      externalPostId: 'p1',
      authorUsername: 'u',
      postContent: 'storage issue',
    } as any;
    const adapter = {
      platform: 'reddit',
      caps: {} as any,
      searchScoped: vi.fn().mockResolvedValue({
        posts: [post],
        nextCursor: {},
        rate: { limited: false },
      }),
    };
    (activity as any)._redditAdapter = adapter;
    const fanOut = vi
      .spyOn(activity as any, '_fanOutToOrg')
      .mockResolvedValue(undefined);

    await (activity as any)._runPendingKeywordInitialScans(
      [
        {
          organizationId: 'org1',
          keywords: [
            { id: 'kw1', keyword: 'storage', enabled: true },
            { id: 'kw2', keyword: 'AI PC', enabled: true },
          ],
          trackedAccounts: [],
        },
      ],
      'reddit-token',
      {} as any,
      initialSettings
    );

    expect(initialFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          platform: 'reddit',
          organizationId: { in: ['org1'] },
        }),
      })
    );
    expect(initialUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'init1',
          OR: expect.arrayContaining([{ status: 'PENDING' }]),
        }),
        data: expect.objectContaining({
          status: 'RUNNING',
          keyword: 'storage',
          attempts: { increment: 1 },
        }),
      })
    );
    expect(adapter.searchScoped).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { type: 'keyword' },
        keywords: ['storage', 'AI PC'],
        token: 'reddit-token',
        cursor: expect.objectContaining({ lastSeenAt: expect.any(Date) }),
      })
    );
    expect(fanOut).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org1' }),
      [post]
    );
    expect(adapter.searchScoped).toHaveBeenCalledTimes(1);
    expect(initialUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['init1', 'init2'] } },
        data: expect.objectContaining({
          status: 'DONE',
          completedAt: expect.any(Date),
          error: null,
        }),
      })
    );
  });

  it('keeps a rate-limited keyword initial scan retryable instead of marking it DONE', async () => {
    const { activity } = build(IDLE_ROW);
    const initialFindMany = vi.fn().mockResolvedValue([
      {
        id: 'init1',
        organizationId: 'org1',
        keywordId: 'kw1',
        keyword: 'storage',
        platform: 'reddit',
        status: 'PENDING',
        keywordRef: {
          id: 'kw1',
          organizationId: 'org1',
          keyword: 'storage',
          enabled: true,
        },
      },
    ]);
    const initialUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    (activity as any)._keywordInitialScan = {
      model: {
        engageKeywordInitialScan: {
          findMany: initialFindMany,
          updateMany: initialUpdateMany,
        },
      },
    };
    const post = {
      platform: 'reddit',
      externalPostId: 'p1',
      authorUsername: 'u',
      postContent: 'storage issue',
    } as any;
    (activity as any)._redditAdapter = {
      platform: 'reddit',
      caps: {} as any,
      searchScoped: vi.fn().mockResolvedValue({
        posts: [post],
        nextCursor: {},
        rate: { limited: true, retryAfterMs: 60_000 },
      }),
    };
    const fanOut = vi
      .spyOn(activity as any, '_fanOutToOrg')
      .mockResolvedValue(undefined);

    await (activity as any)._runPendingKeywordInitialScans(
      [
        {
          organizationId: 'org1',
          keywords: [{ id: 'kw1', keyword: 'storage', enabled: true }],
          trackedAccounts: [],
        },
      ],
      null,
      {} as any,
      initialSettings
    );

    expect(fanOut).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org1' }),
      [post]
    );
    expect(initialUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['init1'] } },
        data: expect.objectContaining({
          status: 'FAILED',
          error: expect.stringContaining('rate-limited'),
        }),
      })
    );
    expect(initialUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DONE' }),
      })
    );
  });

  it('keeps a budget-exhausted keyword initial scan retryable after fan-out', async () => {
    const { activity } = build(IDLE_ROW);
    const initialFindMany = vi.fn().mockResolvedValue([
      {
        id: 'init1',
        organizationId: 'org1',
        keywordId: 'kw1',
        keyword: 'storage',
        platform: 'reddit',
        status: 'PENDING',
        keywordRef: {
          id: 'kw1',
          organizationId: 'org1',
          keyword: 'storage',
          enabled: true,
        },
      },
    ]);
    const initialUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    (activity as any)._keywordInitialScan = {
      model: {
        engageKeywordInitialScan: {
          findMany: initialFindMany,
          updateMany: initialUpdateMany,
        },
      },
    };
    const post = {
      platform: 'reddit',
      externalPostId: 'p1',
      authorUsername: 'u',
      postContent: 'storage issue',
    } as any;
    (activity as any)._redditAdapter = {
      platform: 'reddit',
      caps: {} as any,
      searchScoped: vi.fn().mockResolvedValue({
        posts: [post],
        nextCursor: { lastSeenExternalId: 'later' },
        rate: { limited: false },
        backlogRemaining: true,
      }),
    };
    const fanOut = vi
      .spyOn(activity as any, '_fanOutToOrg')
      .mockResolvedValue(undefined);

    await (activity as any)._runPendingKeywordInitialScans(
      [
        {
          organizationId: 'org1',
          keywords: [{ id: 'kw1', keyword: 'storage', enabled: true }],
          trackedAccounts: [],
        },
      ],
      null,
      {} as any,
      initialSettings
    );

    expect(fanOut).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org1' }),
      [post]
    );
    expect(initialUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['init1'] } },
        data: expect.objectContaining({
          status: 'FAILED',
          error: expect.stringContaining('backlog remains'),
        }),
      })
    );
    expect(initialUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DONE' }),
      })
    );
  });

  it('runs X keyword initial scans with empty cursor and X-specific budget', async () => {
    const { activity } = build(IDLE_ROW);
    const initialFindMany = vi.fn().mockResolvedValue([
      {
        id: 'init-x1',
        organizationId: 'org1',
        keywordId: 'kw1',
        keyword: 'AI PC',
        platform: 'x',
        status: 'PENDING',
        keywordRef: {
          id: 'kw1',
          organizationId: 'org1',
          keyword: 'AI PC',
          enabled: true,
        },
      },
    ]);
    const initialUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    (activity as any)._keywordInitialScan = {
      model: {
        engageKeywordInitialScan: {
          findMany: initialFindMany,
          updateMany: initialUpdateMany,
        },
      },
    };
    const post = {
      platform: 'x',
      externalPostId: 'tweet-1',
      authorUsername: 'u',
      postContent: 'AI PC news',
    } as any;
    const adapter = {
      platform: 'x',
      caps: {} as any,
      searchScoped: vi.fn().mockResolvedValue({
        posts: [post],
        nextCursor: {},
        rate: { limited: false, remaining: 10 },
      }),
    };
    (activity as any)._xAdapter = adapter;
    const fanOut = vi
      .spyOn(activity as any, '_fanOutToOrg')
      .mockResolvedValue(undefined);
    const xPool = {
      size: 1,
      available: vi.fn().mockReturnValue(1),
      acquire: vi.fn().mockReturnValue('x-token'),
      report: vi.fn(),
    };

    await (activity as any)._runPendingKeywordInitialScans(
      [
        {
          organizationId: 'org1',
          keywords: [{ id: 'kw1', keyword: 'AI PC', enabled: true }],
          trackedAccounts: [],
        },
      ],
      null,
      xPool,
      {
        ...initialSettings,
        enabledPlatforms: ['x'],
      }
    );

    expect(adapter.searchScoped).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { type: 'keyword' },
        keywords: ['AI PC'],
        cursor: {},
        budget: { maxCalls: 1 },
        token: 'x-token',
      })
    );
    expect(xPool.report).toHaveBeenCalledWith('x-token', {
      limited: false,
      remaining: 10,
    });
    expect(fanOut).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org1' }),
      [post]
    );
    expect(initialUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['init-x1'] } },
        data: expect.objectContaining({ status: 'DONE' }),
      })
    );
  });

  it('reclaims a stale RUNNING keyword initial scan lease', async () => {
    const { activity } = build(IDLE_ROW);
    const staleStartedAt = new Date(Date.now() - 60 * 60 * 1000);
    const initialFindMany = vi.fn().mockResolvedValue([
      {
        id: 'init1',
        organizationId: 'org1',
        keywordId: 'kw1',
        keyword: 'storage',
        platform: 'reddit',
        status: 'RUNNING',
        attempts: 1,
        startedAt: staleStartedAt,
        keywordRef: {
          id: 'kw1',
          organizationId: 'org1',
          keyword: 'storage',
          enabled: true,
        },
      },
    ]);
    const initialUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    (activity as any)._keywordInitialScan = {
      model: {
        engageKeywordInitialScan: {
          findMany: initialFindMany,
          updateMany: initialUpdateMany,
        },
      },
    };
    (activity as any)._redditAdapter = {
      platform: 'reddit',
      caps: {} as any,
      searchScoped: vi.fn().mockResolvedValue({
        posts: [],
        nextCursor: {},
        rate: { limited: false },
      }),
    };
    vi.spyOn(activity as any, '_fanOutToOrg').mockResolvedValue(undefined);

    await (activity as any)._runPendingKeywordInitialScans(
      [
        {
          organizationId: 'org1',
          keywords: [{ id: 'kw1', keyword: 'storage', enabled: true }],
          trackedAccounts: [],
        },
      ],
      null,
      {} as any,
      initialSettings
    );

    expect(initialFindMany.mock.calls[0][0].where.OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'RUNNING',
          startedAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
      ])
    );
    expect(initialUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'init1',
          OR: expect.arrayContaining([
            expect.objectContaining({
              status: 'RUNNING',
              startedAt: expect.objectContaining({ lt: expect.any(Date) }),
            }),
          ]),
        }),
        data: expect.objectContaining({
          status: 'RUNNING',
          attempts: { increment: 1 },
        }),
      })
    );
    expect(initialUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['init1'] } },
        data: expect.objectContaining({ status: 'DONE' }),
      })
    );
  });
});

describe('EngageScanActivity._fanOutToOrg (Reddit monitored subreddit +5 & followers)', () => {
  // A reddit RawPost that easily clears MIN_SCORE on heat alone (so scoreTracked,
  // not the gate, is what the assertions turn on).
  function redditPost(over: Record<string, unknown> = {}) {
    return {
      id: 'reddit_p1',
      platform: 'reddit',
      externalPostId: 'p1',
      externalPostUrl: 'https://www.reddit.com/r/ClaudeAI/comments/p1/',
      channelId: 'ClaudeAI',
      channelName: 'r/ClaudeAI',
      authorUsername: 'redditor',
      postContent: 'a post about AI tooling',
      postPublishedAt: new Date(),
      metricLikes: 0, metricReplies: 0, metricRetweets: 0, metricQuotes: 0,
      metricBookmarks: 0, metricViews: 0, metricShares: 0, metricSaves: 0,
      metricScore: 5000, metricUpvoteRatio: 1, metricComments: 0,
      ...over,
    } as any;
  }

  function orgCtx(over: Record<string, unknown> = {}) {
    return {
      organizationId: 'o1',
      keywords: [{ keyword: 'AI', type: null, enabled: true }],
      trackedAccounts: [],
      monitoredChannels: [{ platform: 'reddit', channelId: 'ClaudeAI', enabled: true }],
      ...over,
    } as any;
  }

  // Drive _fanOutToOrg with the heavy collaborators stubbed; capture the
  // ScoredPost[] handed to persistence.
  async function run(ctx: any, posts: any[]) {
    const { activity } = build(IDLE_ROW);
    const persisted: any[] = [];
    vi.spyOn(activity as any, '_classifyIntents').mockImplementation(async (p: any) => p);
    vi.spyOn(activity as any, '_persistOpportunities').mockImplementation(
      (async (_org: string, p: any[]) => { persisted.push(...p); }) as any
    );
    vi.spyOn(activity as any, '_updateKeywordHitCounts').mockResolvedValue(undefined);
    await (activity as any)._fanOutToOrg(ctx, posts);
    return persisted;
  }

  beforeEach(() => {
    (getRedditUserAbout as any).mockClear();
    (getRedditUserAbout as any).mockResolvedValue({ followers: 0 });
  });

  it('keyword post in a monitored subreddit earns scoreTracked +5', async () => {
    const persisted = await run(orgCtx(), [redditPost()]);
    const out = persisted.find((p) => p.externalPostId === 'p1');
    expect(out).toBeDefined();
    expect(out.scoreTracked).toBe(5);
    expect(out.score).toBe(
      out.scoreKeyword + out.scoreHeat + out.scoreAuthority + out.scoreRecency + 5
    );
  });

  it('keyword post in a NON-monitored subreddit earns no bonus', async () => {
    const persisted = await run(orgCtx(), [redditPost({ channelId: 'SomeOtherSub' })]);
    const out = persisted.find((p) => p.externalPostId === 'p1');
    expect(out.scoreTracked).toBe(0);
  });

  it('enriches authorFollowers from the cached /about lookup → authority', async () => {
    (getRedditUserAbout as any).mockResolvedValue({ followers: 60_000 });
    const persisted = await run(orgCtx(), [redditPost()]);
    const out = persisted.find((p) => p.externalPostId === 'p1');
    expect(getRedditUserAbout).toHaveBeenCalledWith('redditor', expect.any(Function));
    expect(out.authorFollowers).toBe(60_000);
    expect(out.scoreAuthority).toBe(15); // 60k > 50k on the follower curve
  });
});

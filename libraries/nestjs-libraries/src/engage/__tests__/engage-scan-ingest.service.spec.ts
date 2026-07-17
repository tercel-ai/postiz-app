import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EngageScanIngestService,
  normalizeExternalPost,
  normalizeExternalPostUrl,
} from '../engage-scan-ingest.service';

function makeScoredPost(n: number): any {
  return {
    id: `p${n}`,
    platform: 'reddit',
    externalPostId: `t3_${n}`,
    externalPostUrl: `https://reddit.com/${n}`,
    authorUsername: `u${n}`,
    postContent: `react and nextjs ${n}`,
    postPublishedAt: new Date('2026-06-17T10:00:00.000Z'),
    channelId: 'webdev',
    metricLikes: 0,
    metricReplies: 0,
    metricRetweets: 0,
    metricQuotes: 0,
    metricScore: 5,
    metricComments: 2,
    score: 70,
    scoreKeyword: 30,
    scoreTracked: 0,
    scoreHeat: 18,
    scoreAuthority: 8,
    scoreRecency: 4,
    matchedKeywords: ['react', 'nextjs'],
    intentTags: ['support'],
    primaryIntent: 'support',
    intentScore: 0.8,
  };
}

function build() {
  const oppFindFirst = vi.fn(async () => null);
  const oppUpsert = vi.fn(async (args: any) => ({
    id: `opp_${args.where.platform_externalPostId.externalPostId}`,
  }));
  const oppUpdate = vi.fn(async (args: any) => ({ id: args.where.id }));
  // projectId defaults to null in every test below (the legacy, pre-project
  // config) — a nullable column can't back a compound-unique upsert
  // (Postgres NULL != NULL), so state writes go through findFirst + create/
  // update, not upsert. stateUpsert is exercised separately by the
  // projectId-not-null tests.
  const stateFindFirst = vi.fn(async () => null);
  const stateCreate = vi.fn(async (args: any) => ({ id: 'new-state-id', ...args.data }));
  const stateUpdate = vi.fn(async (args: any) => ({ id: args.where.id }));
  const stateUpsert = vi.fn(async () => ({}));
  const kwFindMany = vi.fn(async () => []);
  const kwUpdate = vi.fn(async () => ({}));
  const txRun = vi.fn(async (ops: any[]) => ops);

  const svc = new EngageScanIngestService(
    { model: { engageOpportunity: { findFirst: oppFindFirst, upsert: oppUpsert, update: oppUpdate } } } as any,
    {
      model: {
        engageOpportunityState: {
          findFirst: stateFindFirst,
          create: stateCreate,
          update: stateUpdate,
          upsert: stateUpsert,
        },
      },
    } as any,
    { model: { engageKeyword: { findMany: kwFindMany, update: kwUpdate } } } as any,
    { classifyBatch: vi.fn(async () => ({})) } as any,
    { model: { $transaction: txRun } } as any
  );
  return {
    svc,
    oppFindFirst,
    oppUpsert,
    oppUpdate,
    stateFindFirst,
    stateCreate,
    stateUpdate,
    stateUpsert,
    kwFindMany,
    kwUpdate,
    txRun,
  };
}

describe('engage scan post canonicalization', () => {
  it('strips X status tracking params and normalizes twitter.com to x.com', () => {
    expect(
      normalizeExternalPostUrl(
        'x',
        'https://twitter.com/elonmusk/status/2075259819154341957?s=20'
      )
    ).toBe('https://x.com/elonmusk/status/2075259819154341957');
  });

  it('uses the X status id from the URL as the stable externalPostId', () => {
    expect(
      normalizeExternalPost({
        ...makeScoredPost(1),
        platform: 'x',
        externalPostId: 'unstable-share-id',
        externalPostUrl: 'https://x.com/elonmusk/status/2075259819154341957?s=20',
      }).externalPostId
    ).toBe('2075259819154341957');
  });
});

describe('EngageScanIngestService.persistOpportunities', () => {
  beforeEach(() => vi.clearAllMocks());

  it('no-ops on empty posts', async () => {
    const { svc, oppUpsert } = build();
    await svc.persistOpportunities('org1', null, []);
    expect(oppUpsert).not.toHaveBeenCalled();
  });

  it('upserts the global post by [platform, externalPostId] without per-org columns', async () => {
    const { svc, oppUpsert } = build();
    await svc.persistOpportunities('org1', null, [makeScoredPost(1)]);
    const arg = oppUpsert.mock.calls[0][0];
    expect(arg.where.platform_externalPostId).toEqual({
      platform: 'reddit',
      externalPostId: 't3_1',
    });
    // per-org fields must NOT be on the global row
    expect(arg.create).not.toHaveProperty('score');
    expect(arg.create).not.toHaveProperty('status');
  });

  it('dedups duplicate (platform,externalPostId) within one batch → single global upsert (W3)', async () => {
    const { svc, oppUpsert, stateCreate } = build();
    const dup1 = makeScoredPost(1);
    const dup2 = { ...makeScoredPost(1), metricScore: 999 }; // same id, newer metrics
    await svc.persistOpportunities('org1', null, [dup1, dup2]);
    // one global upsert (not two concurrent upserts on the same unique key)
    expect(oppUpsert).toHaveBeenCalledTimes(1);
    expect(stateCreate).toHaveBeenCalledTimes(1);
    // last-write-wins: the newer metrics are persisted
    expect(oppUpsert.mock.calls[0][0].create.metricScore).toBe(999);
  });

  it('dedups duplicate X share URLs within one batch after canonicalization', async () => {
    const { svc, oppUpsert, stateCreate } = build();
    const first = {
      ...makeScoredPost(1),
      platform: 'x',
      externalPostId: 'share-a',
      externalPostUrl: 'https://x.com/elonmusk/status/2075259819154341957?s=20',
    };
    const second = {
      ...makeScoredPost(2),
      platform: 'x',
      externalPostId: 'share-b',
      externalPostUrl: 'https://twitter.com/elonmusk/status/2075259819154341957?ref_src=twsrc%5Etfw',
      metricScore: 999,
    };

    await svc.persistOpportunities('org1', null, [first, second]);

    expect(oppUpsert).toHaveBeenCalledTimes(1);
    expect(stateCreate).toHaveBeenCalledTimes(1);
    expect(oppUpsert.mock.calls[0][0].where.platform_externalPostId).toEqual({
      platform: 'x',
      externalPostId: '2075259819154341957',
    });
    expect(oppUpsert.mock.calls[0][0].create.externalPostUrl).toBe(
      'https://x.com/elonmusk/status/2075259819154341957'
    );
    expect(oppUpsert.mock.calls[0][0].create.metricScore).toBe(999);
  });

  it('updates an existing global post found by normalized platform+externalPostUrl', async () => {
    const { svc, oppFindFirst, oppUpsert, oppUpdate, stateFindFirst, stateCreate } = build();
    oppFindFirst.mockResolvedValueOnce({ id: 'opp_existing' });

    await svc.persistOpportunities('org1', null, [
      {
        ...makeScoredPost(1),
        platform: 'x',
        externalPostId: '2075259819154341957',
        externalPostUrl: 'https://x.com/elonmusk/status/2075259819154341957?s=20',
      },
    ]);

    expect(oppFindFirst).toHaveBeenCalledWith({
      where: {
        platform: 'x',
        externalPostUrl: 'https://x.com/elonmusk/status/2075259819154341957',
      },
      select: { id: true },
    });
    expect(oppUpsert).not.toHaveBeenCalled();
    expect(oppUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'opp_existing' } })
    );
    expect(stateFindFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org1', projectId: null, opportunityId: 'opp_existing' },
      select: { id: true },
    });
    expect(stateCreate.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ organizationId: 'org1', projectId: null, opportunityId: 'opp_existing' })
    );
  });

  it('upserts per-org state NEW on create, aligned to its post id', async () => {
    const { svc, stateCreate } = build();
    await svc.persistOpportunities('org1', null, [makeScoredPost(1)]);
    const arg = stateCreate.mock.calls[0][0].data;
    expect(arg.organizationId).toBe('org1');
    expect(arg.projectId).toBeNull();
    expect(arg.opportunityId).toBe('opp_t3_1');
    expect(arg.status).toBe('NEW');
    expect(arg.score).toBe(70);
    expect(arg.isCurrentlyMatched).toBe(true);
  });

  it('upserts per-project state via the compound key when projectId is set (not findFirst+create)', async () => {
    const { svc, stateUpsert, stateFindFirst, stateCreate } = build();
    await svc.persistOpportunities('org1', 'proj-1', [makeScoredPost(1)]);
    expect(stateFindFirst).not.toHaveBeenCalled();
    expect(stateCreate).not.toHaveBeenCalled();
    expect(stateUpsert).toHaveBeenCalledTimes(1);
    const arg = stateUpsert.mock.calls[0][0];
    expect(arg.where.organizationId_projectId_opportunityId).toEqual({
      organizationId: 'org1',
      projectId: 'proj-1',
      opportunityId: 'opp_t3_1',
    });
    expect(arg.create.projectId).toBe('proj-1');
  });
});

function rawPost(over: any = {}): any {
  return {
    id: 'r1',
    platform: 'reddit',
    externalPostId: 't3_1',
    externalPostUrl: 'https://reddit.com/1',
    authorUsername: 'u1',
    postContent: 'I love react and nextjs',
    postPublishedAt: new Date('2026-06-17T10:00:00.000Z'),
    channelId: 'webdev',
    metricLikes: 0, metricReplies: 0, metricRetweets: 0, metricQuotes: 0,
    metricScore: 200, metricComments: 50,
    ...over,
  };
}

const ctx = {
  organizationId: 'org1',
  projectId: null,
  keywords: [{ id: 'k1', keyword: 'react', type: null, enabled: true }],
  trackedAccounts: [],
  monitoredChannels: [{ platform: 'reddit', channelId: 'webdev' }],
} as any;

describe('EngageScanIngestService.scoreForOrg', () => {
  it('drops posts that match no keyword', () => {
    const { svc } = build();
    const out = svc.scoreForOrg([rawPost({ postContent: 'unrelated chatter' })], ctx);
    expect(out).toEqual([]);
  });

  it('returns [] when the org has no keywords', () => {
    const { svc } = build();
    expect(svc.scoreForOrg([rawPost()], { ...ctx, keywords: [] })).toEqual([]);
  });

  it('marks a post in a monitored subreddit as tracked', () => {
    const { svc } = build();
    const out = svc.scoreForOrg([rawPost()], ctx);
    // high-engagement post matching "react" in a monitored subreddit → scored
    expect(out.length).toBe(1);
    expect(out[0].isFromTrackedAccount).toBe(true);
    expect(out[0].scoreTracked).toBeGreaterThan(0);
  });
});

describe('EngageScanIngestService.ingestForOrg', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 0 and persists nothing when nothing scores', async () => {
    const { svc, oppUpsert } = build();
    const n = await svc.ingestForOrg(ctx, [rawPost({ postContent: 'nope' })]);
    expect(n).toBe(0);
    expect(oppUpsert).not.toHaveBeenCalled();
  });

  it('scores → persists → counts for a matching post', async () => {
    const { svc, oppUpsert, stateCreate } = build();
    const n = await svc.ingestForOrg(ctx, [rawPost()]);
    expect(n).toBe(1);
    expect(oppUpsert).toHaveBeenCalledTimes(1);
    expect(stateCreate).toHaveBeenCalledTimes(1);
  });
});

function oppRow(over: any = {}): any {
  return {
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
    postContent: 'react and nextjs are great',
    postPublishedAt: new Date('2026-06-17T10:00:00.000Z'),
    metricLikes: 0, metricReplies: 0, metricRetweets: 0, metricQuotes: 0,
    metricBookmarks: 0, metricViews: 0, metricShares: 0, metricSaves: 0,
    metricScore: 200, metricUpvoteRatio: null, metricComments: 50,
    ...over,
  };
}

describe('EngageScanIngestService.attributeExisting', () => {
  beforeEach(() => vi.clearAllMocks());

  it('no-ops on empty input', async () => {
    const { svc, stateCreate } = build();
    expect(await svc.attributeExisting(ctx, [])).toBe(0);
    expect(stateCreate).not.toHaveBeenCalled();
  });

  it('re-scores existing opportunities and writes ONLY per-org state (no global upsert)', async () => {
    const { svc, oppUpsert, stateFindFirst, stateCreate } = build();
    const n = await svc.attributeExisting(ctx, [oppRow()]);
    expect(n).toBe(1);
    expect(oppUpsert).not.toHaveBeenCalled(); // global row untouched
    expect(stateFindFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org1', projectId: null, opportunityId: 'opp1' },
      select: { id: true },
    });
    const arg = stateCreate.mock.calls[0][0].data;
    expect(arg.organizationId).toBe('org1');
    expect(arg.projectId).toBeNull();
    expect(arg.opportunityId).toBe('opp1');
    expect(arg.status).toBe('NEW');
  });

  it('returns the count of states actually written, not scored candidates (W4)', async () => {
    const { svc, stateCreate } = build();
    // two matching opportunities → two state writes → count 2
    const n = await svc.attributeExisting(ctx, [oppRow(), oppRow({ id: 'opp2', externalPostId: 't3_2' })]);
    expect(n).toBe(stateCreate.mock.calls.length); // count == actual writes
    expect(n).toBe(2);
  });

  it('skips opportunities that do not match the org keywords', async () => {
    const { svc, stateCreate } = build();
    const n = await svc.attributeExisting(ctx, [oppRow({ postContent: 'totally unrelated' })]);
    expect(n).toBe(0);
    expect(stateCreate).not.toHaveBeenCalled();
  });
});

describe('EngageScanIngestService.classifyIntents', () => {
  it('falls back to discussion when the classifier returns nothing', async () => {
    const { svc } = build();
    const [out] = await svc.classifyIntents([makeScoredPost(1)]);
    expect(out.primaryIntent).toBe('discussion');
    expect(out.intentTags).toEqual(['discussion']);
  });
});

describe('EngageScanIngestService.updateKeywordHitCounts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('increments hits for matched, enabled keywords (skipping recently counted)', async () => {
    const { svc, kwUpdate, txRun } = build();
    const kws = [
      { id: 'k1', keyword: 'react', enabled: true },
      { id: 'k2', keyword: 'vue', enabled: true }, // not in content → no hit
    ] as any;
    await svc.updateKeywordHitCounts('org1', [makeScoredPost(1)], kws);
    expect(kwUpdate).toHaveBeenCalledTimes(1);
    expect(kwUpdate.mock.calls[0][0].where.id).toBe('k1');
    expect(txRun).toHaveBeenCalledTimes(1);
  });

  it('no-ops when nothing matches', async () => {
    const { svc, txRun } = build();
    await svc.updateKeywordHitCounts('org1', [makeScoredPost(1)], [
      { id: 'k2', keyword: 'svelte', enabled: true },
    ] as any);
    expect(txRun).not.toHaveBeenCalled();
  });
});

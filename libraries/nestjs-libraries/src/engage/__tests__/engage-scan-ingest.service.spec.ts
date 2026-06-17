import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngageScanIngestService } from '../engage-scan-ingest.service';

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
  const oppUpsert = vi.fn(async (args: any) => ({
    id: `opp_${args.where.platform_externalPostId.externalPostId}`,
  }));
  const stateUpsert = vi.fn(async () => ({}));
  const kwFindMany = vi.fn(async () => []);
  const kwUpdate = vi.fn(async () => ({}));
  const txRun = vi.fn(async (ops: any[]) => ops);

  const svc = new EngageScanIngestService(
    { model: { engageOpportunity: { upsert: oppUpsert } } } as any,
    { model: { engageOpportunityState: { upsert: stateUpsert } } } as any,
    { model: { engageKeyword: { findMany: kwFindMany, update: kwUpdate } } } as any,
    { classifyBatch: vi.fn(async () => ({})) } as any,
    { model: { $transaction: txRun } } as any
  );
  return { svc, oppUpsert, stateUpsert, kwFindMany, kwUpdate, txRun };
}

describe('EngageScanIngestService.persistOpportunities', () => {
  beforeEach(() => vi.clearAllMocks());

  it('no-ops on empty posts', async () => {
    const { svc, oppUpsert } = build();
    await svc.persistOpportunities('org1', []);
    expect(oppUpsert).not.toHaveBeenCalled();
  });

  it('upserts the global post by [platform, externalPostId] without per-org columns', async () => {
    const { svc, oppUpsert } = build();
    await svc.persistOpportunities('org1', [makeScoredPost(1)]);
    const arg = oppUpsert.mock.calls[0][0];
    expect(arg.where.platform_externalPostId).toEqual({
      platform: 'reddit',
      externalPostId: 't3_1',
    });
    // per-org fields must NOT be on the global row
    expect(arg.create).not.toHaveProperty('score');
    expect(arg.create).not.toHaveProperty('status');
  });

  it('upserts per-org state NEW on create, aligned to its post id', async () => {
    const { svc, stateUpsert } = build();
    await svc.persistOpportunities('org1', [makeScoredPost(1)]);
    const arg = stateUpsert.mock.calls[0][0];
    expect(arg.where.organizationId_opportunityId).toEqual({
      organizationId: 'org1',
      opportunityId: 'opp_t3_1',
    });
    expect(arg.create.status).toBe('NEW');
    expect(arg.create.score).toBe(70);
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
    const { svc, oppUpsert, stateUpsert } = build();
    const n = await svc.ingestForOrg(ctx, [rawPost()]);
    expect(n).toBe(1);
    expect(oppUpsert).toHaveBeenCalledTimes(1);
    expect(stateUpsert).toHaveBeenCalledTimes(1);
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
    const { svc, stateUpsert } = build();
    expect(await svc.attributeExisting(ctx, [])).toBe(0);
    expect(stateUpsert).not.toHaveBeenCalled();
  });

  it('re-scores existing opportunities and writes ONLY per-org state (no global upsert)', async () => {
    const { svc, oppUpsert, stateUpsert } = build();
    const n = await svc.attributeExisting(ctx, [oppRow()]);
    expect(n).toBe(1);
    expect(oppUpsert).not.toHaveBeenCalled(); // global row untouched
    const arg = stateUpsert.mock.calls[0][0];
    expect(arg.where.organizationId_opportunityId).toEqual({
      organizationId: 'org1',
      opportunityId: 'opp1',
    });
    expect(arg.create.status).toBe('NEW');
  });

  it('skips opportunities that do not match the org keywords', async () => {
    const { svc, stateUpsert } = build();
    const n = await svc.attributeExisting(ctx, [oppRow({ postContent: 'totally unrelated' })]);
    expect(n).toBe(0);
    expect(stateUpsert).not.toHaveBeenCalled();
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

import { describe, it, expect, vi } from 'vitest';
import { buildReplyMetricsFromRaw } from '../engage-metrics-sync';
import { EngageService } from '../engage.service';

/**
 * The extension scrapes a reply's own page and hands the raw counters to the
 * page, which POSTs them to PATCH /engage/sent/:id/metrics. buildReplyMetricsFromRaw
 * (pure) turns those counters into the persisted Post shape, and
 * EngageService.ingestReplyMetrics persists + normalises them. These pin both so
 * an extension-sourced refresh stays byte-for-byte consistent with a server pull.
 */
describe('buildReplyMetricsFromRaw — raw counters → persisted Post metrics', () => {
  it('X: weighted Traffic index + impressions=views, labels match normalize', () => {
    const built = buildReplyMetricsFromRaw({
      platform: 'x',
      impressions: 1000,
      likes: 10,
      replies: 2,
      retweets: 4,
      quotes: 1,
      bookmarks: 6,
    });
    // impressions stored verbatim (views), not weighted into traffic.
    expect(built.impressions).toBe(1000);
    // X_traffic_index = likes*1 + replies*2 + retweets*1.5 + quotes*2 + bookmarks*1.5
    //                 = 10 + 4 + 6 + 2 + 9 = 31
    expect(built.trafficScore).toBe(31);
    const labels = built.analytics.map((a) => a.label).sort();
    expect(labels).toEqual(
      ['bookmarks', 'impressions', 'likes', 'quotes', 'replies', 'retweets'].sort()
    );
  });

  it('Reddit: impressions=(score+comments)*20, traffic=score*1+comments*3', () => {
    const built = buildReplyMetricsFromRaw({
      platform: 'reddit',
      score: 5,
      comments: 3,
    });
    expect(built.impressions).toBe((5 + 3) * 20); // 160
    expect(built.trafficScore).toBe(5 * 1 + 3 * 3); // 14
    expect(built.analytics.map((a) => a.label)).toEqual(['score', 'comments']);
  });

  it('coerces missing/non-finite counters to 0 (Prisma Float rejects NaN)', () => {
    const built = buildReplyMetricsFromRaw({
      platform: 'x',
      likes: undefined,
      impressions: Number.NaN as unknown as number,
    });
    expect(built.impressions).toBe(0);
    expect(built.trafficScore).toBe(0);
  });
});

describe('ingestReplyMetrics — persist extension-scraped reply metrics', () => {
  const org = { id: 'org-1' } as any;

  function build(ctx: any) {
    const getSentReplyContext = vi.fn(async () => ctx);
    const updatePostMetrics = vi.fn(async () => ({}));
    const repo = { getSentReplyContext, updatePostMetrics } as any;
    const markMetricsFetched = vi.fn(async () => undefined);
    const postsService = { markMetricsFetched } as any;
    const service = new EngageService(
      repo,
      { client: undefined } as any,
      postsService,
      {} as any,
      {} as any
    );
    return { service, getSentReplyContext, updatePostMetrics, markMetricsFetched };
  }

  const xCtx = {
    sentReplyId: 'r1',
    postId: 'p1',
    opportunityId: 'o1',
    state: 'PUBLISHED',
    releaseURL: 'https://x.com/alice/status/123',
    platform: 'x',
  };

  it('writes computed metrics and returns normalized X metrics', async () => {
    const { service, updatePostMetrics, markMetricsFetched } = build(xCtx);

    const res = await service.ingestReplyMetrics(org, 'r1', {
      platform: 'x',
      impressions: 1000,
      likes: 10,
      replies: 2,
      retweets: 4,
      quotes: 1,
      bookmarks: 6,
    });

    expect(updatePostMetrics).toHaveBeenCalledWith(
      'p1',
      1000,
      expect.any(Array),
      31
    );
    expect(markMetricsFetched).toHaveBeenCalledWith('org-1', ['p1'], expect.any(Date));
    expect(res).toMatchObject({ id: 'r1', postId: 'p1', impressions: 1000, trafficScore: 31 });
    expect(res.lastMetricsFetchAt).toBeInstanceOf(Date);
    expect(res.metrics).toMatchObject({ impressions: 1000, likes: 10, bookmarks: 6 });
  });

  it('returns lastMetricsFetchAt=null when the stamp fails to persist', async () => {
    // If the dedup stamp did not land, the client must not believe the interval
    // gate advanced — otherwise it would suppress a needed re-fetch.
    const { service } = build(xCtx);
    (service as any)._postsService.markMetricsFetched = vi.fn(async () => {
      throw new Error('db down');
    });

    const res = await service.ingestReplyMetrics(org, 'r1', {
      platform: 'x',
      impressions: 1000,
    });

    expect(res.lastMetricsFetchAt).toBeNull();
    // Metrics themselves still persisted — only the stamp report is withheld.
    expect(res).toMatchObject({ id: 'r1', postId: 'p1', impressions: 1000 });
  });

  it('throws when the reply is not found', async () => {
    const { service } = build(null);
    await expect(
      service.ingestReplyMetrics(org, 'missing', { platform: 'x' })
    ).rejects.toThrow(/not found/i);
  });

  it('rejects a reply that is not a published, linked post', async () => {
    const { service, updatePostMetrics } = build({
      ...xCtx,
      state: 'DRAFT',
      releaseURL: null,
    });
    await expect(
      service.ingestReplyMetrics(org, 'r1', { platform: 'x' })
    ).rejects.toThrow(/no published post/i);
    expect(updatePostMetrics).not.toHaveBeenCalled();
  });

  it('rejects a platform mismatch between the payload and the reply', async () => {
    const { service, updatePostMetrics } = build(xCtx);
    await expect(
      service.ingestReplyMetrics(org, 'r1', { platform: 'reddit', score: 1 })
    ).rejects.toThrow(/platform mismatch/i);
    expect(updatePostMetrics).not.toHaveBeenCalled();
  });

  it('rejects a non X/Reddit reply', async () => {
    const { service } = build({ ...xCtx, platform: 'linkedin' });
    await expect(
      service.ingestReplyMetrics(org, 'r1', { platform: 'x' })
    ).rejects.toThrow(/only valid for X or Reddit/i);
  });
});

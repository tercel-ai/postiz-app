import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostsService } from '../posts.service';

// Smallest viable PostsService — getDueMetricsPosts only touches the repository.
function makeService(opts: { due?: any[]; mark?: any; providers?: any[] } = {}) {
  const repo: any = {
    getDueMetricsPosts: vi.fn().mockResolvedValue(opts.due ?? []),
    markMetricsFetched: vi.fn().mockResolvedValue(opts.mark ?? { count: 0 }),
    getPostsProviderByIds: vi.fn().mockResolvedValue(opts.providers ?? []),
    batchUpdatePostAnalytics: vi.fn().mockResolvedValue([]),
  };
  const svc = new PostsService(
    repo,
    {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any,
  );
  return { svc, repo };
}

describe('PostsService.getDueMetricsPosts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('short-circuits to [] without hitting the repo when ids are empty', async () => {
    const { svc, repo } = makeService();
    expect(await svc.getDueMetricsPosts('org-1', [], 7, 6)).toEqual([]);
    expect(repo.getDueMetricsPosts).not.toHaveBeenCalled();
  });

  it('translates window days / interval hours into concrete past cutoffs', async () => {
    const { svc, repo } = makeService({ due: [{ id: 'p1' }] });
    const before = Date.now();
    const result = await svc.getDueMetricsPosts('org-1', ['p1', 'p2'], 7, 6);
    const after = Date.now();

    expect(result).toEqual([{ id: 'p1' }]);
    const [orgId, ids, windowStart, intervalCutoff] =
      repo.getDueMetricsPosts.mock.calls[0];
    expect(orgId).toBe('org-1');
    expect(ids).toEqual(['p1', 'p2']);

    // windowStart ≈ now - 7d, intervalCutoff ≈ now - 6h (allow scheduling slack).
    const expectedWindow = before - 7 * 24 * 60 * 60 * 1000;
    const expectedInterval = before - 6 * 60 * 60 * 1000;
    expect(windowStart.getTime()).toBeGreaterThanOrEqual(expectedWindow - 1000);
    expect(windowStart.getTime()).toBeLessThanOrEqual(after - 7 * 24 * 60 * 60 * 1000 + 1000);
    expect(intervalCutoff.getTime()).toBeGreaterThanOrEqual(expectedInterval - 1000);
    expect(intervalCutoff.getTime()).toBeLessThanOrEqual(after - 6 * 60 * 60 * 1000 + 1000);
  });
});

describe('PostsService.markMetricsFetched', () => {
  beforeEach(() => vi.clearAllMocks());

  it('no-ops on empty ids', async () => {
    const { svc, repo } = makeService();
    expect(await svc.markMetricsFetched('org-1', [])).toEqual({ count: 0 });
    expect(repo.markMetricsFetched).not.toHaveBeenCalled();
  });

  it('stamps the given posts with a now timestamp', async () => {
    const { svc, repo } = makeService({ mark: { count: 2 } });
    const res = await svc.markMetricsFetched('org-1', ['p1', 'p2']);
    expect(res).toEqual({ count: 2 });
    const [orgId, ids, now] = repo.markMetricsFetched.mock.calls[0];
    expect(orgId).toBe('org-1');
    expect(ids).toEqual(['p1', 'p2']);
    expect(now).toBeInstanceOf(Date);
  });
});

describe('PostsService.backfillMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('no-ops on empty items', async () => {
    const { svc, repo } = makeService();
    expect(await svc.backfillMetrics('org-1', [])).toEqual({ updated: [], stamped: [] });
    expect(repo.getPostsProviderByIds).not.toHaveBeenCalled();
  });

  it('resolves the platform server-side and writes weighted X metrics', async () => {
    const { svc, repo } = makeService({
      providers: [{ id: 'p1', integration: { providerIdentifier: 'x' } }],
    });
    const analytics = [
      { label: 'impressions', data: [{ total: '1000', date: '2026-06-17' }], percentageChange: 0 },
      { label: 'likes', data: [{ total: '10', date: '2026-06-17' }], percentageChange: 0 },
      { label: 'replies', data: [{ total: '5', date: '2026-06-17' }], percentageChange: 0 },
    ];
    const res = await svc.backfillMetrics('org-1', [{ postId: 'p1', analytics } as any]);

    expect(res.stamped).toEqual(['p1']);
    expect(res.updated).toEqual(['p1']);
    const update = repo.batchUpdatePostAnalytics.mock.calls[0][0][0];
    expect(update.id).toBe('p1');
    expect(update.impressions).toBe(1000);
    // x weights: likes 1 + replies 2 → 10*1 + 5*2 = 20
    expect(update.trafficScore).toBe(20);
    // synthetic Traffic label is stripped from the stored snapshot
    expect(update.analytics.some((m: any) => m.label === 'Traffic')).toBe(false);
    // dedup stamp written
    expect(repo.markMetricsFetched).toHaveBeenCalledWith('org-1', ['p1'], expect.any(Date));
  });

  it('skips posts the org does not own (platform unresolved) — no stamp, no write', async () => {
    const { svc, repo } = makeService({ providers: [] }); // p1 not owned
    const res = await svc.backfillMetrics('org-1', [
      { postId: 'p1', analytics: [{ label: 'impressions', data: [{ total: '5', date: 'd' }], percentageChange: 0 }] } as any,
    ]);
    expect(res).toEqual({ updated: [], stamped: [] });
    // stamped is empty → the service short-circuits before touching the repo
    expect(repo.markMetricsFetched).not.toHaveBeenCalled();
  });

  it('stamps an owned post with zero metrics but writes no analytics update', async () => {
    const { svc, repo } = makeService({
      providers: [{ id: 'p1', integration: { providerIdentifier: 'x' } }],
    });
    const res = await svc.backfillMetrics('org-1', [{ postId: 'p1', analytics: [] } as any]);
    expect(res.stamped).toEqual(['p1']);
    expect(res.updated).toEqual([]);
    expect(repo.batchUpdatePostAnalytics).toHaveBeenCalledWith([]);
  });
});

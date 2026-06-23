import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngageService } from '@gitroom/nestjs-libraries/engage/engage.service';

// Isolate the unit from real X/Reddit network fetches: the event-driven executor
// (_runMetricsSyncForReplies) calls these, fire-and-forget, for due replies.
vi.mock('@gitroom/nestjs-libraries/engage/engage-metrics-sync', () => ({
  syncRedditMetrics: vi.fn(async () => 'written'),
  syncXMetrics: vi.fn(async () => 'written'),
}));

/**
 * Coverage for the two halves of the page-visit refresh, now split:
 *  - refreshOnVisit: SCAN only (keywords/tracked/channels), gated by the per-unit
 *    cadence (EngageScanCursor). Cold-start fires the first scan; a frequent
 *    visitor with nothing due no-ops (status `throttled`).
 *  - refreshMetricsForPosts: METRICS, driven by the exact post ids the client has
 *    on screen. Only PUBLISHED, in-window, past-interval posts are refreshed; the
 *    gate (lastMetricsFetchAt) is stamped before the fire-and-forget fetch.
 */
describe('EngageService page-visit refresh', () => {
  const org = { id: 'org-1' } as any;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  let markMetricsFetched: ReturnType<typeof vi.fn>;
  let getOrgScanStatus: ReturnType<typeof vi.fn>;
  let findEngageRepliesByPostIds: ReturnType<typeof vi.fn>;

  function build() {
    const engageRepository = {
      getOrgScanStatus,
      findEngageRepliesByPostIds,
      // Used by _metricsSyncDeps but never reached in these tests (executor mocked).
      updatePostMetrics: vi.fn(),
      markAuthorReplied: vi.fn(),
    } as any;
    const postsService = {
      markMetricsFetched,
      checkEngageXAnalyticsWithFallback: vi.fn(),
    } as any;
    // No temporal client → scan signal is a safe no-op.
    const temporalService = { client: undefined } as any;
    const entitlement = {
      getScanIntervalHours: vi.fn(async () => 6),
      getMetricsWindowDays: vi.fn(async () => 7),
      getMetricsFetchIntervalHours: vi.fn(async () => 6),
    } as any;
    return new EngageService(
      engageRepository,
      temporalService,
      postsService,
      {} as any,
      entitlement
    );
  }

  beforeEach(() => {
    markMetricsFetched = vi.fn(async () => ({ count: 1 }));
    findEngageRepliesByPostIds = vi.fn(async () => []);
    getOrgScanStatus = vi.fn(async () => ({
      lastScanAt: new Date(Date.now() - DAY),
      nextScanAt: new Date(Date.now() + 6 * HOUR),
    }));
  });

  describe('refreshOnVisit (scan only)', () => {
    it('cold start: never scanned → accepted, coldStart true', async () => {
      getOrgScanStatus = vi.fn(async () => ({ lastScanAt: null, nextScanAt: null }));
      const res = await build().refreshOnVisit(org);
      expect(res.status).toBe('accepted');
      expect(res.coldStart).toBe(true);
      // Floored into the (near) future so the client waits before re-calling.
      expect(new Date(res.nextRefreshAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('frequent visitor: scan not due → throttled, future nextRefreshAt', async () => {
      const res = await build().refreshOnVisit(org);
      expect(res.status).toBe('throttled');
      expect(res.coldStart).toBe(false);
      expect(new Date(res.nextRefreshAt).getTime()).toBeGreaterThan(Date.now() + HOUR);
    });

    it('does not touch metrics (no markMetricsFetched)', async () => {
      await build().refreshOnVisit(org);
      expect(markMetricsFetched).not.toHaveBeenCalled();
    });
  });

  describe('refreshMetricsForPosts (event-driven)', () => {
    it('empty post ids → no-op, no fetch', async () => {
      const res = await build().refreshMetricsForPosts(org, []);
      expect(res.accepted).toEqual([]);
      expect(res.throttled).toEqual([]);
      expect(markMetricsFetched).not.toHaveBeenCalled();
    });

    it('due post → accepted, stamps the gate for the due id', async () => {
      findEngageRepliesByPostIds = vi.fn(async () => [
        {
          id: 'reply-1',
          organizationId: org.id,
          post: {
            id: 'post-1',
            releaseURL: 'https://x.com/a/1',
            publishDate: new Date(Date.now() - DAY),
            lastMetricsFetchAt: new Date(Date.now() - 7 * HOUR), // > 6h interval
          },
          opportunity: { platform: 'x', externalPostId: 't1', authorUsername: 'a' },
        },
      ]);
      const res = await build().refreshMetricsForPosts(org, ['post-1']);
      expect(res.accepted).toEqual(['reply-1']);
      expect(markMetricsFetched).toHaveBeenCalledWith(org.id, ['post-1']);
    });

    it('recently fetched → throttled, gate not stamped', async () => {
      findEngageRepliesByPostIds = vi.fn(async () => [
        {
          id: 'reply-1',
          organizationId: org.id,
          post: {
            id: 'post-1',
            releaseURL: 'https://x.com/a/1',
            publishDate: new Date(Date.now() - DAY),
            lastMetricsFetchAt: new Date(Date.now() - 1000), // just fetched
          },
          opportunity: { platform: 'x', externalPostId: 't1', authorUsername: 'a' },
        },
      ]);
      const res = await build().refreshMetricsForPosts(org, ['post-1']);
      expect(res.accepted).toEqual([]);
      expect(res.throttled).toEqual(['reply-1']);
      expect(markMetricsFetched).not.toHaveBeenCalled();
    });

    it('out of monitoring window → throttled even if never fetched', async () => {
      findEngageRepliesByPostIds = vi.fn(async () => [
        {
          id: 'reply-2',
          organizationId: org.id,
          post: {
            id: 'post-2',
            releaseURL: 'https://x.com/a/2',
            publishDate: new Date(Date.now() - 30 * DAY), // window is 7d
            lastMetricsFetchAt: null,
          },
          opportunity: { platform: 'x', externalPostId: 't2', authorUsername: 'b' },
        },
      ]);
      const res = await build().refreshMetricsForPosts(org, ['post-2']);
      expect(res.accepted).toEqual([]);
      expect(res.throttled).toEqual(['reply-2']);
      expect(markMetricsFetched).not.toHaveBeenCalled();
    });
  });
});

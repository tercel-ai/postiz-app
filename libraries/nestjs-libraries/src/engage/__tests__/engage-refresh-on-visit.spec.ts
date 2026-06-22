import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngageService } from '@gitroom/nestjs-libraries/engage/engage.service';

/**
 * Coverage for the page-visit trigger (`refreshOnVisit`): the frontend fires it
 * on every Engage visit, but the existing due gate decides whether anything
 * runs. The three visitor patterns all fall out of the SAME interval gate —
 * cold-start fires the first scan, an infrequent visitor's due metrics fire, and
 * a frequent visitor with nothing due no-ops (status `throttled`). The endpoint
 * always returns `nextRefreshAt` so the client can cache it and skip the call.
 */
describe('EngageService.refreshOnVisit', () => {
  const org = { id: 'org-1' } as any;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  let markMetricsFetched: ReturnType<typeof vi.fn>;
  let getOrgScanStatus: ReturnType<typeof vi.fn>;
  let getRecentSentForRefresh: ReturnType<typeof vi.fn>;

  function build() {
    const engageRepository = {
      getOrgScanStatus,
      getRecentSentForRefresh,
    } as any;
    const postsService = { markMetricsFetched } as any;
    // No temporal client → scan signal / metrics-sync starts are safe no-ops.
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
    getRecentSentForRefresh = vi.fn(async () => []);
    getOrgScanStatus = vi.fn(async () => ({
      lastScanAt: new Date(Date.now() - DAY),
      nextScanAt: new Date(Date.now() + 6 * HOUR),
    }));
  });

  it('cold start: never scanned → accepted, coldStart true, no metrics fetch', async () => {
    getOrgScanStatus = vi.fn(async () => ({ lastScanAt: null, nextScanAt: null }));
    const res = await build().refreshOnVisit(org);
    expect(res.status).toBe('accepted');
    expect(res.coldStart).toBe(true);
    expect(markMetricsFetched).not.toHaveBeenCalled();
    // Floored into the (near) future so the client waits before re-calling.
    expect(new Date(res.nextRefreshAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('frequent visitor: nothing due → throttled, future nextRefreshAt', async () => {
    getRecentSentForRefresh = vi.fn(async () => [
      {
        id: 'reply-1',
        post: {
          id: 'post-1',
          state: 'PUBLISHED',
          publishDate: new Date(Date.now() - DAY),
          lastMetricsFetchAt: new Date(Date.now() - 1000), // just fetched
        },
      },
    ]);
    const res = await build().refreshOnVisit(org);
    expect(res.status).toBe('throttled');
    expect(res.coldStart).toBe(false);
    expect(markMetricsFetched).not.toHaveBeenCalled();
    // min(scanNext ~+6h, metricsNext ~+6h) — comfortably in the future.
    expect(new Date(res.nextRefreshAt).getTime()).toBeGreaterThan(Date.now() + HOUR);
  });

  it('due metrics: stale page-1 post → accepted, stamps the gate for the due id', async () => {
    getRecentSentForRefresh = vi.fn(async () => [
      {
        id: 'reply-1',
        post: {
          id: 'post-1',
          state: 'PUBLISHED',
          publishDate: new Date(Date.now() - DAY),
          lastMetricsFetchAt: new Date(Date.now() - 7 * HOUR), // > 6h interval
        },
      },
      {
        // Out of the monitoring window → ignored even though never fetched.
        id: 'reply-2',
        post: {
          id: 'post-2',
          state: 'PUBLISHED',
          publishDate: new Date(Date.now() - 30 * DAY),
          lastMetricsFetchAt: null,
        },
      },
    ]);
    const res = await build().refreshOnVisit(org);
    expect(res.status).toBe('accepted');
    expect(markMetricsFetched).toHaveBeenCalledWith(org.id, ['post-1']);
  });
});

/**
 * Why is a PUBLISHED engage reply still missing metrics? Classify each reply so
 * the sync tooling can tell "needs the link first" apart from "everything's in
 * place but the fetch returned nothing". Pure + shared by EngageRepository
 * (getEngageMetricsStats) and scripts/engage-sync-metrics.ts so the breakdown
 * has one definition.
 *
 *   has_metrics     impressions already populated — nothing to do.
 *   no_release_url  no reply URL ("I'll add the link later") → nothing to fetch;
 *                   user must backfill via PATCH /engage/sent/:id/reply-url.
 *   no_integration  X only — Post has no connected account, so checkPostAnalytics
 *                   can't read it. Run the integration backfill.
 *   no_release_id   X only — URL present but no /status/<id> parsed; can't query.
 *   syncable        all prerequisites present, but impressions are still null —
 *                   the fetch was attempted and returned nothing (X API tier
 *                   block / Reddit WAF / not yet run). This is the bucket to
 *                   investigate with the platform-specific scripts.
 */

export type ReplyMetricStatus =
  | 'has_metrics'
  | 'no_release_url'
  | 'no_integration'
  | 'no_release_id'
  | 'syncable';

export interface ReplyMetricInput {
  platform: string;
  impressions: number | null | undefined;
  releaseURL: string | null | undefined;
  releaseId: string | null | undefined;
  integrationId: string | null | undefined;
}

export function classifyReplyMetric(r: ReplyMetricInput): ReplyMetricStatus {
  if (r.impressions != null) return 'has_metrics';
  if (!r.releaseURL) return 'no_release_url';
  if (r.platform === 'x') {
    if (!r.integrationId) return 'no_integration';
    if (!r.releaseId) return 'no_release_id';
  }
  return 'syncable';
}

/** One metric series as stored in Post.analytics (the app-wide AnalyticsData shape). */
interface RawAnalyticsEntry {
  label: string;
  data?: Array<{ total?: string | number }>;
}

/**
 * Flatten the verbose `Post.analytics` array into a stable, frontend-friendly
 * metrics object so the UI can read `metrics.bookmarks` directly instead of
 * regex-matching labels. Always returns the full per-platform key set (every
 * field present, defaulting to 0) — "return everything, the frontend decides
 * what to display". Keeps `Post.analytics` untouched for backward compatibility.
 */
export interface NormalizedReplyMetrics {
  trafficScore: number;
  // X
  impressions?: number;
  likes?: number;
  retweets?: number;
  replies?: number;
  quotes?: number;
  bookmarks?: number;
  // Reddit
  upvotes?: number;
  comments?: number;
  estReach?: number;
}

export function normalizeReplyMetrics(
  platform: string,
  analytics: unknown,
  impressions: number | null | undefined,
  trafficScore: number | null | undefined
): NormalizedReplyMetrics {
  const series: RawAnalyticsEntry[] = Array.isArray(analytics)
    ? (analytics as RawAnalyticsEntry[])
    : [];
  const get = (pattern: RegExp): number => {
    const entry = series.find((a) => typeof a?.label === 'string' && pattern.test(a.label));
    const value = Number(entry?.data?.[0]?.total ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  const traffic = trafficScore ?? 0;

  if (platform === 'x') {
    return {
      trafficScore: traffic,
      impressions: impressions ?? get(/impression|views/i),
      likes: get(/like|reaction/i),
      retweets: get(/retweet|repost/i),
      replies: get(/repl/i),
      quotes: get(/quote/i),
      bookmarks: get(/bookmark|save/i),
    };
  }

  if (platform === 'reddit') {
    const upvotes = get(/score|upvote/i);
    const comments = get(/comment/i);
    return {
      trafficScore: traffic,
      upvotes,
      comments,
      // estimated reach = (upvotes + comments) * 20, or the synced impressions.
      estReach: impressions ?? (upvotes + comments) * 20,
    };
  }

  return { trafficScore: traffic, impressions: impressions ?? 0 };
}

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
 * Can the public actually see this reply?
 *
 * A reply that a platform has killed still reads, everywhere else in this
 * pipeline, exactly like a healthy one: it has a releaseURL, it has a state of
 * PUBLISHED, and its metrics are simply low. That is how an account whose every
 * comment had been flagged into invisibility went forty days without a single
 * signal reaching the product.
 *
 * `unknown` is deliberately NOT folded into `visible`. The flags only exist on
 * rows written by an extension build that emits them, so most historical rows
 * carry no answer at all — and "we have never checked" must not render as
 * "healthy", which is the precise mistake this whole change is undoing.
 */
export type ReplyVisibility = 'visible' | 'hidden' | 'removed' | 'unknown';

/**
 * Read the `dead` / `deleted` flags the extension's metrics fetchers emit
 * alongside the numbers (see the extension's metrics.hackernews.ts).
 *
 * Labels are matched EXACTLY, not by regex like the numeric getters below:
 * `/dead/` also matches `deleted`, so a pattern match would report an
 * author-removed item as platform-killed.
 *
 * `hidden` wins over `removed` when both are set, because the two answer
 * different questions and only one is actionable — a flagged item says
 * something about the content whether or not we later deleted it, while
 * "we removed it" closes the case.
 */
function readVisibility(series: RawAnalyticsEntry[]): ReplyVisibility {
  const flag = (label: string): boolean | null => {
    const entry = series.find(
      (a) => typeof a?.label === 'string' && a.label.toLowerCase() === label
    );
    if (!entry) return null;
    const value = Number(entry.data?.[0]?.total ?? 0);
    return Number.isFinite(value) && value > 0;
  };
  const dead = flag('dead');
  const deleted = flag('deleted');
  if (dead === null && deleted === null) return 'unknown';
  if (dead) return 'hidden';
  if (deleted) return 'removed';
  return 'visible';
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
  /**
   * Present on EVERY platform, unlike the numeric fields below, because it is
   * the one metric whose absence is itself misleading — see ReplyVisibility.
   */
  visibility: ReplyVisibility;
  // X
  impressions?: number;
  likes?: number;
  retweets?: number;
  replies?: number;
  quotes?: number;
  bookmarks?: number;
  // Reddit + Hacker News (HN "points" reuse `upvotes` so one UI renders both)
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
  const visibility = readVisibility(series);

  if (platform === 'x') {
    return {
      trafficScore: traffic,
      visibility,
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
      visibility,
      upvotes,
      comments,
      // estimated reach = (upvotes + comments) * 20, or the synced impressions.
      estReach: impressions ?? (upvotes + comments) * 20,
    };
  }

  // Hacker News reports points + comment count and has no impression figure at
  // all, so the generic branch below rendered every HN reply as a flat
  // `impressions: 0`. Mapped onto Reddit's key names on purpose: the two read
  // identically to a reader, and reusing them means the existing score/comments
  // UI covers HN without a second layout. No estReach — HN publishes nothing
  // that would make a reach estimate anything but invented.
  if (platform === 'hackernews') {
    return {
      trafficScore: traffic,
      visibility,
      upvotes: get(/score|point/i),
      comments: get(/comment/i),
    };
  }

  return { trafficScore: traffic, visibility, impressions: impressions ?? 0 };
}

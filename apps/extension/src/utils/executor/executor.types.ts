// Client-side mirrors of the backend's demand-driven fetch contracts. The
// extension is the EXECUTOR: the backend (scheduler) hands it semantic scan
// instructions / due-post lists, the extension fetches with the user's session
// and posts back normalised data. These shapes mirror, field for field:
//   - libraries/.../engage/scan/scan-task.types.ts        (EngageScanTask, pacing)
//   - libraries/.../dtos/engage/scan-ingest.dto.ts        (ScanIngestPostDto)
//   - libraries/.../dtos/posts/metrics-due.dto.ts, metrics-ingest.dto.ts
// Keep them in sync if the backend contract changes.

export type ScanTaskPlatform = 'x' | 'reddit';
export type ScanTaskType = 'keyword' | 'channel' | 'tracked';

/** Where to resume from (mirrors EngageScanCursor). */
export interface ScanTaskCursor {
  lastSeenExternalId: string | null;
  lastSeenAt: string | null; // ISO 8601
}

/** Pacing the extension MUST honour, resolved server-side per task. */
export interface ScanTaskPacing {
  maxPages: number;
  /** Items requested per page (Reddit limit / X count). */
  pageSize: number;
  pageDelayMs: number;
  pageJitterMs: number;
  interUnitDelayMs: number;
  interUnitJitterMs: number;
  hourlyRequestCap: number;
}

/** One due scan unit handed to the extension. `taskId` is the lease handle. */
export interface EngageScanTask {
  taskId: string;
  platform: ScanTaskPlatform;
  scanType: ScanTaskType;
  scanKey: string; // normalised keyword | subreddit | username
  cursor: ScanTaskCursor;
  pacing: ScanTaskPacing;
}

/** One normalised post the extension fetched — mirrors ScanIngestPostDto. */
export interface ScanIngestPost {
  platform: string;
  externalPostId: string;
  externalPostUrl: string;
  authorUsername: string;
  postContent: string;
  postPublishedAt: string; // ISO 8601

  channelId?: string;
  channelName?: string;
  authorDisplayName?: string;
  authorAvatarUrl?: string;
  authorFollowers?: number;
  channelFollowers?: number;

  metricLikes?: number;
  metricReplies?: number;
  metricRetweets?: number;
  metricQuotes?: number;
  metricBookmarks?: number;
  metricViews?: number;
  metricShares?: number;
  metricSaves?: number;
  metricScore?: number;
  metricUpvoteRatio?: number;
  metricComments?: number;
}

/** Result of scanning one unit, ready to ship back in the ingest body. */
export interface ScanRunResult {
  posts: ScanIngestPost[];
  nextCursor: ScanTaskCursor;
  /** True when the scanner reached the end / hit maxPages (no backlog left). */
  exhausted: boolean;
}

/** Body of POST /engage/scan-tasks/ingest. */
export interface EngageScanSyncBody {
  completed?: {
    taskId: string;
    posts: ScanIngestPost[];
    nextCursor?: ScanTaskCursor;
    exhausted?: boolean;
  };
  want?: number; // 1..5
}

/** Response of POST /engage/scan-tasks/ingest. */
export interface EngageScanIngestResponse {
  accepted: number;
  nextTasks: EngageScanTask[];
}

// ─── Track A — post metrics ───────────────────────────────────────────────────

/** One due post returned by POST /posts/metrics/due. */
export interface DueMetricsPost {
  id: string;
  source: unknown;
  publishDate: string;
  lastMetricsFetchAt: string | null;
  releaseURL: string | null;
  integrationId: string | null;
  integration: {
    id: string;
    name: string;
    providerIdentifier: string; // 'x' | 'reddit' | ...
  } | null;
}

export interface DueMetricsResponse {
  windowDays: number;
  intervalHours: number;
  due: DueMetricsPost[];
}

/** AnalyticsData point/series — mirrors the backend social analytics shape so
 *  the same extractMetrics / traffic pipeline consumes the ingested metrics. */
export interface AnalyticsPoint {
  total: number | string;
  date: string; // ISO 8601
}
export interface AnalyticsSeries {
  label: string;
  data: AnalyticsPoint[];
  percentageChange?: number;
}

export interface MetricsIngestItem {
  postId: string;
  analytics: AnalyticsSeries[];
}

// ─── Extension scan contract (backend = scheduler, extension = executor) ──────
//
// The backend resolves WHICH units are due and hands the extension a SEMANTIC
// instruction; the extension owns HOW to fetch (it builds the platform request
// with the user's session and normalises the response to RawPost). The backend
// never ships URLs — only what to scan — and never receives raw platform JSON,
// only normalised posts (see EngageScanIngestDto).
//
// The instruction surface is deliberately tiny: for scanType='keyword' the
// keyword IS the scanKey; for 'channel'/'tracked' the extension fetches the
// scope's recent posts WITHOUT keywords (a "scope firehose") and keyword
// matching happens server-side at ingest. So no keyword LIST is ever sent to a
// client — only the org's own unit it is already scanning.

export type ScanTaskPlatform = 'x' | 'reddit' | 'linkedin';
export type ScanTaskType = 'keyword' | 'channel' | 'tracked';

/** Where the extension should resume from (mirrors EngageScanCursor). */
export interface ScanTaskCursor {
  // X since_id / Reddit fullname of the newest post seen last run.
  lastSeenExternalId: string | null;
  // Newest seen post's publish time (ISO 8601) — Reddit's stop condition.
  lastSeenAt: string | null;
}

/**
 * Pacing the EXTENSION must honour, resolved server-side from
 * `engage_scan_pacing` (extension path). Flattened + self-contained so the
 * client has one stable shape to read.
 */
export interface ScanTaskPacing {
  /** Hard cap on pages this run. */
  maxPages: number;
  /** Items requested per page (e.g. Reddit limit / X count). */
  pageSize: number;
  /** Floor wait between pages; actual = pageDelayMs + random(0..pageJitterMs). */
  pageDelayMs: number;
  pageJitterMs: number;
  /** Wait between two DIFFERENT units in one browser. */
  interUnitDelayMs: number;
  interUnitJitterMs: number;
  /** Deterministic ceiling on fetches per browser session per hour. */
  hourlyRequestCap: number;
}

/**
 * One due scan unit handed to the extension. `taskId` is the EngageScanCursor
 * id — the lease handle the extension echoes back on ingest so the backend can
 * advance/release exactly that cursor.
 */
export interface EngageScanTask {
  taskId: string;
  platform: ScanTaskPlatform;
  scanType: ScanTaskType;
  // normalized keyword | subreddit id | username (no leading r/ or @).
  scanKey: string;
  cursor: ScanTaskCursor;
  pacing: ScanTaskPacing;
  /**
   * Optional pre-built platform search query. When present the extension uses
   * it verbatim instead of deriving the query from (scanType, scanKey). The
   * backend sets this for combined queries, e.g. `from:account (kw1 OR kw2)
   * -filter:retweets` for a tracked account narrowed to the org's keywords.
   * The cursor key is unchanged — rawQuery is ephemeral, built at claim time.
   */
  rawQuery?: string;
}

export interface EngageScanTasksResponse {
  tasks: EngageScanTask[];
}

/**
 * Response to POST /engage/scan-tasks/ingest. Besides acknowledging the
 * completed unit, it CHAINS the loop: `nextTasks` is the next batch of due units
 * for this browser — already lease-claimed, and computed at ingest time so any
 * unit another browser (or the workflow) has just scanned is excluded. The
 * extension keeps posting until `nextTasks` comes back empty (nothing due).
 *
 *   GET scan-tasks → tasks ; while (tasks.length) { scan ; tasks = ingest(...) }
 *
 * `accepted` is how many of the posted posts were persisted (after server-side
 * keyword match for channel/tracked scope-firehose results).
 */
export interface EngageScanIngestResponse {
  accepted: number;
  nextTasks: EngageScanTask[];
}

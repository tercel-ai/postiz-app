import { RawPost } from '../engage-scorer';

// ─── Scan unit primitives ─────────────────────────────────────────────────────
//
// The whole engage scanner is built on ONE primitive: "search a platform for a
// set of keywords, optionally restricted to a scope (a tracked account or a
// monitored channel), continuing from where we last stopped". Every scan type
// maps onto it:
//
//   keyword  → no scope; search the whole platform firehose for the keywords
//   tracked  → scope = a username; restrict the search to that author
//   channel  → scope = a subreddit; restrict the search to that community
//
// A PlatformScanAdapter implements that primitive for one platform. The caller
// (the scan activity / scheduler) owns scheduling, the cursor table, the
// per-org fan-out and scoring — the adapter only knows how to fetch.

export type ScanType = 'keyword' | 'tracked' | 'channel';

// NOTE: keyword/tracked scan units are now keyed PER keyword (normalizeKeyword)
// and PER account (normalizeUsername), not by the old bucketed `__global__:<h>` /
// `__tracked__:<h>` sentinels (removed). Legacy bucket cursor rows are orphaned
// on upgrade and cleaned up by a one-off DELETE — see engage scan memory.

export interface ScanScope {
  type: ScanType;
  // 'tracked' → username (no leading @); 'channel' → subreddit id (no "r/").
  // 'keyword' → undefined (whole-platform search).
  key?: string;
  // 'tracked' MAY carry multiple usernames (`keys`) so the adapter can OR-batch
  // `(from:a OR from:b) (kw...)`. The current workflow scans tracked PER account
  // (single `key`); `keys` stays for callers that still batch.
  keys?: string[];
}

// Where the previous fetch stopped. Mirrors the persisted EngageScanCursor
// columns; the adapter reads it to fetch only what is new and returns the
// advanced cursor for the caller to persist.
export interface ScanCursor {
  // Newest external id seen last run. X: tweet id (used as since_id).
  // Reddit: fullname (t3_xxx) of the newest post — informational only.
  lastSeenExternalId?: string | null;
  // Newest post's publish time seen last run. Reddit's incremental stop
  // condition (paginate sort=new until a post is older than this).
  lastSeenAt?: Date | null;
}

// Bounds one scan run so a large backlog (or a runaway pagination loop) cannot
// burn the whole rate-limit budget. maxCalls caps total upstream HTTP calls
// across all internal batches/pages for this unit this run.
export interface ScanBudget {
  maxCalls: number;
  // Pacing between consecutive page fetches within this unit. The wait before
  // each page AFTER the first is `pageDelayMs + random(0..jitterMs)`. Both
  // default to 0 (no delay) when omitted — back-compat with callers that only
  // set maxCalls. The first page is never delayed.
  pageDelayMs?: number;
  jitterMs?: number;
}

// Normalised rate-limit feedback, parsed from platform-specific response
// headers/status. The caller feeds this back into the TokenPool (per-token
// cool-down) and into EngageScanCursor.cooldownUntil (per-unit back-off).
export interface RateLimitInfo {
  // Requests remaining in the current window, when the platform reports it.
  remaining?: number;
  // When the current window resets.
  resetAt?: Date;
  // Suggested wait before retrying, in ms (from 429 Retry-After / reset).
  retryAfterMs?: number;
  // True when this run hit a hard rate-limit / block (429, or X 403 cap).
  limited: boolean;
}

export interface ScanResult {
  posts: RawPost[];
  nextCursor: ScanCursor;
  rate: RateLimitInfo;
  // True when the adapter stopped because budget.maxCalls was exhausted before
  // it could exhaust all pages/batches. Callers may persist returned posts, but
  // must keep the scan retryable instead of treating the cursor/job as complete.
  backlogRemaining?: boolean;
}

export interface ScanLogger {
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface SearchScopedArgs {
  scope: ScanScope;
  // Keywords to match. OR-batched into the platform query by the adapter. An
  // empty list is a no-op (returns empty) — scans are always keyword-driven.
  keywords: string[];
  cursor: ScanCursor;
  budget: ScanBudget;
  // Freshness window in ms (optional). When set, the scan never surfaces a post
  // older than `now - freshnessWindowMs`. The adapter uses it as the `start_time`
  // floor on a first scan / long gap (and drops a stale cursor that would walk
  // past it), plus a client-side cutoff as the final guarantee. Omitted ⇒ no cap
  // (legacy behaviour). Currently honoured by the X adapter; Reddit is TBD.
  freshnessWindowMs?: number;
  // Platform access token. X: bearer/OAuth user token. Reddit: app OAuth token,
  // or null to use the public (loid/proxy) path. The caller resolves this
  // (e.g. from a TokenPool) so the adapter stays stateless.
  token?: string | null;
  log?: ScanLogger;
  // Optional progress callback (wired to Temporal activity heartbeat upstream).
  heartbeat?: (progress?: unknown) => void;
}

export interface AdapterCaps {
  // Cursor is an opaque, monotonic id (X since_id). Else time-based (Reddit).
  incrementalById: boolean;
  // Supports server-side paging beyond one page (X next_token / Reddit after).
  pagination: boolean;
  // Supports restricting a search to a channel (Reddit subreddit).
  channelScoped: boolean;
  // Supports restricting a search to an author (X from:).
  trackedScoped: boolean;
  // Max items the platform returns per call.
  maxPerCall: number;
}

export interface PlatformScanAdapter {
  readonly platform: string;
  readonly caps: AdapterCaps;
  searchScoped(args: SearchScopedArgs): Promise<ScanResult>;
}

// ─── Shared helpers ────────────────────────────────────────────────────────────

const NO_OP_LOGGER: ScanLogger = { log: () => {}, warn: () => {} };

export function resolveLogger(log?: ScanLogger): ScanLogger {
  return log ?? NO_OP_LOGGER;
}

// Group keywords into OR-query strings, each within `maxLen` characters. A
// single keyword that already exceeds maxLen is emitted on its own (the
// platform will truncate/clamp rather than us dropping it silently). Used by
// both adapters so one keyword set becomes the fewest possible queries.
export function batchKeywordsOr(keywords: string[], maxLen: number): string[] {
  const batches: string[] = [];
  let current: string[] = [];
  let len = 0;
  const flush = () => {
    if (!current.length) return;
    batches.push(current.length === 1 ? current[0] : `(${current.join(' OR ')})`);
    current = [];
    len = 0;
  };
  for (const kw of keywords) {
    const add = current.length ? ` OR ${kw}`.length : kw.length;
    if (current.length > 0 && len + add > maxLen) flush();
    current.push(kw);
    len += current.length === 1 ? kw.length : add;
  }
  flush();
  return batches;
}

// Compare two numeric-string ids (e.g. X snowflake tweet ids) without losing
// precision to Number. Returns the larger ("newer") id, or `a` on a tie/parse
// issue. `null`/`undefined` are treated as "older than everything".
export function maxId(a?: string | null, b?: string | null): string | undefined {
  if (a == null) return b ?? undefined;
  if (b == null) return a ?? undefined;
  try {
    return BigInt(a) >= BigInt(b) ? a : b;
  } catch {
    return a;
  }
}

// Parse the suggested retry delay (ms) from a reset epoch (seconds) relative to
// `now`. Clamped to ≥0. Returns undefined when no reset is given.
export function retryAfterFromReset(
  resetEpochSeconds?: number,
  now: number = Date.now()
): number | undefined {
  if (resetEpochSeconds == null || Number.isNaN(resetEpochSeconds)) return undefined;
  return Math.max(0, resetEpochSeconds * 1000 - now);
}

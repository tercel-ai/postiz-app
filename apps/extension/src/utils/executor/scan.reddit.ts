// Reddit scan executor. Fetches Reddit's public .json with the user's own
// logged-in session (`credentials: 'include'`), so the request carries their
// cookies + loid and clears the anti-bot WAF naturally — the whole reason this
// moved into the extension. No cookie is read or sent to our server.
//
// Mirrors the backend RedditScanAdapter normalisation (toRawPost) so the ingest
// payload scores identically. Reddit search has no since_id, so incremental is
// TIME-based: sort=new, page via `after`, stop once a post is older than the
// cursor's lastSeenAt.

import {
  EngageScanTask,
  ScanIngestPost,
  ScanRunResult,
  ScanTaskCursor,
} from './executor.types';
import { applyDelay } from './pacing';

const REDDIT_BASE = 'https://www.reddit.com';
// Page size now comes from server pacing (task.pacing.pageSize, admin-tunable in
// engage_scan_pacing). Reddit's web search loads 25 at a time, so a small size
// mimics a human (limit=100 is a scraper tell → anti-bot risk) AND keeps the
// ingest payload small. This is the fallback if the server omits it (old build).
const REDDIT_LIMIT_FALLBACK = 25;

interface RedditChild {
  data: Record<string, any>;
}
interface RedditListing {
  data?: { after?: string | null; children?: RedditChild[] };
}

/** Build the page URL for a task + pagination cursor. */
function buildUrl(task: EngageScanTask, after?: string): string {
  const limit = task.pacing.pageSize || REDDIT_LIMIT_FALLBACK;
  const afterParam = after ? `&after=${encodeURIComponent(after)}` : '';
  if (task.scanType === 'keyword') {
    const q = encodeURIComponent(task.scanKey);
    return `${REDDIT_BASE}/search.json?q=${q}&sort=new&limit=${limit}&type=link${afterParam}`;
  }
  const sub = encodeURIComponent(task.scanKey);
  if (task.rawQuery) {
    // Keyword-filtered channel scan: mirrors backend RedditScanAdapter channelScoped path.
    // rawQuery = "kw1 OR kw2 OR ..." built by the backend at claim time from org keywords.
    const q = encodeURIComponent(task.rawQuery);
    return `${REDDIT_BASE}/r/${sub}/search.json?q=${q}&restrict_sr=on&sort=new&limit=${limit}&type=link${afterParam}`;
  }
  // Fallback: no org keywords configured — full subreddit feed, server-side keyword filter.
  return `${REDDIT_BASE}/r/${sub}/new.json?limit=${limit}${afterParam}`;
}

// Reddit `created_utc` (epoch SECONDS) → ms, or null when absent/invalid. The
// publish time MUST come from the post itself: an earlier `|| 0` fallback stamped
// 1970 (and any now()-style fallback would stamp the scan moment), both of which
// corrupt recency scoring and the feed's date. Undateable posts are dropped, never
// fabricated.
function redditCreatedAtMs(p: Record<string, any>): number | null {
  const sec = Number(p.created_utc);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
}

function toIngestPost(p: Record<string, any>, atMs: number): ScanIngestPost {
  const subreddit = String(p.subreddit ?? '');
  const title = String(p.title ?? '');
  const selftext = p.selftext ? String(p.selftext) : '';
  return {
    platform: 'reddit',
    externalPostId: String(p.id ?? ''),
    externalPostUrl: `${REDDIT_BASE}${String(p.permalink ?? '')}`,
    authorUsername: String(p.author ?? ''),
    channelId: subreddit,
    channelName: subreddit ? `r/${subreddit}` : undefined,
    // Reddit search has no per-author follower count; authority comes from the
    // subreddit audience size (channelFollowers).
    channelFollowers:
      typeof p.subreddit_subscribers === 'number' ? p.subreddit_subscribers : 0,
    postContent: `${title}${selftext ? '\n' + selftext : ''}`.trim(),
    postPublishedAt: new Date(atMs).toISOString(),
    metricScore: typeof p.score === 'number' ? p.score : 0,
    metricUpvoteRatio:
      typeof p.upvote_ratio === 'number' ? p.upvote_ratio : undefined,
    metricComments: typeof p.num_comments === 'number' ? p.num_comments : 0,
  };
}

/**
 * Scan one Reddit unit. `gate` consumes one hourly-budget token per page fetch
 * and returns false when the cap is hit (the scan stops, backlog remains).
 */
export async function scanReddit(
  task: EngageScanTask,
  gate: () => Promise<boolean>
): Promise<ScanRunResult> {
  const { pacing, cursor } = task;
  const stopBefore = cursor.lastSeenAt
    ? new Date(cursor.lastSeenAt).getTime()
    : null;

  const posts: ScanIngestPost[] = [];
  let newestAtMs = stopBefore ?? 0;
  let newestId: string | null = cursor.lastSeenExternalId ?? null;
  let after: string | undefined;
  let exhausted = true;
  let firstSeen = false;

  for (let page = 0; page < Math.max(1, pacing.maxPages); page++) {
    if (!(await gate())) {
      exhausted = false; // hourly cap hit; backlog remains
      break;
    }
    if (page > 0) await applyDelay(pacing.pageDelayMs, pacing.pageJitterMs);

    let listing: RedditListing | null = null;
    try {
      const res = await fetch(buildUrl(task, after), {
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01',
          Referer: `${REDDIT_BASE}/`,
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.warn(`[aisee][scan][reddit] ${res.status} for ${task.scanKey}`);
        exhausted = false;
        break;
      }
      listing = (await res.json()) as RedditListing;
    } catch (e) {
      console.warn('[aisee][scan][reddit] fetch failed', e);
      exhausted = false;
      break;
    }

    const children = listing?.data?.children ?? [];
    if (!children.length) break; // genuinely no more

    // Filter each item independently rather than breaking at the first stale
    // one: `sort=new` is usually strictly descending, but stickied posts (and
    // any other out-of-order edge case) can interleave an old post between
    // newer ones. A missed break condition must never cost us real posts —
    // duplicates against already-ingested posts are harmless (backend upserts
    // on (platform, externalPostId)). This is separate from the PAGINATION
    // decision below: hitting a stale item still means we've caught up to
    // already-seen data, so further pages would be even older — no reason to
    // pay for another request.
    let sawStale = false;
    for (const child of children) {
      const p = child.data;
      if (p.subreddit_type === 'private') continue;
      const atMs = redditCreatedAtMs(p);
      if (atMs == null) continue; // undateable → drop, never fabricate a publish time
      if (stopBefore != null && atMs <= stopBefore) {
        sawStale = true;
        continue; // already seen/older — drop, but keep scanning the rest of this page
      }
      // Track the newest kept item's id TOGETHER with its timestamp — updating
      // only one of the pair on a later, chronologically-newer item would
      // desync the persisted (id, time) cursor.
      if (!firstSeen || atMs > newestAtMs) {
        newestId = String(p.name ?? p.id ?? newestId ?? '');
        newestAtMs = atMs;
      }
      firstSeen = true;
      posts.push(toIngestPost(p, atMs));
    }

    after = listing?.data?.after ?? undefined;
    if (sawStale || !after) break; // caught up to already-seen data, or no further pages
  }

  const nextCursor: ScanTaskCursor = {
    lastSeenExternalId: newestId,
    lastSeenAt: newestAtMs > 0 ? new Date(newestAtMs).toISOString() : cursor.lastSeenAt,
  };
  return { posts, nextCursor, exhausted };
}

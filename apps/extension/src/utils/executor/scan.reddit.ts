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
// Page size. Reddit's web search loads 25 at a time, so 25 mimics a human
// browsing (limit=100 is a scraper tell → more anti-bot risk) AND keeps the
// per-page ingest payload small. Deeper history still comes from maxPages.
const REDDIT_LIMIT = 25;

interface RedditChild {
  data: Record<string, any>;
}
interface RedditListing {
  data?: { after?: string | null; children?: RedditChild[] };
}

/** Build the page URL for a task + pagination cursor. */
function buildUrl(task: EngageScanTask, after?: string): string {
  const afterParam = after ? `&after=${encodeURIComponent(after)}` : '';
  if (task.scanType === 'keyword') {
    const q = encodeURIComponent(task.scanKey);
    return `${REDDIT_BASE}/search.json?q=${q}&sort=new&limit=${REDDIT_LIMIT}&type=link${afterParam}`;
  }
  // channel scope = keyword-free "scope firehose"; keyword matching is server-side.
  const sub = encodeURIComponent(task.scanKey);
  return `${REDDIT_BASE}/r/${sub}/new.json?limit=${REDDIT_LIMIT}${afterParam}`;
}

function toIngestPost(p: Record<string, any>): ScanIngestPost {
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
    postPublishedAt: new Date(
      ((Number(p.created_utc) || 0) as number) * 1000
    ).toISOString(),
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

    let reachedSeen = false;
    for (const child of children) {
      const p = child.data;
      if (p.subreddit_type === 'private') continue;
      const atMs = (Number(p.created_utc) || 0) * 1000;
      if (stopBefore != null && atMs <= stopBefore) {
        reachedSeen = true; // sort=new descending → everything after is older
        break;
      }
      // First (newest) item overall → capture cursor head.
      if (!firstSeen) {
        firstSeen = true;
        newestId = String(p.name ?? p.id ?? newestId ?? '');
        newestAtMs = atMs;
      }
      if (atMs > newestAtMs) newestAtMs = atMs;
      posts.push(toIngestPost(p));
    }

    after = listing?.data?.after ?? undefined;
    if (reachedSeen || !after) break; // caught up, or no further pages
  }

  const nextCursor: ScanTaskCursor = {
    lastSeenExternalId: newestId,
    lastSeenAt: newestAtMs > 0 ? new Date(newestAtMs).toISOString() : cursor.lastSeenAt,
  };
  return { posts, nextCursor, exhausted };
}

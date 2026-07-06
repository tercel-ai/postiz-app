// X scan executor using a real background x.com tab and the response captured
// from X's own SearchTimeline request. Mirrors the backend XScanAdapter's intent:
//   keyword scope  → search the firehose for the keyword
//   tracked scope  → `from:<username>` restricted search
//   (no channel scope — X has no community concept here)
// The page's own JavaScript creates the request, preserving native browser
// fingerprints (x-client-transaction-id, Referer, sec-fetch and page context).
// SearchTimeline order is not guaranteed strictly chronological (the Top tab
// used for tracked scans ranks by engagement) — every tweet is filtered
// independently against the cursor's lastSeenExternalId, not cut off at the
// first miss.

import {
  EngageScanTask,
  ScanIngestPost,
  ScanRunResult,
  ScanTaskCursor,
} from './executor.types';
import { ParsedTweet, isNewerThan, newerId, parseTimelineTweets } from './x.parse';
import { openXReadTab, readViaProfile } from './x.tab-reader';

// Exactly ONE keyword (or one tracked handle) per query — scanKey is never split,
// OR-joined, or batched with other units. The runner's `scanInFlight` guard and
// `want:1` leasing guarantee one keyword is searched at a time.
export function buildRawQuery(task: EngageScanTask): string {
  // Backend may pre-build a combined query (e.g. `from:account (kw1 OR kw2)
  // -filter:retweets`) and send it as rawQuery. Use it verbatim when present.
  if (task.rawQuery) return task.rawQuery;
  if (task.scanType === 'tracked') {
    // The account's own posts (original/quote/reply), not what it retweeted.
    return `from:${task.scanKey} -filter:retweets`;
  }
  return task.scanKey; // single keyword, firehose
}

/** Pull every parseable tweet out of a SearchTimeline payload. */
export function parseSearchList(data: any): ParsedTweet[] {
  const instructions =
    data?.search_by_raw_query?.search_timeline?.timeline?.instructions ?? [];
  return parseTimelineTweets(instructions);
}

function toIngestPost(t: ParsedTweet): ScanIngestPost {
  return {
    platform: 'x',
    externalPostId: t.id,
    externalPostUrl: `https://x.com/${t.authorUsername || 'i'}/status/${t.id}`,
    authorUsername: t.authorUsername || '',
    authorDisplayName: t.authorDisplayName,
    authorAvatarUrl: t.authorAvatarUrl,
    authorFollowers: t.authorFollowers,
    postContent: t.text,
    postPublishedAt: t.createdAt,
    metricLikes: t.likes,
    metricReplies: t.replies,
    metricRetweets: t.retweets,
    metricQuotes: t.quotes,
    metricBookmarks: t.bookmarks,
    metricViews: t.views,
  };
}

/**
 * Scan one X unit through X's real web page. `gate` consumes one hourly-budget
 * token. A missing tab/capture preserves the cursor and reports exhausted=false
 * so callers can distinguish it from a successful empty result.
 */
export async function scanX(
  task: EngageScanTask,
  gate: () => Promise<boolean>
): Promise<ScanRunResult> {
  const { cursor } = task;
  const sinceId = cursor.lastSeenExternalId ?? undefined;
  const rawQuery = buildRawQuery(task);

  if (!(await gate())) {
    return { posts: [], nextCursor: cursor, exhausted: false };
  }

  // Keyword scans use the Live (chronological) tab: the default Top tab ranks
  // by engagement, so a viral old tweet can rank above genuinely new ones and
  // break the "search results are newest-first" assumption the cursor cutoff
  // below relies on. Tracked scans keep the default Top tab — an account's own
  // posts are sparse enough that Live often returns nothing (see x.collect.ts).
  const liveParam = task.scanType === 'tracked' ? '' : '&f=live';
  const searchUrl =
    'https://x.com/search?q=' +
    encodeURIComponent(rawQuery) +
    liveParam +
    '&src=typed_query';
  let response: unknown | null;
  if (task.scanType === 'tracked') {
    response = await readViaProfile(
      `https://x.com/${task.scanKey}`,
      searchUrl,
      'SearchTimeline'
    );
  } else {
    const session = await openXReadTab();
    if (!session) {
      return { posts: [], nextCursor: cursor, exhausted: false };
    }
    try {
      response = await session.navigateAndCapture(searchUrl, 'SearchTimeline');
    } finally {
      await session.close();
    }
  }
  if (response == null) {
    return { posts: [], nextCursor: cursor, exhausted: false };
  }

  const data = (response as { data?: unknown }).data ?? response;
  const tweets = parseSearchList(data);
  // Filter rather than break: SearchTimeline order is not guaranteed strictly
  // chronological (Top tab isn't; Live tab can still interleave), so a tweet's
  // position in the response must not decide whether later ones are dropped.
  // Duplicates against already-ingested posts are harmless — the backend
  // upserts on (platform, externalPostId).
  const posts: ScanIngestPost[] = [];
  let newestId = cursor.lastSeenExternalId ?? undefined;
  for (const t of tweets) {
    if (!isNewerThan(t.id, sinceId)) continue; // older/already seen — drop
    posts.push(toIngestPost(t));
    newestId = newerId(newestId, t.id);
  }

  const newest = posts.find((p) => p.externalPostId === newestId);
  const nextCursor: ScanTaskCursor = {
    lastSeenExternalId: newestId ?? cursor.lastSeenExternalId,
    lastSeenAt: newest?.postPublishedAt ?? cursor.lastSeenAt,
  };
  return { posts, nextCursor, exhausted: true };
}

// X scan executor using a real background x.com tab and the response captured
// from X's own SearchTimeline request. Mirrors the backend XScanAdapter's intent:
//   keyword scope  → search the firehose for the keyword
//   tracked scope  → `from:<username>` restricted search
//   (no channel scope — X has no community concept here)
// The page's own JavaScript creates the request, preserving native browser
// fingerprints (x-client-transaction-id, Referer, sec-fetch and page context).
// SearchTimeline order is not guaranteed strictly chronological (the Top tab
// ranks by relevance and engagement) — every tweet is filtered
// independently against the cursor's lastSeenExternalId, not cut off at the
// first miss.

import {
  EngageScanTask,
  ScanIngestPost,
  ScanRunResult,
  ScanTaskCursor,
} from './executor.types';
import { applyDelay } from './pacing';
import { ParsedTweet, isNewerThan, newerId, parseTweetResult } from './x.parse';
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

/** Parse only tweet cards that X marks as actual search results. */
export function parseSearchList(data: any): ParsedTweet[] {
  const instructions =
    data?.search_by_raw_query?.search_timeline?.timeline?.instructions ?? [];
  const tweets: ParsedTweet[] = [];
  for (const instruction of instructions) {
    for (const entry of instruction?.entries ?? []) {
      const content = entry?.content;
      const itemContent = content?.itemContent;
      const isSearchResult =
        String(entry?.entryId ?? '').startsWith('tweet-') &&
        content?.entryType === 'TimelineTimelineItem' &&
        content?.clientEventInfo?.component === 'result' &&
        content?.clientEventInfo?.element === 'tweet' &&
        itemContent?.__typename === 'TimelineTweet' &&
        itemContent?.itemType === 'TimelineTweet';
      if (!isSearchResult) continue;
      const tweet = parseTweetResult(itemContent?.tweet_results?.result);
      if (tweet) tweets.push(tweet);
    }
  }
  return tweets;
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
  console.debug('[aisee][scan][x] start', {
    scanType: task.scanType,
    scanKey: task.scanKey,
    rawQuery,
    sinceId: sinceId ?? null,
    cursorLastSeenAt: cursor.lastSeenAt,
    maxPages: task.pacing.maxPages,
  });

  if (!(await gate())) {
    console.debug('[aisee][scan][x] skipped by hourly gate', {
      scanType: task.scanType,
      scanKey: task.scanKey,
    });
    return { posts: [], nextCursor: cursor, exhausted: false };
  }

  const searchUrl =
    'https://x.com/search?q=' +
    encodeURIComponent(rawQuery) +
    '&src=typed_query';
  const responses: unknown[] = [];
  let exhausted = true;
  if (task.scanType === 'tracked') {
    const response = await readViaProfile(
      `https://x.com/${task.scanKey}`,
      searchUrl,
      'SearchTimeline'
    );
    if (response != null) responses.push(response);
  } else {
    const session = await openXReadTab();
    if (!session) {
      console.debug('[aisee][scan][x] no readable X tab', {
        scanType: task.scanType,
        scanKey: task.scanKey,
      });
      return { posts: [], nextCursor: cursor, exhausted: false };
    }
    try {
      const first = await session.navigateAndCapture(searchUrl, 'SearchTimeline');
      if (first != null) responses.push(first);
      if (first != null) {
        const maxPages = Math.max(1, Math.floor(task.pacing.maxPages || 1));
        for (let page = 1; page < maxPages; page++) {
          await applyDelay(task.pacing.pageDelayMs, task.pacing.pageJitterMs);
          if (!(await gate())) {
            exhausted = false;
            console.debug('[aisee][scan][x] stopped by hourly gate during pagination', {
              scanType: task.scanType,
              scanKey: task.scanKey,
              page,
            });
            break;
          }
          const next = await session.scrollAndCapture('SearchTimeline');
          if (next == null) break;
          responses.push(next);
        }
      }
    } finally {
      await session.close();
    }
  }
  if (!responses.length) {
    console.debug('[aisee][scan][x] no SearchTimeline capture', {
      scanType: task.scanType,
      scanKey: task.scanKey,
    });
    return { posts: [], nextCursor: cursor, exhausted: false };
  }

  const pageTweetCounts: number[] = [];
  const tweets = responses.flatMap((response) => {
    const data = (response as { data?: unknown }).data ?? response;
    const parsed = parseSearchList(data);
    pageTweetCounts.push(parsed.length);
    return parsed;
  });
  // Filter rather than break: SearchTimeline order is not guaranteed strictly
  // chronological (Top tab isn't; Live tab can still interleave), so a tweet's
  // position in the response must not decide whether later ones are dropped.
  // Duplicates against already-ingested posts are harmless — the backend
  // upserts on (platform, externalPostId).
  const posts: ScanIngestPost[] = [];
  let newestId = cursor.lastSeenExternalId ?? undefined;
  const seen = new Set<string>();
  let duplicateCount = 0;
  let cursorFilteredCount = 0;
  for (const t of tweets) {
    if (seen.has(t.id)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(t.id);
    if (!isNewerThan(t.id, sinceId)) {
      cursorFilteredCount += 1;
      continue;
    } // older/already seen — drop
    posts.push(toIngestPost(t));
    newestId = newerId(newestId, t.id);
  }

  const newest = posts.find((p) => p.externalPostId === newestId);
  const nextCursor: ScanTaskCursor = {
    lastSeenExternalId: newestId ?? cursor.lastSeenExternalId,
    lastSeenAt: newest?.postPublishedAt ?? cursor.lastSeenAt,
  };
  console.debug('[aisee][scan][x] complete', {
    scanType: task.scanType,
    scanKey: task.scanKey,
    captures: responses.length,
    pageTweetCounts,
    parsedTweets: tweets.length,
    uniqueTweets: seen.size,
    duplicateCount,
    cursorFilteredCount,
    posts: posts.length,
    nextCursor,
    exhausted,
  });
  return { posts, nextCursor, exhausted };
}

// ⚠️ STATUS: STAGED — NOT YET WIRED. Nothing imports this module yet (the live
// the Options collection path uses SearchTimeline / TweetDetail, not UserTweets). It
// is the building block for the real "scrape a fixed list of users" flow: wire it
// by having the scan runner open one openXReadTab() per run and call
// collectUserRecent(session, username, sinceId, limit) per user. Until then it is
// intentionally dead code, covered by x-collect.spec.ts.
//
// Collect a list-user's recent tweets the safe way: drive the logged-in x.com UI
// in a background tab, navigate to the user's profile, and let X's OWN web app
// fire UserTweets — then read the response the document-start interceptor
// (x-capture.ts) captured. Native fingerprint (x-client-transaction-id etc.),
// the same mechanism the in-tab poster uses to publish.
//
// Built for the "scrape a fixed list of users, low frequency" case: the runner
// opens ONE background tab (openXReadTab) for the whole run and calls
// collectUserRecent per user serially, then closes the tab once.

import {
  ParsedTweet,
  parseTweetResult,
  unwrapTweet,
  isNewerThan,
  newerId,
} from './x.parse';
import type { XReadTab } from './x.tab-reader';

/** Canonical profile URL for a screen name (tolerates a leading @). */
export function userProfileUrl(username: string): string {
  const handle = String(username || '')
    .trim()
    .replace(/^@/, '');
  return `https://x.com/${encodeURIComponent(handle)}`;
}

export interface UserTweetsPage {
  tweets: ParsedTweet[];
  bottomCursor?: string;
}

/**
 * Extract tweets from a UserTweets GraphQL `data` payload. Skips the pinned entry
 * (not "recent"), unwraps conversation modules and cursors, and drops retweets
 * (mirrors the tracked intent `from:user -filter:retweets`). Pure + defensive:
 * returns whatever it can read, never throws.
 */
export function parseUserTweets(data: any): UserTweetsPage {
  const instructions =
    data?.user?.result?.timeline_v2?.timeline?.instructions ??
    data?.user?.result?.timeline?.timeline?.instructions ??
    [];
  const tweets: ParsedTweet[] = [];
  let bottomCursor: string | undefined;

  const push = (result: any) => {
    const t = unwrapTweet(result);
    if (!t) return;
    // Skip retweets — we want the user's own posts (original / quote / reply).
    if (t.legacy?.retweeted_status_result) return;
    const parsed = parseTweetResult(result);
    if (parsed) tweets.push(parsed);
  };

  for (const instr of instructions) {
    // Only the add-entries instruction carries the chronological feed; the
    // pinned entry / clear-cache / etc. are intentionally skipped.
    if (instr?.type && instr.type !== 'TimelineAddEntries') continue;
    for (const entry of instr?.entries ?? []) {
      const id: string = entry?.entryId ?? '';
      const content = entry?.content;
      if (id.startsWith('cursor-bottom-') || content?.cursorType === 'Bottom') {
        bottomCursor = content?.value ?? bottomCursor;
        continue;
      }
      if (id.startsWith('tweet-')) {
        push(content?.itemContent?.tweet_results?.result);
      } else if (Array.isArray(content?.items)) {
        for (const it of content.items) {
          push(it?.item?.itemContent?.tweet_results?.result);
        }
      }
    }
  }
  return { tweets, bottomCursor };
}

export interface UserCollectResult {
  username: string;
  tweets: ParsedTweet[];
  /** Newest tweet id seen this run, for the since_id cursor (undefined if none). */
  newestId?: string;
}

/**
 * Navigate the shared background tab to `username`'s profile, let X fire
 * UserTweets, and return up to `limit` tweets strictly newer than `sinceId`
 * (incremental). Returns an empty list (not an error) on capture failure so one
 * bad user never aborts the run.
 */
export async function collectUserRecent(
  session: XReadTab,
  username: string,
  sinceId: string | undefined,
  limit: number
): Promise<UserCollectResult> {
  const resp = await session.navigateAndCapture(
    userProfileUrl(username),
    'UserTweets'
  );
  if (resp == null) return { username, tweets: [] };
  const data = (resp as { data?: unknown }).data ?? resp;
  const { tweets } = parseUserTweets(data);

  // Advance the cursor to the newest id across the whole page (even seen ones),
  // then return the most-recent `limit` that are strictly newer than sinceId.
  let newestId = sinceId;
  for (const tw of tweets) newestId = newerId(newestId, tw.id);
  const fresh = tweets
    .filter((tw) => isNewerThan(tw.id, sinceId))
    .slice(0, Math.max(0, limit));
  return { username, tweets: fresh, newestId };
}

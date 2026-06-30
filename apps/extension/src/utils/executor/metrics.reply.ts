// Scrape ONE published reply's own metrics from its release page, on demand.
//
// Drives the "click Engagements → extension reads the reply's page → page posts
// the counters to the backend" loop. The fetch path per platform mirrors the
// Options page's "by post id" tools, so it is the same battle-tested mechanism:
//   X      → x.com/i/web/status/<replyTweetId> → intercept TweetDetail
//   Reddit → the comment thread .json via the user's session cookies
//
// Returns the RAW public counters only. The server (PATCH /engage/sent/:id/
// metrics) owns the weighted Traffic-index / impressions formulas — the
// extension must never compute them, so an extension refresh and a server pull
// stay byte-for-byte consistent downstream.

import { fetchXPostFromPage } from './x.collect';
import { fetchRedditReplyMetrics } from './reddit.collect';

export interface ReplyMetricsResult {
  platform: 'x' | 'reddit';
  // X public_metrics
  impressions?: number;
  likes?: number;
  replies?: number;
  retweets?: number;
  quotes?: number;
  bookmarks?: number;
  // Reddit comment counters
  score?: number;
  comments?: number;
}

/**
 * Fetch the reply's metrics for the given platform + release URL.
 *
 * @param platform    'x' | 'reddit' (the opportunity/reply platform).
 * @param releaseURL  The reply's own permalink (tweet URL / comment URL).
 * @returns The raw counters, or null when nothing could be read (deleted post,
 *          X tier block, malformed URL) — the caller surfaces this as an error.
 */
export async function fetchReplyMetrics(
  platform: string,
  releaseURL: string
): Promise<ReplyMetricsResult | null> {
  const url = String(releaseURL || '').trim();
  if (!url) return null;

  if (platform === 'x') {
    const tweet = await fetchXPostFromPage(url);
    if (!tweet) return null;
    return {
      platform: 'x',
      impressions: tweet.views,
      likes: tweet.likes,
      replies: tweet.replies,
      retweets: tweet.retweets,
      quotes: tweet.quotes,
      bookmarks: tweet.bookmarks,
    };
  }

  if (platform === 'reddit') {
    const m = await fetchRedditReplyMetrics(url);
    if (!m) return null;
    return { platform: 'reddit', score: m.score, comments: m.comments };
  }

  return null;
}

// Fetch live metrics for a published X post via internal GraphQL
// (TweetResultByRestId) using the user's session, shaped as AnalyticsData the
// backend's extractMetrics/traffic pipeline understands. X weights
// (traffic.calculator): likes 1, replies 2, retweets 1.5, quotes 2,
// bookmarks 1.5; impressions label for x = "impressions" (← views count).

import { AnalyticsSeries } from './executor.types';
import { xGraphqlGet, X_SEARCH_FEATURES } from './x.graphql';
import { parseTweetResult } from './x.parse';

const NOW_ISO = () => new Date().toISOString();
const point = (total: number): AnalyticsSeries['data'] => [
  { total, date: NOW_ISO() },
];

/** Extract the numeric status id from any X/Twitter status URL. */
export function statusIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m =
      u.pathname.match(/\/status(?:es)?\/(\d+)/) ??
      u.pathname.match(/\/i\/web\/status\/(\d+)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function fetchXMetrics(
  releaseURL: string
): Promise<AnalyticsSeries[] | null> {
  const id = statusIdFromUrl(releaseURL);
  if (!id) return null;

  const data = await xGraphqlGet('TweetResultByRestId', {
    variables: {
      tweetId: id,
      withCommunity: false,
      includePromotedContent: false,
      withVoice: false,
    },
    features: X_SEARCH_FEATURES,
  });
  if (!data) return null;

  const t = parseTweetResult(data?.tweetResult?.result);
  if (!t) {
    console.warn('[aisee][metrics][x] could not parse tweet', id);
    return null;
  }

  return [
    { label: 'impressions', data: point(t.views) },
    { label: 'likes', data: point(t.likes) },
    { label: 'replies', data: point(t.replies) },
    { label: 'retweets', data: point(t.retweets) },
    { label: 'quotes', data: point(t.quotes) },
    { label: 'bookmarks', data: point(t.bookmarks) },
  ];
}

import { AnalyticsSeries } from './executor.types';
import { fetchRedditMetrics } from './metrics.reddit';
import {
  DEFAULT_HOURLY_FETCH_CAP,
  spaceConsecutiveFetches,
  tryConsumeHourly,
} from './pacing';
import { fetchXPostFromPage } from './x.collect';

function point(total: number): AnalyticsSeries['data'] {
  return [{ total, date: new Date().toISOString() }];
}

/** Fetch current metrics for one regular published post using the browser session. */
export async function fetchPostMetrics(
  platform: string,
  releaseURL: string
): Promise<AnalyticsSeries[] | null> {
  const url = String(releaseURL || '').trim();
  if ((platform !== 'x' && platform !== 'reddit') || !url) return null;
  if (!(await tryConsumeHourly(DEFAULT_HOURLY_FETCH_CAP, platform))) {
    throw new Error(`Hourly ${platform} metrics limit reached`);
  }
  // Space consecutive page-driven fetches like the batch runner does, so a busy
  // calendar view does not fire back-to-back requests at machine cadence.
  await spaceConsecutiveFetches(platform);

  if (platform === 'reddit') return fetchRedditMetrics(url);

  const tweet = await fetchXPostFromPage(url);
  if (!tweet) return null;
  return [
    { label: 'impressions', data: point(tweet.views) },
    { label: 'likes', data: point(tweet.likes) },
    { label: 'replies', data: point(tweet.replies) },
    { label: 'retweets', data: point(tweet.retweets) },
    { label: 'quotes', data: point(tweet.quotes) },
    { label: 'bookmarks', data: point(tweet.bookmarks) },
  ];
}

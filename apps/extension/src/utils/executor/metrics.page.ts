import { AnalyticsSeries } from './executor.types';
import { fetchRedditMetrics } from './metrics.reddit';
import { tryConsumeHourly } from './pacing';
import { fetchXPostFromPage } from './x.collect';

const METRICS_HOURLY_CAP = 60;

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
  if (!(await tryConsumeHourly(METRICS_HOURLY_CAP, platform))) {
    throw new Error(`Hourly ${platform} metrics limit reached`);
  }

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

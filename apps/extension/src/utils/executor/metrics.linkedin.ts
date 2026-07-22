// Fetch live metrics for a published LinkedIn post by opening its page in a
// background tab and scraping the rendered engagement counters (reactions /
// comments / reposts / impressions), shaped as the AnalyticsData series the
// backend's extractMetrics/traffic pipeline consumes. Impressions are only
// present on the author's OWN posts (LinkedIn hides them from other viewers).
//
// The emitted labels (impressions/likes/comments/shares) match the backend
// traffic.calculator `linkedin` weights, so the scraped engagement folds into
// the Traffic score exactly like the OAuth-sync path does.

import { AnalyticsSeries } from './executor.types';
import { buildLinkedinAnalytics } from '@gitroom/extension/utils/linkedin/dom';
import { readLinkedinPostMetrics } from '@gitroom/extension/utils/linkedin/tab-reader';

export async function fetchLinkedinMetrics(
  releaseURL: string
): Promise<AnalyticsSeries[] | null> {
  const url = String(releaseURL || '').trim();
  if (!/^https?:\/\/(www\.)?linkedin\.com\//i.test(url)) return null;

  const raw = await readLinkedinPostMetrics(url);
  if (!raw) return null;
  return buildLinkedinAnalytics(raw);
}

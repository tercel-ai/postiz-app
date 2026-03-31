import { AnalyticsData } from './social.integrations.interface';

/**
 * Per-platform Traffic calculation formulas.
 * Traffic is a weighted engagement score (proxy for real traffic/clicks).
 *
 * Each entry maps a lowercase metric label → weight.
 * The final Traffic score = Σ(metric_value × weight).
 */
const TRAFFIC_WEIGHTS: Record<string, Record<string, number>> = {
  x: {
    likes: 1,
    replies: 2,
    retweets: 1.5,
    quotes: 2,
    bookmarks: 1.5,
  },
  youtube: {
    views: 1,
    likes: 2,
    comments: 5,
    favorites: 2, // closest available field
  },
  instagram: {
    likes: 1,
    comments: 3,
    saves: 5,
    shares: 4,
  },
  'instagram-standalone': {
    likes: 1,
    comments: 3,
    saves: 5,
    shares: 4,
  },
  'linkedin-page': {
    clicks: 5,
    likes: 1,
    comments: 4,
    shares: 3,
    engagement: 0.5,
  },
  facebook: {
    clicks: 3,
    reactions: 1,
  },
  threads: {
    likes: 1,
    replies: 2,
    reposts: 1.5,
    quotes: 2,
  },
  pinterest: {
    'pin clicks': 3,
    'outbound clicks': 5,
    saves: 2,
  },
  tiktok: {
    views: 0.1,
    likes: 1,
    comments: 3,
    shares: 4,
  },
  linkedin: {
    impressions: 0.05,
    likes: 1,
    comments: 4,
    shares: 3,
    reach: 0.1,
  },
  reddit: {
    score: 0.5,
    upvotes: 1,
    comments: 3,
  },
  bluesky: {
    likes: 1,
    reposts: 1.5,
    replies: 2,
    quotes: 2,
  },
  mastodon: {
    favourites: 1,
    boosts: 1.5,
    replies: 2,
  },
  'mastodon-custom': {
    favourites: 1,
    boosts: 1.5,
    replies: 2,
  },
};

/** Fallback weights for platforms without a specific formula. */
const FALLBACK_WEIGHTS: Record<string, number> = {
  likes: 1,
  comments: 3,
  shares: 2,
  clicks: 5,
};

/**
 * Compute a Traffic score from post analytics metrics using
 * per-platform weighted formulas.
 *
 * @param platform - The platform identifier (e.g. 'x', 'instagram')
 * @param metrics  - The AnalyticsData[] returned by postAnalytics
 * @returns The computed traffic score (number), or null if no relevant metrics found
 */
export function computeTrafficScore(
  platform: string,
  metrics: AnalyticsData[]
): number | null {
  const weights = TRAFFIC_WEIGHTS[platform.toLowerCase()] || FALLBACK_WEIGHTS;
  let score = 0;
  let hasMatch = false;

  for (const metric of metrics) {
    const label = metric.label.toLowerCase();
    const weight = weights[label];
    if (weight === undefined) continue;

    hasMatch = true;
    for (const point of metric.data) {
      score += Number(point.total || 0) * weight;
    }
  }

  return hasMatch ? Math.round(score * 100) / 100 : null;
}

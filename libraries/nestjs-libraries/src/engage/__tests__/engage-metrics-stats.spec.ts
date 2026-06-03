import { describe, it, expect } from 'vitest';
import {
  classifyReplyMetric,
  normalizeReplyMetrics,
} from '@gitroom/nestjs-libraries/engage/engage-metrics-stats';

const base = { releaseURL: 'https://x.com/u/status/1', releaseId: '1', integrationId: 'i1' };

describe('classifyReplyMetric', () => {
  it('has_metrics whenever impressions are populated, regardless of platform', () => {
    expect(classifyReplyMetric({ ...base, platform: 'x', impressions: 5 })).toBe('has_metrics');
    expect(classifyReplyMetric({ platform: 'reddit', impressions: 0, releaseURL: null, releaseId: null, integrationId: null })).toBe('has_metrics'); // 0 is a real value
  });

  it('no_release_url takes priority — nothing to fetch without a link', () => {
    expect(classifyReplyMetric({ platform: 'x', impressions: null, releaseURL: null, releaseId: '1', integrationId: 'i1' })).toBe('no_release_url');
    expect(classifyReplyMetric({ platform: 'reddit', impressions: null, releaseURL: '', releaseId: null, integrationId: null })).toBe('no_release_url');
  });

  it('X without an integration → no_integration', () => {
    expect(classifyReplyMetric({ ...base, platform: 'x', impressions: null, integrationId: null })).toBe('no_integration');
  });

  it('X with integration but no parsed tweet id → no_release_id', () => {
    expect(classifyReplyMetric({ ...base, platform: 'x', impressions: null, releaseId: null })).toBe('no_release_id');
  });

  it('all prerequisites present but still null → syncable', () => {
    expect(classifyReplyMetric({ ...base, platform: 'x', impressions: null })).toBe('syncable');
  });

  it('Reddit needs only a releaseURL (no integration/releaseId checks)', () => {
    expect(classifyReplyMetric({ platform: 'reddit', impressions: null, releaseURL: 'https://reddit.com/r/x/comments/a/b/c', releaseId: null, integrationId: null })).toBe('syncable');
  });
});

describe('normalizeReplyMetrics', () => {
  const xAnalytics = [
    { label: 'Impressions', data: [{ total: '7' }] },
    { label: 'Likes', data: [{ total: '2' }] },
    { label: 'Retweets', data: [{ total: '0' }] },
    { label: 'Replies', data: [{ total: '1' }] },
    { label: 'Quotes', data: [{ total: '0' }] },
    { label: 'Bookmarks', data: [{ total: '1' }] },
  ];

  it('flattens X analytics into a full key set', () => {
    expect(normalizeReplyMetrics('x', xAnalytics, 7, 5.5)).toEqual({
      trafficScore: 5.5,
      impressions: 7,
      likes: 2,
      retweets: 0,
      replies: 1,
      quotes: 0,
      bookmarks: 1,
    });
  });

  it('flattens Reddit analytics → upvotes/comments/estReach', () => {
    const reddit = [
      { label: 'score', data: [{ total: '10' }] },
      { label: 'comments', data: [{ total: '3' }] },
    ];
    // estReach falls back to (upvotes+comments)*20 when impressions is null
    expect(normalizeReplyMetrics('reddit', reddit, null, 19)).toEqual({
      trafficScore: 19,
      upvotes: 10,
      comments: 3,
      estReach: (10 + 3) * 20,
    });
    // and uses the synced impressions when present
    expect(normalizeReplyMetrics('reddit', reddit, 500, 19).estReach).toBe(500);
  });

  it('every field is present (0-default) and never throws on null/garbage analytics', () => {
    const x = normalizeReplyMetrics('x', null, null, null);
    expect(x).toEqual({
      trafficScore: 0,
      impressions: 0,
      likes: 0,
      retweets: 0,
      replies: 0,
      quotes: 0,
      bookmarks: 0,
    });
    expect(normalizeReplyMetrics('x', 'not-an-array', undefined, undefined).bookmarks).toBe(0);
  });
});

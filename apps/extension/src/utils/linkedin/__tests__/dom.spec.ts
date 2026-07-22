import { describe, expect, it } from 'vitest';
import {
  activityIdFromUrl,
  buildLinkedinAnalytics,
  handleFromProfileUrl,
  parseMetric,
  parseReactionText,
  relativeTimeToIso,
  toScanIngestPost,
} from '../dom';

describe('linkedin/dom parseMetric', () => {
  it('parses plain, thousands and millions', () => {
    expect(parseMetric('1,234')).toBe(1234);
    expect(parseMetric('3.4K')).toBe(3400);
    expect(parseMetric('2M')).toBe(2_000_000);
    expect(parseMetric('')).toBe(0);
    expect(parseMetric('no digits')).toBe(0);
  });
});

describe('linkedin/dom parseReactionText', () => {
  it('reads explicit reaction counts', () => {
    expect(parseReactionText('42 reactions')).toBe(42);
    expect(parseReactionText('1.2K reactions · 30 comments')).toBe(1200);
  });
  it('reads the "<name> and N others" shape (named reactor + N others)', () => {
    expect(parseReactionText('Jane Doe and 12 others')).toBe(13);
  });
  it('reads a count sitting before comments/reposts', () => {
    expect(parseReactionText('88 5 comments 2 reposts')).toBe(88);
  });
});

describe('linkedin/dom relativeTimeToIso', () => {
  const now = Date.parse('2026-07-22T12:00:00.000Z');
  it('subtracts the relative unit from now', () => {
    expect(relativeTimeToIso('2h', now)).toBe('2026-07-22T10:00:00.000Z');
    expect(relativeTimeToIso('3d', now)).toBe('2026-07-19T12:00:00.000Z');
    expect(relativeTimeToIso('5m', now)).toBe('2026-07-22T11:55:00.000Z');
    expect(relativeTimeToIso('1w', now)).toBe('2026-07-15T12:00:00.000Z');
  });
  it('returns null for an unrecognised stamp', () => {
    expect(relativeTimeToIso('just now', now)).toBeNull();
    expect(relativeTimeToIso('', now)).toBeNull();
  });
});

describe('linkedin/dom activityIdFromUrl', () => {
  it('pulls the id out of a urn or permalink', () => {
    expect(activityIdFromUrl('urn:li:activity:7123456789012345678')).toBe(
      '7123456789012345678'
    );
    expect(
      activityIdFromUrl(
        'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/'
      )
    ).toBe('7123456789012345678');
    expect(activityIdFromUrl('https://www.linkedin.com/feed/')).toBeNull();
  });
});

describe('linkedin/dom handleFromProfileUrl', () => {
  it('extracts the /in/<handle> slug', () => {
    expect(
      handleFromProfileUrl('https://www.linkedin.com/in/john-doe/')
    ).toBe('john-doe');
    expect(
      handleFromProfileUrl('https://www.linkedin.com/company/acme/')
    ).toBe('');
  });
});

describe('linkedin/dom toScanIngestPost', () => {
  const iso = '2026-07-22T10:00:00.000Z';
  it('maps a scraped row to the ingest shape', () => {
    const post = toScanIngestPost(
      {
        author: 'Jane Doe',
        authorProfileUrl: 'https://www.linkedin.com/in/jane/',
        authorAvatarUrl: 'https://media/pic.jpg',
        body: 'hello world',
        reactions: 12,
        comments: 3,
        reposts: 1,
        impressions: 500,
        url: 'https://www.linkedin.com/feed/update/urn:li:activity:99/',
        urn: 'urn:li:activity:99',
      },
      iso
    );
    expect(post).toMatchObject({
      platform: 'linkedin',
      externalPostId: '99',
      authorUsername: 'jane',
      authorDisplayName: 'Jane Doe',
      postContent: 'hello world',
      postPublishedAt: iso,
      metricLikes: 12,
      metricComments: 3,
      metricShares: 1,
      metricViews: 500,
    });
  });
  it('drops rows with no resolvable id or no content', () => {
    expect(
      toScanIngestPost({ body: 'x', url: 'https://www.linkedin.com/feed/' }, iso)
    ).toBeNull();
    expect(
      toScanIngestPost({ urn: 'urn:li:activity:1', body: '', url: '' }, iso)
    ).toBeNull();
  });
});

describe('linkedin/dom buildLinkedinAnalytics', () => {
  it('shapes counters into labelled analytics series', () => {
    const series = buildLinkedinAnalytics({
      reactions: 10,
      comments: 4,
      reposts: 2,
      impressions: 800,
    });
    const byLabel = Object.fromEntries(
      series.map((s) => [s.label, s.data[0].total])
    );
    expect(byLabel).toEqual({
      impressions: 800,
      likes: 10,
      comments: 4,
      shares: 2,
    });
  });
});

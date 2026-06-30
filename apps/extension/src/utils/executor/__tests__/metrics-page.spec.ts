import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchXPostFromPage, fetchRedditMetrics, tryConsumeHourly } = vi.hoisted(() => ({
  fetchXPostFromPage: vi.fn(),
  fetchRedditMetrics: vi.fn(),
  tryConsumeHourly: vi.fn(),
}));

vi.mock('../x.collect', () => ({ fetchXPostFromPage }));
vi.mock('../metrics.reddit', () => ({ fetchRedditMetrics }));
vi.mock('../pacing', () => ({ tryConsumeHourly }));

import { fetchPostMetrics } from '../metrics.page';

describe('fetchPostMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tryConsumeHourly.mockResolvedValue(true);
  });

  it('reads X through the real page collector and returns ingest-shaped analytics', async () => {
    fetchXPostFromPage.mockResolvedValue({
      views: 100,
      likes: 2,
      replies: 3,
      retweets: 4,
      quotes: 5,
      bookmarks: 6,
    });

    const result = await fetchPostMetrics('x', 'https://x.com/a/status/1');

    expect(fetchXPostFromPage).toHaveBeenCalledWith('https://x.com/a/status/1');
    expect(tryConsumeHourly).toHaveBeenCalledWith(60, 'x');
    expect(result?.map((item) => [item.label, item.data[0].total])).toEqual([
      ['impressions', 100], ['likes', 2], ['replies', 3],
      ['retweets', 4], ['quotes', 5], ['bookmarks', 6],
    ]);
  });

  it('uses a separate Reddit pacing scope and submission collector', async () => {
    fetchRedditMetrics.mockResolvedValue([{ label: 'score', data: [] }]);
    await expect(fetchPostMetrics('reddit', 'https://reddit.com/r/a/comments/1/x')).resolves.toEqual([
      { label: 'score', data: [] },
    ]);
    expect(tryConsumeHourly).toHaveBeenCalledWith(60, 'reddit');
  });
});

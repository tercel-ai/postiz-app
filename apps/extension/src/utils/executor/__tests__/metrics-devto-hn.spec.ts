import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchDevtoMetrics,
  parseDevtoArticlePath,
} from '../metrics.devto';
import {
  fetchHackernewsMetrics,
  parseHackernewsItemId,
} from '../metrics.hackernews';

describe('parseDevtoArticlePath', () => {
  it('extracts username + slug', () => {
    expect(parseDevtoArticlePath('https://dev.to/ben/my-post-123')).toEqual({
      username: 'ben',
      slug: 'my-post-123',
    });
  });
  it('rejects non-dev.to and malformed URLs', () => {
    expect(parseDevtoArticlePath('https://medium.com/@ben/x')).toBeNull();
    expect(parseDevtoArticlePath('https://dev.to/ben')).toBeNull();
    expect(parseDevtoArticlePath('not a url')).toBeNull();
  });
});

describe('parseHackernewsItemId', () => {
  it('extracts a numeric id from an item URL', () => {
    expect(
      parseHackernewsItemId('https://news.ycombinator.com/item?id=12345')
    ).toBe('12345');
  });
  it('rejects non-HN hosts and non-numeric ids', () => {
    expect(parseHackernewsItemId('https://example.com/item?id=1')).toBeNull();
    expect(parseHackernewsItemId('https://news.ycombinator.com/item?id=abc')).toBeNull();
    expect(parseHackernewsItemId('https://news.ycombinator.com/newest')).toBeNull();
  });
});

describe('fetchDevtoMetrics', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shapes reactions + comments from an anonymous public read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: 1,
          public_reactions_count: 10,
          comments_count: 3,
          // page_views_count is present in the payload but intentionally NOT
          // emitted anonymously (needs the author's key, held server-side).
          page_views_count: 500,
        }),
      }))
    );
    const series = await fetchDevtoMetrics('https://dev.to/ben/post-1');
    expect(series).toEqual([
      { label: 'reactions', data: [expect.objectContaining({ total: 10 })] },
      { label: 'comments', data: [expect.objectContaining({ total: 3 })] },
    ]);
  });

  it('returns null for a non-dev.to URL without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchDevtoMetrics('https://medium.com/@x/y')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchHackernewsMetrics', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shapes score + comments from the Firebase item', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ id: 9, score: 128, descendants: 42, type: 'story' }),
      }))
    );
    const series = await fetchHackernewsMetrics(
      'https://news.ycombinator.com/item?id=9'
    );
    expect(series).toEqual([
      { label: 'score', data: [expect.objectContaining({ total: 128 })] },
      { label: 'comments', data: [expect.objectContaining({ total: 42 })] },
    ]);
  });

  it('returns null for deleted items', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ id: 9, deleted: true }),
      }))
    );
    expect(
      await fetchHackernewsMetrics('https://news.ycombinator.com/item?id=9')
    ).toBeNull();
  });
});

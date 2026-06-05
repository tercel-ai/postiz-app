import { describe, expect, it, vi } from 'vitest';
import { syncRedditMetrics } from '../engage-metrics-sync';

vi.mock('../reddit-auth', () => ({
  getRedditToken: vi.fn(async () => 'reddit-token'),
  redditAuthHeaders: vi.fn(() => ({ authorization: 'Bearer reddit-token' })),
}));

describe('syncRedditMetrics', () => {
  it('stores numeric zeros when Reddit comment info has no num_comments field', async () => {
    const updatePostMetrics = vi.fn(async () => undefined);
    const markAuthorReplied = vi.fn(async () => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: {
            children: [
              {
                data: {
                  score: 23,
                },
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([
          {},
          {
            data: {
              children: [
                {
                  data: {
                    replies: '',
                  },
                },
              ],
            },
          },
        ]),
      });
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await syncRedditMetrics(
      'post-1',
      'https://www.reddit.com/r/SEO/comments/1skxs73/comment/og2vc34/',
      'reply-1',
      '',
      {
        updatePostMetrics,
        markAuthorReplied,
        checkPostAnalytics: vi.fn(async () => []),
        warn: vi.fn(),
        log: vi.fn(),
      }
    );

    expect(outcome).toBe('written');
    expect(updatePostMetrics).toHaveBeenCalledWith(
      'post-1',
      460,
      [
        { label: 'score', data: [{ total: '23', date: expect.any(String) }], percentageChange: 0 },
        { label: 'comments', data: [{ total: '0', date: expect.any(String) }], percentageChange: 0 },
      ],
      23
    );
  });

  it('uses direct child replies as Reddit comment count', async () => {
    const updatePostMetrics = vi.fn(async () => undefined);
    const markAuthorReplied = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: { children: [{ data: { score: 5 } }] },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([
          {},
          {
            data: {
              children: [
                {
                  data: {
                    replies: {
                      data: {
                        children: [
                          { kind: 't1', data: { author: 'original-author' } },
                          { kind: 't1', data: { author: 'someone-else' } },
                          { kind: 'more', data: {} },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          },
        ]),
      }));

    await syncRedditMetrics(
      'post-1',
      'https://www.reddit.com/r/SEO/comments/1skxs73/comment/og2vc34/',
      'reply-1',
      'original-author',
      {
        updatePostMetrics,
        markAuthorReplied,
        checkPostAnalytics: vi.fn(async () => []),
        warn: vi.fn(),
        log: vi.fn(),
      }
    );

    expect(updatePostMetrics).toHaveBeenCalledWith(
      'post-1',
      140,
      [
        { label: 'score', data: [{ total: '5', date: expect.any(String) }], percentageChange: 0 },
        { label: 'comments', data: [{ total: '2', date: expect.any(String) }], percentageChange: 0 },
      ],
      11
    );
    expect(markAuthorReplied).toHaveBeenCalledWith('reply-1');
  });
});

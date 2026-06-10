import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRedditAuthorProfile, _clearRedditAuthorL1 } from '../engage-author';
import { getRedditToken } from '../reddit-auth';
import { redditPublicGet } from '../reddit-loid';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

vi.mock('../reddit-auth', () => ({
  getRedditToken: vi.fn(),
  redditAuthHeaders: vi.fn(() => ({ Authorization: 'Bearer token' })),
}));

vi.mock('../reddit-loid', () => ({
  redditPublicGet: vi.fn(),
}));

describe('fetchRedditAuthorProfile', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(getRedditToken).mockResolvedValue('token');
    // The /about lookup is now served through the L1+L2 author cache. Force a
    // guaranteed cache MISS so the network-fallback path is exercised
    // deterministically regardless of any real Redis (L2) state.
    _clearRedditAuthorL1();
    vi.spyOn(ioRedis, 'get').mockResolvedValue(null);
    vi.spyOn(ioRedis, 'set').mockResolvedValue('OK' as never);
  });

  it('falls back to public JSON when Reddit OAuth rejects the author lookup', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
    } as Response);
    vi.mocked(redditPublicGet)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: { children: [{ data: { author: 'reply_user' } }] },
        }),
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: {
            id: 'abc',
            snoovatar_img: 'https://avatar.example/u.png',
            subreddit: { title: 'Reply User' },
          },
        }),
      } as never);
    const logs: string[] = [];

    const profile = await fetchRedditAuthorProfile(
      'https://www.reddit.com/r/test/comments/post/comment/reply123/',
      (message) => logs.push(message)
    );

    expect(profile).toEqual({
      handle: 'reply_user',
      id: 't2_abc',
      name: 'Reply User',
      avatarUrl: 'https://avatar.example/u.png',
    });
    expect(redditPublicGet).toHaveBeenCalledTimes(2);
    expect(logs.some((message) => message.includes('retrying via public JSON'))).toBe(true);
  });
});

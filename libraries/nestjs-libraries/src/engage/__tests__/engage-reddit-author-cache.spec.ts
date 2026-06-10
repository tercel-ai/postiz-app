/**
 * getRedditUserAbout — L1 (in-process Map) + L2 (per-server Redis) cache for a
 * Reddit user's /about profile, including the real follower count
 * (data.subreddit.subscribers). The network primitives are mocked; L2 runs through
 * the real ioRedis (a MockRedis when REDIS_URL is unset).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Force the public (loid) path and control its response.
vi.mock('../reddit-auth', () => ({
  getRedditToken: vi.fn().mockResolvedValue(null),
  redditAuthHeaders: vi.fn(() => ({})),
}));
vi.mock('../reddit-loid', () => ({
  redditPublicGet: vi.fn(),
}));

import { redditPublicGet } from '../reddit-loid';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { getRedditUserAbout, _clearRedditAuthorL1 } from '../engage-author';

const publicGetMock = redditPublicGet as unknown as ReturnType<typeof vi.fn>;

/** Fake /about response body with a given follower (subscribers) count. */
function aboutResponse(subscribers: number | undefined, id = 'abc') {
  const body = JSON.stringify({
    data: {
      id,
      snoovatar_img: 'https://img/a.png?w=1&amp;h=1',
      subreddit: { title: 'Display Name', subscribers },
    },
  });
  return { ok: true, status: 200, text: async () => body };
}

describe('getRedditUserAbout — L1/L2 author cache', () => {
  beforeEach(async () => {
    publicGetMock.mockReset();
    _clearRedditAuthorL1();
    try { await ioRedis.del('postiz:reddit:author:alice'); } catch { /* ignore */ }
  });

  it('cold fetch: parses real followers, returns profile, writes L2', async () => {
    publicGetMock.mockResolvedValue(aboutResponse(1234));
    const setSpy = vi.spyOn(ioRedis, 'set');

    const about = await getRedditUserAbout('alice');

    expect(about?.followers).toBe(1234);
    expect(about?.id).toBe('t2_abc');
    expect(about?.name).toBe('Display Name');
    expect(about?.avatarUrl).toBe('https://img/a.png?w=1&h=1'); // &amp; decoded
    expect(publicGetMock).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(
      'postiz:reddit:author:alice',
      expect.any(String),
      'EX',
      expect.any(Number)
    );
    setSpy.mockRestore();
  });

  it('L1 hit: a second lookup within TTL does not re-fetch (dedup)', async () => {
    publicGetMock.mockResolvedValue(aboutResponse(50));
    await getRedditUserAbout('alice');
    publicGetMock.mockClear();

    const about = await getRedditUserAbout('alice');

    expect(about?.followers).toBe(50);
    expect(publicGetMock).not.toHaveBeenCalled(); // served from L1
  });

  it('L2 hit: a fresh process (empty L1) adopts the cached profile without fetching', async () => {
    _clearRedditAuthorL1();
    const getSpy = vi
      .spyOn(ioRedis, 'get')
      .mockResolvedValue(JSON.stringify({ id: 't2_x', name: 'N', followers: 777 }));

    const about = await getRedditUserAbout('alice');

    expect(about?.followers).toBe(777);
    expect(publicGetMock).not.toHaveBeenCalled();
    getSpy.mockRestore();
  });

  it('case-insensitive key: Alice and alice share one cache entry', async () => {
    publicGetMock.mockResolvedValue(aboutResponse(9));
    await getRedditUserAbout('Alice');
    publicGetMock.mockClear();

    const about = await getRedditUserAbout('alice');

    expect(about?.followers).toBe(9);
    expect(publicGetMock).not.toHaveBeenCalled();
  });

  it('missing subscribers field → followers null (still cached)', async () => {
    publicGetMock.mockResolvedValue(aboutResponse(undefined));
    const about = await getRedditUserAbout('alice');
    expect(about?.followers).toBeNull();
  });

  it('[deleted] / empty username → null without any fetch', async () => {
    expect(await getRedditUserAbout('[deleted]')).toBeNull();
    expect(await getRedditUserAbout('')).toBeNull();
    expect(publicGetMock).not.toHaveBeenCalled();
  });

  it('unreachable /about (not ok) → null, not cached', async () => {
    publicGetMock.mockResolvedValue({ ok: false, status: 403, text: async () => '' });
    expect(await getRedditUserAbout('alice')).toBeNull();
  });

  it('Redis down on read degrades to a network fetch (never throws)', async () => {
    _clearRedditAuthorL1();
    const getSpy = vi.spyOn(ioRedis, 'get').mockRejectedValue(new Error('redis down'));
    publicGetMock.mockResolvedValue(aboutResponse(42));

    const about = await getRedditUserAbout('alice');

    expect(about?.followers).toBe(42);
    getSpy.mockRestore();
  });
});

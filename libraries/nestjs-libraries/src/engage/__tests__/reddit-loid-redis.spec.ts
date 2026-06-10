/**
 * L1 (in-memory) + L2 (per-server Redis) loid cache, and the critical 403-evict
 * invariant: a loid that Reddit flags BEFORE its TTL must be dropped from BOTH
 * layers, so the re-mint never reads the bad loid back out of Redis.
 *
 * The mint network call (undici.request) is mocked; the L2 layer is exercised
 * through the real ioRedis (a MockRedis when REDIS_URL is unset) plus spies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock ONLY undici.request (the loid mint) — keep Agent/ProxyAgent/Dispatcher real.
vi.mock('undici', async (importActual) => {
  const actual = await importActual<typeof import('undici')>();
  return { ...actual, request: vi.fn() };
});

import { request } from 'undici';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { getRedditLoidCookie, clearRedditLoidCache } from '../reddit-loid';

const requestMock = request as unknown as ReturnType<typeof vi.fn>;

/** A fake mint response that sets `loid=<value>` via Set-Cookie. */
function mintResponse(value: string) {
  return {
    headers: { 'set-cookie': `loid=${value}; Path=/; Domain=.reddit.com; Max-Age=34560000` },
    body: { text: async () => '' },
  };
}

describe('reddit-loid — L1/L2 cache + 403 eviction', () => {
  beforeEach(async () => {
    requestMock.mockReset();
    await clearRedditLoidCache(); // reset L1 + L2 between tests
    requestMock.mockReset(); // clearRedditLoidCache may not call request, but be safe
  });

  afterEach(async () => {
    await clearRedditLoidCache();
  });

  it('cold start: mints once, returns the loid, and writes it to the shared (L2) cache', async () => {
    requestMock.mockResolvedValue(mintResponse('FRESH'));
    const setSpy = vi.spyOn(ioRedis, 'set');

    const cookie = await getRedditLoidCookie();

    expect(cookie).toBe('loid=FRESH');
    expect(requestMock).toHaveBeenCalledTimes(1); // one mint
    expect(setSpy).toHaveBeenCalledTimes(1); // shared to L2
    setSpy.mockRestore();
  });

  it('L1 hit: a second call within TTL does NOT mint again', async () => {
    requestMock.mockResolvedValue(mintResponse('FRESH'));
    await getRedditLoidCookie(); // mint + cache
    requestMock.mockClear();

    const cookie = await getRedditLoidCookie();

    expect(cookie).toBe('loid=FRESH');
    expect(requestMock).not.toHaveBeenCalled(); // served from L1
  });

  it('L2 hit: a fresh process (empty L1) adopts the host loid from Redis without minting', async () => {
    // Simulate "another process already minted": L1 empty, Redis returns a value.
    const getSpy = vi
      .spyOn(ioRedis, 'get')
      .mockResolvedValue(JSON.stringify({ cookie: 'loid=SHARED', expiresAt: Date.now() + 60_000 }));

    const cookie = await getRedditLoidCookie();

    expect(cookie).toBe('loid=SHARED');
    expect(requestMock).not.toHaveBeenCalled(); // no cold mint — reused L2
    getSpy.mockRestore();
  });

  it('clearRedditLoidCache evicts the shared Redis key (DEL), not just L1', async () => {
    const delSpy = vi.spyOn(ioRedis, 'del');
    await clearRedditLoidCache();
    expect(delSpy).toHaveBeenCalledWith(expect.stringContaining('postiz:reddit:loid:'));
    delSpy.mockRestore();
  });

  it('403 invariant: a flagged loid in Redis is DROPPED and re-mint fetches a NEW one (no read-back)', async () => {
    // 1) Mint BAD and share it to L2.
    requestMock.mockResolvedValue(mintResponse('BAD'));
    expect(await getRedditLoidCookie()).toBe('loid=BAD');

    // 2) Reddit flags it → caller hits 403 → evicts both layers.
    await clearRedditLoidCache();

    // 3) Re-mint MUST produce the fresh loid, never the BAD one read back from L2.
    requestMock.mockResolvedValue(mintResponse('FRESH'));
    const cookie = await getRedditLoidCookie();

    expect(cookie).toBe('loid=FRESH');
    expect(cookie).not.toContain('BAD');
  });

  it('Redis down: a failing L2 read degrades to L1-only minting (never throws)', async () => {
    const getSpy = vi.spyOn(ioRedis, 'get').mockRejectedValue(new Error('redis down'));
    requestMock.mockResolvedValue(mintResponse('FRESH'));

    const cookie = await getRedditLoidCookie();

    expect(cookie).toBe('loid=FRESH'); // swallowed the Redis error, minted anyway
    getSpy.mockRestore();
  });
});

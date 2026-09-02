import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  RedisThrottlerStorage,
  createThrottlerStorage,
} from '../redis-throttler.storage';

/** Minimal in-process stand-in for the Lua script's Redis-side behaviour. */
function fakeRedis() {
  const hits = new Map<string, { n: number; expiresAt: number }>();
  const blocks = new Map<string, number>();
  const pttl = (expiresAt: number) => Math.max(0, expiresAt - Date.now());

  return {
    eval: vi.fn(
      async (
        _script: string,
        _numKeys: number,
        hitKey: string,
        blockKey: string,
        ttlMs: string,
        limit: string,
        blockMs: string
      ) => {
        const now = Date.now();
        const blockExpiry = blocks.get(blockKey) ?? 0;
        if (blockExpiry > now) {
          const cur = hits.get(hitKey);
          return [cur?.n ?? 0, cur ? pttl(cur.expiresAt) : 0, 1, pttl(blockExpiry)];
        }
        const cur = hits.get(hitKey);
        const live = cur && cur.expiresAt > now ? cur : undefined;
        const next = {
          n: (live?.n ?? 0) + 1,
          expiresAt: live?.expiresAt ?? now + Number(ttlMs),
        };
        hits.set(hitKey, next);
        if (next.n > Number(limit)) {
          blocks.set(blockKey, now + Number(blockMs));
          return [next.n, pttl(next.expiresAt), 1, Number(blockMs)];
        }
        return [next.n, pttl(next.expiresAt), 0, 0];
      }
    ),
  } as any;
}

const build = () => {
  const redis = fakeRedis();
  return { storage: new RedisThrottlerStorage(redis), redis };
};

afterEach(() => {
  delete process.env.REDIS_URL_TEST_SHADOW;
});

describe('RedisThrottlerStorage.increment', () => {
  it('counts hits and reports the window in SECONDS', async () => {
    // The guard publishes timeToExpire straight into Retry-After, so the unit
    // has to match the package's own storage (ms in, seconds out).
    const { storage } = build();
    const first = await storage.increment('k', 60_000, 5, 60_000, 'default');
    expect(first.totalHits).toBe(1);
    expect(first.isBlocked).toBe(false);
    expect(first.timeToExpire).toBeGreaterThan(0);
    expect(first.timeToExpire).toBeLessThanOrEqual(60);

    const second = await storage.increment('k', 60_000, 5, 60_000, 'default');
    expect(second.totalHits).toBe(2);
  });

  it('blocks only once the count goes PAST the limit', async () => {
    const { storage } = build();
    for (let i = 0; i < 3; i++) {
      const r = await storage.increment('k', 60_000, 3, 60_000, 'default');
      expect(r.isBlocked).toBe(false);
    }
    const over = await storage.increment('k', 60_000, 3, 60_000, 'default');
    expect(over.isBlocked).toBe(true);
    expect(over.timeToBlockExpire).toBeGreaterThan(0);
  });

  it('keeps separate counters per key and per throttler name', async () => {
    const { storage } = build();
    await storage.increment('a', 60_000, 1, 60_000, 'default');
    await storage.increment('a', 60_000, 1, 60_000, 'default');
    expect((await storage.increment('b', 60_000, 1, 60_000, 'default')).isBlocked).toBe(
      false
    );
    expect(
      (await storage.increment('a', 60_000, 1, 60_000, 'other')).isBlocked
    ).toBe(false);
  });

  it('shares one counter across instances — the whole point of moving off the Map', async () => {
    const redis = fakeRedis();
    const podA = new RedisThrottlerStorage(redis);
    const podB = new RedisThrottlerStorage(redis);
    await podA.increment('k', 60_000, 2, 60_000, 'default');
    await podB.increment('k', 60_000, 2, 60_000, 'default');
    // Third hit crosses the limit of 2 no matter which replica serves it.
    expect((await podA.increment('k', 60_000, 2, 60_000, 'default')).isBlocked).toBe(
      true
    );
  });

  it('fails OPEN when Redis is unreachable', async () => {
    const { storage, redis } = build();
    redis.eval.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await storage.increment('k', 60_000, 1, 60_000, 'default');
    // The guard throws only on isBlocked — an unblocked zero-hit record admits
    // the request rather than 500-ing every throttled route.
    expect(r).toEqual({
      totalHits: 0,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it('substitutes a sane window for an unusable ttl', async () => {
    const { storage, redis } = build();
    await storage.increment('k', 0, 5, 0, 'default');
    // ttl 0 would make PEXPIRE reject the key outright.
    expect(redis.eval.mock.calls[0][4]).toBe('60000');
    expect(redis.eval.mock.calls[0][6]).toBe('60000');
  });
});

describe('createThrottlerStorage', () => {
  it('returns undefined without REDIS_URL, so the package keeps its in-memory default', () => {
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      expect(createThrottlerStorage()).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.REDIS_URL = saved;
    }
  });

  it('returns a Redis-backed storage when REDIS_URL is set', () => {
    const saved = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://localhost:6379';
    try {
      expect(createThrottlerStorage()).toBeInstanceOf(RedisThrottlerStorage);
    } finally {
      if (saved === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = saved;
    }
  });
});

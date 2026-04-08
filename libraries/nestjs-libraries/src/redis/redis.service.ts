import { Redis } from 'ioredis';

// Create a mock Redis implementation for testing environments.
//
// Backwards-compatible with the original simple stub: `get(missing)` still
// returns undefined, `del(any)` still returns 1. Added on top:
//   - `set(key, value, 'EX', ttl)` honours the TTL (entries auto-expire on read)
//   - `set(key, value, 'EX', ttl, 'NX')` returns null when the key already
//     exists, matching ioredis. This is the primitive used by
//     `notifyOncePerCooldown` below.
class MockRedis {
  private data: Map<string, any> = new Map();
  private expiries: Map<string, number> = new Map();

  private _evictIfExpired(key: string): void {
    const exp = this.expiries.get(key);
    if (exp !== undefined && Date.now() >= exp) {
      this.data.delete(key);
      this.expiries.delete(key);
    }
  }

  async get(key: string) {
    this._evictIfExpired(key);
    return this.data.get(key);
  }

  async set(key: string, value: any, ...args: any[]) {
    let ttlSeconds: number | null = null;
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      const token = String(args[i]).toUpperCase();
      if (token === 'EX') {
        ttlSeconds = Number(args[i + 1]);
        i++;
      } else if (token === 'NX') {
        nx = true;
      }
    }

    if (nx) {
      this._evictIfExpired(key);
      if (this.data.has(key)) {
        return null; // ioredis returns null when NX fails
      }
    }

    this.data.set(key, value);
    if (ttlSeconds !== null && Number.isFinite(ttlSeconds)) {
      this.expiries.set(key, Date.now() + ttlSeconds * 1000);
    } else {
      this.expiries.delete(key);
    }
    return 'OK';
  }

  async del(key: string) {
    this.data.delete(key);
    this.expiries.delete(key);
    return 1;
  }
}

// Use real Redis if REDIS_URL is defined, otherwise use MockRedis
export const ioRedis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      connectTimeout: 10000,
    })
  : (new MockRedis() as unknown as Redis); // Type cast to Redis to maintain interface compatibility

/**
 * Run `notify` at most once per `cooldownSeconds` for the given (provider, event,
 * subject) tuple. Backed by Redis SET NX EX so the dedupe is atomic and shared
 * across backend instances.
 *
 * Use this for user-facing notifications that would otherwise be sent on every
 * cron tick (e.g. "your X account is suspended"). The Redis key auto-expires, so
 * no manual cleanup is needed when the underlying condition resolves.
 *
 * @returns true if `notify` was actually invoked, false if it was suppressed by
 *          the cooldown.
 */
export async function notifyOncePerCooldown(opts: {
  provider: string;
  event: string;
  subjectId: string;
  cooldownSeconds: number;
  notify: () => Promise<void>;
}): Promise<boolean> {
  const cooldown = Math.max(60, Math.floor(opts.cooldownSeconds || 0) || 86400);
  const key = `postiz:notify-cooldown:${opts.provider}:${opts.event}:${opts.subjectId}`;
  try {
    const result = await ioRedis.set(key, '1', 'EX', cooldown, 'NX');
    if (result !== 'OK') {
      return false; // already notified within the cooldown window
    }
  } catch (err: any) {
    // If Redis is unavailable, fall through and notify anyway. Better a duplicate
    // than a dropped warning when the user's account is genuinely broken.
    console.warn(
      `[notifyOncePerCooldown] Redis SET failed for ${key}: ${
        err?.message || err
      }; sending notification anyway`
    );
  }
  await opts.notify();
  return true;
}

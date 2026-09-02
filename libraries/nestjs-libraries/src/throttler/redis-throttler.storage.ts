import { Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

/**
 * The shape `@nestjs/throttler` expects back from a storage `increment`.
 * Declared structurally rather than imported: the package re-exports
 * `ThrottlerStorage` from its index but NOT `ThrottlerStorageRecord`, and a deep
 * import into `dist/` would break on any internal reshuffle.
 */
export interface ThrottlerRecord {
  totalHits: number;
  /** Seconds until the hit window resets. */
  timeToExpire: number;
  isBlocked: boolean;
  /** Seconds until the block lifts; 0 when not blocked. */
  timeToBlockExpire: number;
}

const KEY_PREFIX = 'postiz:throttle';

/**
 * One round trip that counts a hit and decides whether it is blocked.
 *
 * Atomic because the alternative — read, compare, write — lets N replicas each
 * see the same under-limit count and all admit, which is exactly the failure
 * this storage exists to fix.
 *
 * KEYS: [1] hit counter, [2] block marker
 * ARGV: [1] ttl ms, [2] limit, [3] block duration ms
 * Returns: { hits, hitsPttl, isBlocked 0|1, blockPttl }
 */
const INCREMENT_SCRIPT = `
local blockPttl = redis.call('PTTL', KEYS[2])
if blockPttl > 0 then
  local blockedHits = tonumber(redis.call('GET', KEYS[1]) or '0')
  return { blockedHits, redis.call('PTTL', KEYS[1]), 1, blockPttl }
end
local hits = redis.call('INCR', KEYS[1])
local pttl = redis.call('PTTL', KEYS[1])
-- PTTL is -1 on a key with no expiry (the INCR that just created it) and -2 when
-- the key vanished between the two calls; both mean "start the window now".
if pttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  pttl = tonumber(ARGV[1])
end
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return { hits, pttl, 1, tonumber(ARGV[3]) }
end
return { hits, pttl, 0, 0 }
`;

/**
 * Redis-backed `ThrottlerStorage`, replacing the package's in-memory default.
 *
 * The default keeps its counters in a per-process `Map`, so every `@Throttle` in
 * the app silently multiplied by the replica count: a route documented as
 * "20 generations per user per hour" allowed 20 × however many backend pods were
 * running, and the number moved whenever the deployment scaled. Nothing in the
 * code said so, which is what made it worth fixing before any new limit is
 * written against it.
 *
 * Only constructed when `REDIS_URL` is set — see `createThrottlerStorage`. A
 * self-hosted single-process install has nothing to share and keeps the
 * in-memory default.
 */
@Injectable()
export class RedisThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly redis: Redis;

  constructor(redis: Redis = ioRedis) {
    this.redis = redis;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string
  ): Promise<ThrottlerRecord> {
    // The guard resolves blockDuration to ttl when a route sets none, but a
    // malformed route config could still land here with something unusable.
    const ttlMs = Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 60_000;
    const blockMs =
      Number.isFinite(blockDuration) && blockDuration > 0
        ? Math.floor(blockDuration)
        : ttlMs;
    const hitKey = `${KEY_PREFIX}:${throttlerName}:${key}`;
    const blockKey = `${hitKey}:blocked`;

    try {
      const raw = (await this.redis.eval(
        INCREMENT_SCRIPT,
        2,
        hitKey,
        blockKey,
        String(ttlMs),
        String(limit),
        String(blockMs)
      )) as [number, number, number, number];

      const [hits, hitsPttl, blocked, blockPttl] = raw.map(Number);
      return {
        totalHits: hits,
        // Seconds, matching the package's own in-memory storage — the guard
        // publishes this straight into the Retry-After / X-RateLimit headers.
        timeToExpire: Math.ceil(Math.max(0, hitsPttl) / 1000),
        isBlocked: blocked === 1,
        timeToBlockExpire: Math.ceil(Math.max(0, blockPttl) / 1000),
      };
    } catch (err) {
      // Fail OPEN. The guard throws only on `isBlocked`, so reporting an
      // unblocked zero-hit record admits the request. A Redis incident must not
      // turn every throttled route into a 500 — an hour of unthrottled traffic
      // is recoverable, a total outage of the posting and engage APIs is not.
      // Logged at error so a silently suspended limiter is visible.
      this.logger.error(
        `Throttler storage unavailable for ${throttlerName}; allowing this request unmetered`,
        err as Error
      );
      return {
        totalHits: 0,
        timeToExpire: Math.ceil(ttlMs / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }
}

/**
 * The storage to hand `ThrottlerModule.forRoot`.
 *
 * `undefined` is meaningful: the module's own provider falls back to the
 * in-memory `ThrottlerStorageService` when `options.storage` is falsy, which is
 * the right behaviour for a single-process install with no Redis to share.
 */
export function createThrottlerStorage(): RedisThrottlerStorage | undefined {
  return process.env.REDIS_URL ? new RedisThrottlerStorage() : undefined;
}

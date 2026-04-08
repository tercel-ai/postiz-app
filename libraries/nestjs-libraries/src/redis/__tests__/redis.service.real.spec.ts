// Side-effect import: load .env from process.cwd() BEFORE any other module
// reads process.env. ES module hoisting evaluates imports in source order, so
// keeping this as the first import guarantees REDIS_URL is set before
// `redis.service` evaluates it (where it decides MockRedis vs real Redis).
//
// We do this only in this integration spec — other test files continue to run
// against MockRedis with no env pollution.
import 'dotenv/config';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Redis } from 'ioredis';
import { notifyOncePerCooldown } from '../redis.service';

// ---------------------------------------------------------------------------
// Real-Redis integration test.
//
// Purpose: catch the case where MockRedis behaviour silently diverges from real
// ioredis (e.g. SET NX EX semantics, return values, TTL handling), so that a
// regression doesn't slip into production where notifications would either spam
// or get silently dropped.
//
// This suite is OPT-IN. It runs only when REDIS_URL is defined in the env. The
// test file mints its own ioredis client against REDIS_URL (it does NOT touch
// the shared ioRedis export, because that one is initialised at import time
// based on the env at process start; this test runs late and we want a
// dedicated client we can disconnect cleanly).
//
// To run:
//   REDIS_URL=redis://localhost:6379 \
//     pnpm vitest run libraries/nestjs-libraries/src/redis/__tests__/redis.service.real.spec.ts
//
// In CI you can spin up a redis service container and set REDIS_URL.
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL;
const describeIfRedis = REDIS_URL ? describe : describe.skip;

describeIfRedis('redis.service — real Redis integration', () => {
  let realRedis: Redis;
  const testKeyPrefix = `postiz-test:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2, 8)}:`;

  beforeEach(async () => {
    realRedis = new Redis(REDIS_URL!, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      lazyConnect: false,
    });
  });

  afterAll(async () => {
    if (realRedis) {
      try {
        // Best-effort cleanup of any leftover keys with our test prefix
        const keys = await realRedis.keys(`${testKeyPrefix}*`);
        if (keys.length) {
          await realRedis.del(...keys);
        }
      } catch {}
      await realRedis.quit();
    }
  });

  describe('SET NX EX matches MockRedis behaviour', () => {
    it('first SET NX returns OK and stores the value', async () => {
      const key = `${testKeyPrefix}nx-first`;
      const result = await realRedis.set(key, 'v1', 'EX', 60, 'NX');
      expect(result).toBe('OK');
      expect(await realRedis.get(key)).toBe('v1');
    });

    it('second SET NX on existing key returns null and preserves original', async () => {
      const key = `${testKeyPrefix}nx-dedupe`;
      await realRedis.set(key, 'v1', 'EX', 60, 'NX');
      const second = await realRedis.set(key, 'v2', 'EX', 60, 'NX');
      // ioredis returns null when NX fails
      expect(second).toBeNull();
      expect(await realRedis.get(key)).toBe('v1');
    });

    it('SET NX succeeds again after the key TTL elapses', async () => {
      const key = `${testKeyPrefix}nx-expiry`;
      const first = await realRedis.set(key, 'v1', 'EX', 1, 'NX');
      expect(first).toBe('OK');

      // Wait for the 1-second TTL to expire on the real Redis side
      await new Promise((r) => setTimeout(r, 1500));

      const second = await realRedis.set(key, 'v2', 'EX', 60, 'NX');
      expect(second).toBe('OK');
      expect(await realRedis.get(key)).toBe('v2');
    }, 10000);

    it('GET on a missing key returns null (not undefined)', async () => {
      const key = `${testKeyPrefix}missing`;
      const value = await realRedis.get(key);
      // Real ioredis returns null for missing keys. Existing Postiz code uses
      // `if (!val)` checks so both null and undefined work, but pinning the
      // contract here prevents a future surprise.
      expect(value).toBeNull();
    });
  });

  describe('notifyOncePerCooldown against real Redis', () => {
    // notifyOncePerCooldown reads from the SHARED ioRedis export (not our test
    // client). Because REDIS_URL is set in this run, that shared export is also
    // a real Redis client pointing at the same instance, so they share state.

    it('invokes notify exactly once across multiple calls within cooldown', async () => {
      const subjectId = `${testKeyPrefix}sub-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const notify = vi.fn(async () => {});

      const r1 = await notifyOncePerCooldown({
        provider: 'test-x',
        event: 'suspended',
        subjectId,
        cooldownSeconds: 600,
        notify,
      });
      const r2 = await notifyOncePerCooldown({
        provider: 'test-x',
        event: 'suspended',
        subjectId,
        cooldownSeconds: 600,
        notify,
      });
      const r3 = await notifyOncePerCooldown({
        provider: 'test-x',
        event: 'suspended',
        subjectId,
        cooldownSeconds: 600,
        notify,
      });

      expect(r1).toBe(true);
      expect(r2).toBe(false);
      expect(r3).toBe(false);
      expect(notify).toHaveBeenCalledTimes(1);

      // Cleanup
      await realRedis.del(
        `postiz:notify-cooldown:test-x:suspended:${subjectId}`
      );
    });

    it('different subjectIds dedupe independently', async () => {
      const sub1 = `${testKeyPrefix}sub-a-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const sub2 = `${testKeyPrefix}sub-b-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const notify = vi.fn(async () => {});

      const r1 = await notifyOncePerCooldown({
        provider: 'test-x',
        event: 'suspended',
        subjectId: sub1,
        cooldownSeconds: 600,
        notify,
      });
      const r2 = await notifyOncePerCooldown({
        provider: 'test-x',
        event: 'suspended',
        subjectId: sub2,
        cooldownSeconds: 600,
        notify,
      });

      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(notify).toHaveBeenCalledTimes(2);

      // Cleanup
      await realRedis.del(
        `postiz:notify-cooldown:test-x:suspended:${sub1}`,
        `postiz:notify-cooldown:test-x:suspended:${sub2}`
      );
    });
  });
});

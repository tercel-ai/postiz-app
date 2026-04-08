import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ioRedis, notifyOncePerCooldown } from '../redis.service';

// These tests run against the in-memory MockRedis (no REDIS_URL in env). They
// exercise the SET NX EX semantics and the notifyOncePerCooldown helper that
// the X suspended-account dedupe relies on.

describe('MockRedis', () => {
  beforeEach(async () => {
    // Best-effort cleanup of keys used by tests in this file
    await ioRedis.del('test:plain');
    await ioRedis.del('test:nx');
    await ioRedis.del('test:expiry');
  });

  it('SET stores a value retrievable via GET', async () => {
    const ok = await ioRedis.set('test:plain', 'hello');
    expect(ok).toBe('OK');
    expect(await ioRedis.get('test:plain')).toBe('hello');
  });

  it('SET key value EX 60 stores a value with TTL', async () => {
    const ok = await ioRedis.set('test:expiry', 'v', 'EX', 60);
    expect(ok).toBe('OK');
    expect(await ioRedis.get('test:expiry')).toBe('v');
  });

  it('SET NX returns OK on first call and null on subsequent calls', async () => {
    const first = await ioRedis.set('test:nx', '1', 'EX', 3600, 'NX');
    expect(first).toBe('OK');

    const second = await ioRedis.set('test:nx', '2', 'EX', 3600, 'NX');
    expect(second).toBeNull();

    // Original value preserved
    expect(await ioRedis.get('test:nx')).toBe('1');
  });

  it('SET NX succeeds again after the previous TTL expires', async () => {
    // 1 second TTL
    const first = await ioRedis.set('test:nx', '1', 'EX', 1, 'NX');
    expect(first).toBe('OK');

    // Block while waiting for TTL to elapse. Use fake timers via Date.now stub
    // would be cleaner, but we keep the test self-contained: 1.1s is acceptable.
    await new Promise((r) => setTimeout(r, 1100));

    const second = await ioRedis.set('test:nx', '2', 'EX', 60, 'NX');
    expect(second).toBe('OK');
    expect(await ioRedis.get('test:nx')).toBe('2');
  }, 5000);

  it('DEL removes the key', async () => {
    await ioRedis.set('test:plain', 'x');
    await ioRedis.del('test:plain');
    // MockRedis preserves the original behavior of returning undefined for
    // missing keys (real ioredis returns null — both are falsy and code paths
    // use `if (!val)` checks).
    expect(await ioRedis.get('test:plain')).toBeFalsy();
  });
});

describe('notifyOncePerCooldown', () => {
  beforeEach(async () => {
    await ioRedis.del(
      'postiz:notify-cooldown:x:suspended:integration-abc'
    );
    await ioRedis.del(
      'postiz:notify-cooldown:x:suspended:integration-xyz'
    );
  });

  it('invokes notify on first call within the cooldown window', async () => {
    const notify = vi.fn(async () => {});
    const result = await notifyOncePerCooldown({
      provider: 'x',
      event: 'suspended',
      subjectId: 'integration-abc',
      cooldownSeconds: 3600,
      notify,
    });

    expect(result).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('suppresses notify on subsequent calls within the cooldown window', async () => {
    const notify = vi.fn(async () => {});

    await notifyOncePerCooldown({
      provider: 'x',
      event: 'suspended',
      subjectId: 'integration-abc',
      cooldownSeconds: 3600,
      notify,
    });

    const second = await notifyOncePerCooldown({
      provider: 'x',
      event: 'suspended',
      subjectId: 'integration-abc',
      cooldownSeconds: 3600,
      notify,
    });

    expect(second).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('different subjectIds are deduped independently', async () => {
    const notify = vi.fn(async () => {});

    await notifyOncePerCooldown({
      provider: 'x',
      event: 'suspended',
      subjectId: 'integration-abc',
      cooldownSeconds: 3600,
      notify,
    });

    const second = await notifyOncePerCooldown({
      provider: 'x',
      event: 'suspended',
      subjectId: 'integration-xyz',
      cooldownSeconds: 3600,
      notify,
    });

    expect(second).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('clamps cooldown below 60 seconds to 60 seconds', async () => {
    // We can't directly observe the TTL value with MockRedis, but we can verify
    // the helper still applies dedupe (i.e. clamping doesn't somehow short-circuit).
    const notify = vi.fn(async () => {});

    await notifyOncePerCooldown({
      provider: 'x',
      event: 'suspended',
      subjectId: 'integration-abc',
      cooldownSeconds: 1,
      notify,
    });

    const second = await notifyOncePerCooldown({
      provider: 'x',
      event: 'suspended',
      subjectId: 'integration-abc',
      cooldownSeconds: 1,
      notify,
    });

    expect(second).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('falls through and notifies if Redis SET throws', async () => {
    const notify = vi.fn(async () => {});
    const setSpy = vi
      .spyOn(ioRedis, 'set')
      .mockRejectedValueOnce(new Error('redis down') as never);

    const result = await notifyOncePerCooldown({
      provider: 'x',
      event: 'suspended',
      subjectId: 'integration-abc',
      cooldownSeconds: 3600,
      notify,
    });

    expect(result).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);

    setSpy.mockRestore();
  });
});

import { describe, it, expect } from 'vitest';
import { TokenPool } from '../scan/token-pool';

describe('TokenPool', () => {
  it('round-robins least-recently-used tokens', () => {
    let t = 1_000;
    const pool = new TokenPool(['a', 'b', 'c'], () => t);
    // First three acquisitions touch each distinct token (all start at lastUsed 0,
    // ties broken by array order).
    expect(pool.acquire()).toBe('a');
    t += 1;
    expect(pool.acquire()).toBe('b');
    t += 1;
    expect(pool.acquire()).toBe('c');
    t += 1;
    // Now 'a' is the least-recently-used again.
    expect(pool.acquire()).toBe('a');
  });

  it('parks a token until retryAfter after a hard limit', () => {
    let t = 0;
    const pool = new TokenPool(['a', 'b'], () => t);
    pool.report('a', { limited: true, retryAfterMs: 5_000 });
    expect(pool.available()).toBe(1); // only 'b' usable
    expect(pool.acquire()).toBe('b');
    t = 4_999;
    expect(pool.available()).toBe(1);
    t = 5_001;
    expect(pool.available()).toBe(2); // 'a' recovered
  });

  it('parks a token whose window is exhausted until reset', () => {
    let t = 0;
    const pool = new TokenPool(['a'], () => t);
    pool.report('a', { limited: false, remaining: 0, resetAt: new Date(10_000) });
    expect(pool.acquire()).toBeNull();
    t = 10_000;
    expect(pool.acquire()).toBe('a');
  });

  it('acquire returns null and nextAvailableAt reports recovery time when all parked', () => {
    let t = 0;
    const pool = new TokenPool(['a', 'b'], () => t);
    pool.report('a', { limited: true, retryAfterMs: 3_000 });
    pool.report('b', { limited: true, retryAfterMs: 8_000 });
    expect(pool.acquire()).toBeNull();
    expect(pool.nextAvailableAt()?.getTime()).toBe(3_000); // soonest of the two
  });

  it('uses a default 60s cool-down when no retry hint is given', () => {
    let t = 0;
    const pool = new TokenPool(['a'], () => t);
    pool.report('a', { limited: true });
    t = 59_000;
    expect(pool.available()).toBe(0);
    t = 60_001;
    expect(pool.available()).toBe(1);
  });
});

// The fast-lane hint that closes the gap between a keyword landing in the DB
// and the extension scanning it. See engage-scan-hint.ts for why it exists.
//
// NOTE ON ISOLATION: vitest.config.ts loads `dotenv/config` as a setup file, so
// if the developer's .env defines REDIS_URL these run against a REAL, SHARED
// Redis rather than the in-memory MockRedis. Spec files run in parallel, so a
// fixed org id like `org1` would collide with any other spec touching the same
// key and fail intermittently. Every test here takes a process- and
// counter-unique org id instead — never hardcode one.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  markEngageScanWork,
  hasEngageScanWork,
  readEngageScanWork,
  clearEngageScanWork,
} from '../engage-scan-hint';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

let seq = 0;
const orgId = () => `spec-hint-${process.pid}-${++seq}`;

describe('engage scan hint', () => {
  let org1: string;
  let org2: string;
  beforeEach(() => {
    org1 = orgId();
    org2 = orgId();
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports no work until something is marked', async () => {
    expect(await hasEngageScanWork(org1)).toBe(false);
    await markEngageScanWork(org1);
    expect(await hasEngageScanWork(org1)).toBe(true);
  });

  it('is scoped per organization', async () => {
    await markEngageScanWork(org1);
    expect(await hasEngageScanWork(org2)).toBe(false);
  });

  it('clears back to no-work', async () => {
    await markEngageScanWork(org1);
    await clearEngageScanWork(org1);
    expect(await hasEngageScanWork(org1)).toBe(false);
  });

  it('treats a blank org id as no work rather than probing redis', async () => {
    const get = vi.spyOn(ioRedis, 'get');
    expect(await hasEngageScanWork('')).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  // A hint is an optimization layered on top of the unconditional backstop
  // poll, so it must never be able to fail the write that raised it.
  it('swallows a redis failure when marking', async () => {
    vi.spyOn(ioRedis, 'set').mockRejectedValue(new Error('redis down'));
    await expect(markEngageScanWork(org1)).resolves.toBeUndefined();
  });

  // Fails CLOSED. Reporting work on a Redis failure would have every extension
  // drive a full scan loop every 60s instead of every 15 min — ~15x the load,
  // at the moment the backend is already degraded. Losing the fast lane only
  // costs latency, so that is the safe direction.
  it('reports no work when redis cannot be read', async () => {
    vi.spyOn(ioRedis, 'get').mockRejectedValue(new Error('redis down'));
    expect(await hasEngageScanWork(org1)).toBe(false);
  });

  // ioRedis is built with maxRetriesPerRequest: null and an offline queue, so a
  // command issued while Redis is unreachable HANGS rather than rejecting. Left
  // unbounded, the once-a-minute probe would pile up stuck request handlers.
  it('gives up rather than hanging when redis never answers', async () => {
    vi.spyOn(ioRedis, 'get').mockReturnValue(new Promise(() => undefined) as any);
    await expect(hasEngageScanWork(org1)).resolves.toBe(false);
  });

  it('gives up rather than hanging when a mark never answers', async () => {
    vi.spyOn(ioRedis, 'set').mockReturnValue(new Promise(() => undefined) as any);
    await expect(markEngageScanWork(org1)).resolves.toBeUndefined();
  });

  it('swallows a redis failure when clearing', async () => {
    vi.spyOn(ioRedis, 'del').mockRejectedValue(new Error('redis down'));
    await expect(clearEngageScanWork(org1)).resolves.toBeUndefined();
  });
});

// A claim only proves "nothing was due as of when I looked". Retracting a hint
// raised while it was running would drop work it never saw — precisely the
// keyword this feature exists to catch.
describe('engage scan hint — token-guarded retraction', () => {
  let org1: string;
  beforeEach(() => {
    org1 = orgId();
  });

  it('retracts the hint it observed', async () => {
    await markEngageScanWork(org1);
    const token = await readEngageScanWork(org1);
    await clearEngageScanWork(org1, token);
    expect(await hasEngageScanWork(org1)).toBe(false);
  });

  it('keeps a hint raised after the observation', async () => {
    await markEngageScanWork(org1);
    const stale = await readEngageScanWork(org1);
    await markEngageScanWork(org1); // new work landed mid-claim
    await clearEngageScanWork(org1, stale);
    expect(await hasEngageScanWork(org1)).toBe(true);
  });

  it('keeps a hint raised when none was observed at all', async () => {
    await clearEngageScanWork(org1, null);
    await markEngageScanWork(org1);
    await clearEngageScanWork(org1, null);
    expect(await hasEngageScanWork(org1)).toBe(true);
  });

  it('issues distinct tokens for successive marks', async () => {
    await markEngageScanWork(org1);
    const first = await readEngageScanWork(org1);
    await markEngageScanWork(org1);
    expect(await readEngageScanWork(org1)).not.toBe(first);
  });

  it('retracts unconditionally when no token is supplied', async () => {
    await markEngageScanWork(org1);
    await clearEngageScanWork(org1);
    expect(await hasEngageScanWork(org1)).toBe(false);
  });
});

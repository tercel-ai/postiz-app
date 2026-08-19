/**
 * Unit tests for EngageHousekeepingActivity's opportunity-expiry sweep: the
 * durable, system-wide backstop that ages NEW opportunities out.
 *
 * Two properties matter here and are easy to regress:
 *  - the cutoff is PER PLATFORM (a dev.to article outlives an X post by weeks)
 *  - EITHER clock expires a row — how long this org has held it (createdAt) or
 *    how old the post itself is (postPublishedAt). Without the second, a post
 *    ingested just inside its window would live up to twice its TTL, which the
 *    ingest gate's postPublishedAt cutoff already forbids at write time.
 */
import { describe, it, expect, vi } from 'vitest';
import { EngageHousekeepingActivity } from '../engage-housekeeping.activity';

const DAY = 86_400_000;

function build(ttl: Record<string, number>) {
  const updateMany = vi.fn(async () => ({ count: 0 }));
  const activity = new EngageHousekeepingActivity(
    { model: { engageOpportunityState: { updateMany } } } as any,
    { getOpportunityTtlDaysMap: vi.fn(async () => ttl) } as any
  );
  return { activity, updateMany };
}

function callFor(updateMany: any, platform: string) {
  return updateMany.mock.calls.find(
    (c: any[]) => c[0].where.opportunity?.platform === platform
  )?.[0];
}

describe('EngageHousekeepingActivity — opportunity expiry', () => {
  it('sweeps each platform against its own cutoff', async () => {
    const { activity, updateMany } = build({ x: 3, devto: 30 });
    const before = Date.now();
    await activity.runDueMaintenanceJobs();
    const after = Date.now();

    const x = callFor(updateMany, 'x');
    const devto = callFor(updateMany, 'devto');
    expect(x.where.status).toBe('NEW');
    expect(x.data).toEqual({ status: 'EXPIRED' });

    const xCutoff = x.where.OR[0].createdAt.lt.getTime();
    expect(xCutoff).toBeGreaterThanOrEqual(before - 3 * DAY);
    expect(xCutoff).toBeLessThanOrEqual(after - 3 * DAY);
    expect(devto.where.OR[0].createdAt.lt.getTime()).toBeLessThan(xCutoff);
  });

  it('expires on EITHER createdAt or the post publish time', async () => {
    const { activity, updateMany } = build({ reddit: 7 });
    await activity.runDueMaintenanceJobs();
    const reddit = callFor(updateMany, 'reddit');
    expect(reddit.where.OR).toHaveLength(2);
    expect(reddit.where.OR[0]).toHaveProperty('createdAt.lt');
    expect(reddit.where.OR[1]).toHaveProperty('opportunity.postPublishedAt.lt');
    // Both branches share one cutoff — the gate and the sweep must not drift.
    expect(reddit.where.OR[0].createdAt.lt).toEqual(
      reddit.where.OR[1].opportunity.postPublishedAt.lt
    );
  });

  it('still sweeps rows whose platform is no longer scannable', async () => {
    // Retiring a platform from SCANNABLE_PLATFORMS must not strand its stored
    // opportunities in NEW forever now that the sweep runs per platform.
    const { activity, updateMany } = build({ x: 3 });
    await activity.runDueMaintenanceJobs();
    const catchAll = updateMany.mock.calls.find(
      (c: any[]) => c[0].where.opportunity?.platform?.notIn
    )?.[0];
    expect(catchAll).toBeDefined();
    expect(catchAll.where.opportunity.platform.notIn).toContain('x');
    expect(catchAll.data).toEqual({ status: 'EXPIRED' });
  });

  it('skips a platform with no configured TTL rather than expiring everything', async () => {
    const { activity, updateMany } = build({ x: 3 });
    await activity.runDueMaintenanceJobs();
    expect(callFor(updateMany, 'devto')).toBeUndefined();
  });
});

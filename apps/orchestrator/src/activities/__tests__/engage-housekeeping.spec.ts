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
  const postUpdateMany = vi.fn(async () => ({ count: 0 }));
  const activity = new EngageHousekeepingActivity(
    { model: { engageOpportunityState: { updateMany } } } as any,
    { model: { post: { updateMany: postUpdateMany } } } as any,
    { getOpportunityTtlDaysMap: vi.fn(async () => ttl) } as any
  );
  return { activity, updateMany, postUpdateMany };
}

/** The stale-queued-reply sweep's call for one platform. */
function replyCallFor(postUpdateMany: any, platform: string) {
  return postUpdateMany.mock.calls.find(
    (c: any[]) => c[0].where.engageSentReply?.is?.opportunity?.platform === platform
  )?.[0];
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

/**
 * The second sweep: engage replies stuck in QUEUE past their target's TTL.
 *
 * A queued reply has no expiry of its own — the opportunity sweep above only
 * touches `status: 'NEW'`, and drafting a reply moves that state to
 * AUTO_QUEUED. So a reply the extension can never post is re-offered every time
 * its lease expires, forever; production had one at six days.
 *
 * This is the LIFETIME bound. The DAMAGE bound is claimDueEngageReplies'
 * least-recently-attempted ordering, which stops such a row starving the queue
 * in the meantime. Both are needed: ordering alone never removes it, and this
 * alone would let it cost a send slot for days first.
 */
describe('EngageHousekeepingActivity — stale queued replies', () => {
  it('closes a queued reply past its platform’s TTL', async () => {
    const { activity, postUpdateMany } = build({ x: 3 });
    await activity.runDueMaintenanceJobs();

    const x = replyCallFor(postUpdateMany, 'x');
    expect(x.where.state).toBe('QUEUE');
    expect(x.data.state).toBe('ERROR');
    // The lease goes with it — nothing should hold a claim on a post that will
    // never be handed out again.
    expect(x.data.releaseId).toBeNull();
    expect(x.data.claimedAt).toBeNull();
  });

  it('reuses the SAME per-platform cutoff as the opportunity sweep', async () => {
    // Deliberately not a knob of its own: that number already answers "how long
    // is a post here still worth replying to", and a reply older than its
    // target's actionable window has nothing left to be sent into.
    const { activity, updateMany, postUpdateMany } = build({ x: 3, devto: 30 });
    await activity.runDueMaintenanceJobs();

    expect(replyCallFor(postUpdateMany, 'x').where.OR[0].createdAt.lt).toEqual(
      callFor(updateMany, 'x').where.OR[0].createdAt.lt
    );
    // And it is genuinely per platform, not one cutoff for everything.
    expect(
      replyCallFor(postUpdateMany, 'devto').where.OR[0].createdAt.lt.getTime()
    ).toBeLessThan(
      replyCallFor(postUpdateMany, 'x').where.OR[0].createdAt.lt.getTime()
    );
  });

  it('expires on EITHER the draft’s age or the target post’s', async () => {
    const { activity, postUpdateMany } = build({ reddit: 7 });
    await activity.runDueMaintenanceJobs();

    const reddit = replyCallFor(postUpdateMany, 'reddit');
    expect(reddit.where.OR).toHaveLength(2);
    expect(reddit.where.OR[0]).toHaveProperty('createdAt.lt');
    expect(reddit.where.OR[1]).toHaveProperty(
      'engageSentReply.is.opportunity.postPublishedAt.lt'
    );
  });

  it('never touches a post that is not an engage reply', async () => {
    // THE safety property. This sweeps the Post table, where a scheduled
    // publish also sits in QUEUE — matching one would silently kill a post the
    // user scheduled. Requiring the reply relation is what scopes it.
    const { activity, postUpdateMany } = build({ x: 3 });
    await activity.runDueMaintenanceJobs();

    for (const [args] of postUpdateMany.mock.calls) {
      expect(args.where.engageSentReply?.is).toBeDefined();
    }
  });

  it('never touches a reply that already went out', async () => {
    // A sent reply leaves QUEUE and gains a URL; either alone would do, both
    // together survive a half-written commit.
    const { activity, postUpdateMany } = build({ x: 3 });
    await activity.runDueMaintenanceJobs();

    const x = replyCallFor(postUpdateMany, 'x');
    expect(x.where.releaseURL).toBeNull();
    expect(x.where.deletedAt).toBeNull();
  });

  it('skips a platform with no configured TTL rather than closing everything', async () => {
    const { activity, postUpdateMany } = build({ x: 3 });
    await activity.runDueMaintenanceJobs();

    expect(replyCallFor(postUpdateMany, 'devto')).toBeUndefined();
  });

  it('runs even when the opportunity sweep throws', async () => {
    // runDueMaintenanceJobs uses allSettled precisely so one broken job cannot
    // silence the others — worth pinning, since these two now share a host.
    const { activity, postUpdateMany } = build({ x: 3 });
    (activity as any)._oppState.model.engageOpportunityState.updateMany =
      vi.fn(async () => {
        throw new Error('opportunity sweep exploded');
      });

    await activity.runDueMaintenanceJobs();

    expect(replyCallFor(postUpdateMany, 'x')).toBeDefined();
  });
});

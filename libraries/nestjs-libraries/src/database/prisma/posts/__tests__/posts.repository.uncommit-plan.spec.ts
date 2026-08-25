import { describe, expect, it, vi } from 'vitest';
import { PostsRepository } from '../posts.repository';

// The two halves of switching scheduled publishing off and back on:
//
//  - QUEUE -> DRAFT when a project switches the feature (or the master switch,
//    or a platform) off;
//  - reading the slots already taken, so the posts parked by that switch get
//    fresh times on the way back in rather than all going out at once.
//
// The repo is a thin Prisma wrapper, so these assert the query/write SHAPES —
// and every filter in them is a safety rule somebody can silently delete, which
// is why each has its own case.

function createRepo(model: Record<string, any>) {
  return new PostsRepository(
    { model: { post: model } } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
}

const leaseCutoff = new Date('2026-08-25T11:50:00Z');
const notBefore = new Date('2026-08-25T12:00:30Z');

describe('getUncommittablePlanPostRoots', () => {
  it('never touches an engage reply', async () => {
    // THE case this must not get wrong. An engage reply is a QUEUE Post too,
    // but on that side DRAFT means "a human's unsent draft, never auto-sent" —
    // so turning one into a DRAFT strands the reply forever AND drops it into
    // the user's review pile.
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    await repo.getUncommittablePlanPostRoots('org-1', 'proj-1', {
      leaseCutoff,
      notBefore,
    });

    const where = findMany.mock.calls[0][0].where;
    expect(where.source).toEqual({ not: 'engage' });
    // Belt and braces: a reply belongs to no operation plan either.
    expect(where.operationPlanId).toEqual({ not: null });
  });

  it('never touches a hand-scheduled post', async () => {
    // A post someone put on the calendar themselves is their instruction, not
    // automation's. A switch that unscheduled it would be taking away something
    // the user never delegated.
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    await repo.getUncommittablePlanPostRoots('org-1', 'proj-1', {
      leaseCutoff,
      notBefore,
    });

    expect(findMany.mock.calls[0][0].where.operationPlanId).toEqual({ not: null });
  });

  it('leaves a post that a browser is already publishing', async () => {
    // Claimed = handed to an extension instance. Reverting it would race the
    // backfill that is about to report it published.
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    await repo.getUncommittablePlanPostRoots('org-1', 'proj-1', {
      leaseCutoff,
      notBefore,
    });

    expect(findMany.mock.calls[0][0].where.OR).toEqual([
      { releaseId: null },
      { claimedAt: { lte: leaseCutoff } },
    ]);
  });

  it('leaves a post that is seconds from going out', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    await repo.getUncommittablePlanPostRoots('org-1', 'proj-1', {
      leaseCutoff,
      notBefore,
    });

    expect(findMany.mock.calls[0][0].where.publishDate).toEqual({ gt: notBefore });
  });

  it('takes only QUEUE roots, and never a recurring template', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    await repo.getUncommittablePlanPostRoots('org-1', 'proj-1', {
      leaseCutoff,
      notBefore,
    });

    const where = findMany.mock.calls[0][0].where;
    expect(where.state).toBe('QUEUE');
    expect(where.parentPostId).toBeNull(); // the group carries the thread
    expect(where.deletedAt).toBeNull();
    // A recurring original is a permanent QUEUE template owned by the
    // clone-per-cycle mechanism.
    expect(where.intervalInDays).toBeNull();
  });

  it('narrows to the named platforms when a platform was dropped', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    await repo.getUncommittablePlanPostRoots('org-1', 'proj-1', {
      leaseCutoff,
      notBefore,
      platforms: ['reddit'],
    });

    expect(findMany.mock.calls[0][0].where.providerIdentifier).toEqual({
      in: ['reddit'],
    });
  });

  it('does not constrain the platform when the whole feature went off', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    await repo.getUncommittablePlanPostRoots('org-1', 'proj-1', {
      leaseCutoff,
      notBefore,
    });

    expect(findMany.mock.calls[0][0].where).not.toHaveProperty(
      'providerIdentifier'
    );
  });
});

describe('revertPlanGroupsToDraft', () => {
  it('writes DRAFT and leaves publishDate alone', async () => {
    // The draft keeps the slot the plan gave it, so switching back on
    // re-commits the same schedule instead of inventing a new one.
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const repo = createRepo({ updateMany });

    await repo.revertPlanGroupsToDraft('org-1', ['g1'], { leaseCutoff, notBefore });

    const call = updateMany.mock.calls[0][0];
    expect(call.data).toEqual({ state: 'DRAFT' });
    expect(call.data).not.toHaveProperty('publishDate');
  });

  it('repeats every safety filter at write time', async () => {
    // The read and the write are separate statements: in between, a post can be
    // claimed or published, so trusting the read would reintroduce the race.
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const repo = createRepo({ updateMany });

    await repo.revertPlanGroupsToDraft('org-1', ['g1', 'g2'], {
      leaseCutoff,
      notBefore,
    });

    const where = updateMany.mock.calls[0][0].where;
    expect(where.group).toEqual({ in: ['g1', 'g2'] });
    expect(where.state).toBe('QUEUE');
    expect(where.source).toEqual({ not: 'engage' });
    expect(where.operationPlanId).toEqual({ not: null });
    expect(where.intervalInDays).toBeNull();
    expect(where.publishDate).toEqual({ gt: notBefore });
    expect(where.OR).toEqual([
      { releaseId: null },
      { claimedAt: { lte: leaseCutoff } },
    ]);
  });

  it('makes no query at all for an empty group list', async () => {
    const updateMany = vi.fn();
    const repo = createRepo({ updateMany });

    expect(await repo.revertPlanGroupsToDraft('org-1', [], { leaseCutoff, notBefore }))
      .toEqual({ count: 0 });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('getFuturePublishDates', () => {
  it('counts hand-scheduled and other plans’ posts as taken slots', async () => {
    // The minimum gap belongs to the PLATFORM's timeline, not to one plan. A
    // deferred post that only avoided its own plan's posts would still land on
    // top of something a person scheduled by hand.
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    await repo.getFuturePublishDates('org-1', 'proj-1', 'reddit', notBefore);

    const where = findMany.mock.calls[0][0].where;
    // Deliberately NOT scoped to operationPlanId — that is the whole point.
    expect(where).not.toHaveProperty('operationPlanId');
    expect(where.projectId).toBe('proj-1');
    expect(where.providerIdentifier).toBe('reddit');
  });

  it('looks at both drafts and queued posts', async () => {
    // A draft about to be committed occupies its slot just as much as a queued
    // post: the same commit may be placing posts around it.
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    await repo.getFuturePublishDates('org-1', 'proj-1', 'reddit', notBefore);

    expect(findMany.mock.calls[0][0].where.state).toEqual({
      in: ['DRAFT', 'QUEUE'],
    });
  });

  it('ignores engage replies and thread segments', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    await repo.getFuturePublishDates('org-1', 'proj-1', 'reddit', notBefore);

    const where = findMany.mock.calls[0][0].where;
    // A reply is sent on its own cadence by a different driver.
    expect(where.source).toEqual({ not: 'engage' });
    // A thread takes ONE slot; counting each segment would inflate the timeline.
    expect(where.parentPostId).toBeNull();
    expect(where.deletedAt).toBeNull();
  });

  it('only looks forward', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    await repo.getFuturePublishDates('org-1', 'proj-1', 'reddit', notBefore);

    expect(findMany.mock.calls[0][0].where.publishDate).toEqual({ gt: notBefore });
  });
});

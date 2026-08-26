import { describe, it, expect, vi } from 'vitest';
import { EngageRepository } from '../engage.repository';

// Claiming queued engage replies — deliberately the same lease the publish path
// uses (`claimDueExtensionPublishPosts`), on the same two Post columns.
//
// Two properties carry the weight. It must never hand one reply to two clients:
// that is a comment posted twice, which has happened in production. And it must
// never touch a DRAFT: that belongs to a person who has not pressed send.
function buildRepo(opts: { candidates?: any[]; won?: any[] } = {}) {
  const sentFindMany = vi
    .fn()
    .mockResolvedValueOnce(opts.candidates ?? [])
    .mockResolvedValueOnce(opts.won ?? []);
  const postUpdateMany = vi.fn(async () => ({ count: 1 }));
  const _sentReply = { model: { engageSentReply: { findMany: sentFindMany } } } as any;
  const _post = { model: { post: { updateMany: postUpdateMany } } } as any;
  const repo = new EngageRepository(
    {} as any, {} as any, {} as any, {} as any, {} as any, _sentReply,
    {} as any, {} as any, _post, {} as any, {} as any, {} as any
  );
  return { repo, sentFindMany, postUpdateMany };
}

const now = new Date('2026-08-21T12:00:00Z');
const leaseCutoff = new Date('2026-08-21T11:30:00Z');
const opts = { limit: 5, leaseToken: 'claim_abc', leaseCutoff, now };

const wonRow = {
  id: 'sent-1',
  projectId: 'proj-1',
  opportunity: {
    id: 'opp-1',
    platform: 'reddit',
    externalPostUrl: 'https://reddit.com/r/x/comments/1',
  },
  post: { content: 'a reply waiting to go out' },
};

describe('EngageRepository.claimDueEngageReplies — what it will not pick up', () => {
  it('only ever considers QUEUE replies, never a human’s DRAFT', async () => {
    // THE safety property. save-draft writes DRAFT and the driver writes QUEUE;
    // nothing else distinguishes them, and both produce an EngageSentReply over
    // a Post. A DRAFT is someone's unsent work — claiming it would publish
    // something they were still deciding about.
    const { repo, sentFindMany } = buildRepo();

    await repo.claimDueEngageReplies('org-1', 'proj-1', 'reddit', opts);

    expect(sentFindMany.mock.calls[0][0].where.post.state).toBe('QUEUE');
  });

  it('skips a reply whose lease is still running', async () => {
    // A reply claimed moments ago may be posting right now; re-offering it is
    // how the same comment goes out twice.
    const { repo, sentFindMany } = buildRepo();

    await repo.claimDueEngageReplies('org-1', 'proj-1', 'reddit', opts);

    expect(sentFindMany.mock.calls[0][0].where.post.OR).toEqual([
      { releaseId: null },
      { claimedAt: { lte: leaseCutoff } },
    ]);
  });

  it('skips a reply that already went out', async () => {
    const { repo, sentFindMany } = buildRepo();

    await repo.claimDueEngageReplies('org-1', 'proj-1', 'reddit', opts);

    // A sent reply leaves QUEUE and gains a URL; either alone would do, both
    // together survive a half-written commit.
    const post = sentFindMany.mock.calls[0][0].where.post;
    expect(post.releaseURL).toBeNull();
    expect(post.deletedAt).toBeNull();
  });

  it('does no work at all when asked for nothing', async () => {
    const { repo, sentFindMany } = buildRepo();

    expect(
      await repo.claimDueEngageReplies('org-1', 'proj-1', 'reddit', { ...opts, limit: 0 })
    ).toEqual([]);
    expect(sentFindMany).not.toHaveBeenCalled();
  });

  it('scopes to the org, the project, and the platform being drained', async () => {
    const { repo, sentFindMany } = buildRepo();

    await repo.claimDueEngageReplies('org-1', 'proj-1', 'reddit', opts);

    const where = sentFindMany.mock.calls[0][0].where;
    expect(where.organizationId).toBe('org-1');
    // Scoped to ONE project: the caller's local-time window and minimum gap are
    // per (project, platform), so a claim spanning projects would be answering
    // for gates it never checked.
    expect(where.projectId).toBe('proj-1');
    expect(where.opportunity).toMatchObject({ platform: 'reddit' });
  });

  it('will not re-offer a reply whose target has no address', async () => {
    const { repo, sentFindMany } = buildRepo();

    await repo.claimDueEngageReplies('org-1', 'proj-1', 'reddit', opts);

    // Claiming one of these succeeds, the poster then fails for want of a URL,
    // and the record stays QUEUE — so the next lease cycle offers it again,
    // forever. Excluded from the claim itself, not left to the executor.
    expect(sentFindMany.mock.calls[0][0].where.opportunity.externalPostUrl).toEqual({
      not: '',
    });
  });
});

describe('EngageRepository.claimDueEngageReplies — winning the race', () => {
  it('re-asserts availability at write time', async () => {
    // Between the read and the write another puller may have taken the row. The
    // guard makes our update a no-op there, so the database decides the winner.
    const { repo, postUpdateMany } = buildRepo({ candidates: [{ postId: 'p1' }] });

    await repo.claimDueEngageReplies('org-1', 'proj-1', 'reddit', opts);

    expect(postUpdateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['p1'] },
        state: 'QUEUE',
        OR: [{ releaseId: null }, { claimedAt: { lte: leaseCutoff } }],
      },
      data: { releaseId: 'claim_abc', claimedAt: now },
    });
  });

  it('returns only the rows carrying OUR lease token', async () => {
    // The read-back is what separates the rows we won from the ones a racing
    // puller stamped first — returning a candidate we lost is the double-send.
    const { repo, sentFindMany } = buildRepo({
      candidates: [{ postId: 'p1' }],
      won: [wonRow],
    });

    await repo.claimDueEngageReplies('org-1', 'proj-1', 'reddit', opts);

    expect(sentFindMany.mock.calls[1][0].where.post).toEqual({
      releaseId: 'claim_abc',
    });
  });

  it('returns the stored text — nothing is regenerated', async () => {
    const { repo } = buildRepo({ candidates: [{ postId: 'p1' }], won: [wonRow] });

    const claimed = await repo.claimDueEngageReplies('org-1', 'proj-1', 'reddit', opts);

    expect(claimed).toEqual([
      {
        id: 'sent-1',
        projectId: 'proj-1',
        opportunityId: 'opp-1',
        platform: 'reddit',
        url: 'https://reddit.com/r/x/comments/1',
        content: 'a reply waiting to go out',
      },
    ]);
  });

  it('stops before the write when nothing is available', async () => {
    const { repo, postUpdateMany } = buildRepo({ candidates: [] });

    expect(await repo.claimDueEngageReplies('org-1', 'proj-1', 'reddit', opts)).toEqual([]);
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it('takes the longest-waiting replies first', async () => {
    const { repo, sentFindMany } = buildRepo();

    await repo.claimDueEngageReplies('org-1', 'proj-1', 'reddit', opts);

    expect(sentFindMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'asc' });
    expect(sentFindMany.mock.calls[0][0].take).toBe(5);
  });
});

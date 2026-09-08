import { describe, it, expect, vi } from 'vitest';
import {
  EngageRepository,
  REPLIES_DISABLED_ERROR_PREFIX,
} from '../engage.repository';

// The UNDO of a "replies disabled" verdict.
//
// The verdict itself is written on the word of a browser extension's platform
// detector, globally, for every tenant that scanned the same post. Six of the
// seven detectors are newly written, so a false positive is a question of when
// rather than if — and until this endpoint existed, the only correction was a
// hand-written UPDATE against production.
//
// Two properties carry the weight. Clearing the stamp alone restores almost
// nothing (the draft picker skips an opportunity the org already has a reply
// row for), so the replies that verdict closed must be reopened with it. And
// reopening must reach ONLY those replies: a reply that failed for its own
// reasons, or one that actually went out, must stay closed.
function buildRepo(opts: { parked?: { postId: string }[] } = {}) {
  const sentFindMany = vi.fn(async () => opts.parked ?? []);
  const oppUpdateMany = vi.fn(async () => ({ count: 1 }));
  const postUpdateMany = vi.fn(async (args: any) => ({
    count: Array.isArray(args?.where?.id?.in) ? args.where.id.in.length : 0,
  }));

  const _sentReply = {
    model: { engageSentReply: { findMany: sentFindMany } },
  } as any;
  const _tx = {
    model: {
      $transaction: (fn: any) =>
        fn({
          engageOpportunity: { updateMany: oppUpdateMany },
          post: { updateMany: postUpdateMany },
        }),
    },
  } as any;

  const repo = new EngageRepository(
    {} as any, {} as any, {} as any, {} as any, {} as any, _sentReply,
    {} as any, {} as any, {} as any, _tx, {} as any, {} as any, {} as any
  );
  return { repo, sentFindMany, oppUpdateMany, postUpdateMany };
}

describe('EngageRepository.restoreOpportunityRepliesForAdmin', () => {
  it('clears the stamp and reopens the replies that verdict closed', async () => {
    const { repo, oppUpdateMany, postUpdateMany } = buildRepo({
      parked: [{ postId: 'p1' }, { postId: 'p2' }],
    });

    const res = await repo.restoreOpportunityRepliesForAdmin(['opp-1']);

    expect(res).toEqual({ restored: 1, repliesReopened: 2 });
    expect(oppUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['opp-1'] }, repliesDisabledAt: { not: null } },
      data: { repliesDisabledAt: null },
    });
    // ERROR → QUEUE, or the row goes back into circulation while the reply that
    // was closed against it stays dead — a half-undo nobody can see.
    const reopened = postUpdateMany.mock.calls[0][0];
    expect(reopened.data).toEqual({ state: 'QUEUE', error: null });
  });

  it('reopens ONLY replies closed by this verdict, and only unsent ones', async () => {
    // The blast-radius guard. Every clause here excludes a reply that must stay
    // closed: one that failed for its own reason (error prefix), one that
    // actually went out (releaseURL), one already retired (deletedAt), one that
    // is not in ERROR at all.
    const { repo, postUpdateMany } = buildRepo({ parked: [{ postId: 'p1' }] });

    await repo.restoreOpportunityRepliesForAdmin(['opp-1']);

    expect(postUpdateMany.mock.calls[0][0].where).toEqual({
      id: { in: ['p1'] },
      state: 'ERROR',
      deletedAt: null,
      releaseURL: null,
      error: { startsWith: REPLIES_DISABLED_ERROR_PREFIX },
    });
  });

  it('matches the prefix markOpportunityRepliesDisabled actually writes', async () => {
    // The write and its undo agree on the marker only because they share the
    // constant. Pinned by running both: a renamed message that skipped the undo
    // would leave every reply closed with no way back short of SQL.
    const { repo, postUpdateMany } = buildRepo({ parked: [{ postId: 'p1' }] });

    await repo.markOpportunityRepliesDisabled(
      'org-1',
      'opp-1',
      'the thread is locked'
    );
    const closedWith = postUpdateMany.mock.calls[0][0].data.error;

    await repo.restoreOpportunityRepliesForAdmin(['opp-1']);
    const { startsWith } = postUpdateMany.mock.calls[1][0].where.error;

    expect(closedWith.startsWith(startsWith)).toBe(true);
  });

  it('reports an unstamped row as untouched rather than rewriting it', async () => {
    // `repliesDisabledAt: { not: null }` in the where. Re-running a batch is an
    // operator's first instinct after a partial failure, so `restored` has to
    // mean "rows this call actually reopened".
    const { repo, oppUpdateMany } = buildRepo({ parked: [] });
    oppUpdateMany.mockResolvedValueOnce({ count: 0 });

    expect(await repo.restoreOpportunityRepliesForAdmin(['opp-1'])).toEqual({
      restored: 0,
      repliesReopened: 0,
    });
  });

  it('clears the stamp even when no reply is parked against the row', async () => {
    // The opportunity may have been closed before anyone drafted against it —
    // pickAutoReplyCandidates filters on the column too, so the stamp blocks
    // drafting as well as sending. Nothing to reopen is not nothing to do.
    const { repo, postUpdateMany } = buildRepo({ parked: [] });

    const res = await repo.restoreOpportunityRepliesForAdmin(['opp-1']);

    expect(res).toEqual({ restored: 1, repliesReopened: 0 });
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it('touches nothing for an empty id list', async () => {
    const { repo, sentFindMany, oppUpdateMany } = buildRepo();

    expect(await repo.restoreOpportunityRepliesForAdmin([])).toEqual({
      restored: 0,
      repliesReopened: 0,
    });
    expect(sentFindMany).not.toHaveBeenCalled();
    expect(oppUpdateMany).not.toHaveBeenCalled();
  });

  it('never writes deletedAt — the post stays on the feed either way', async () => {
    // Mirrors the guard on the write it undoes. The whole reason this column
    // exists instead of deletedAt is that a wrong verdict leaves the post
    // visible; the correction must not quietly change that.
    const { repo, oppUpdateMany, postUpdateMany } = buildRepo({
      parked: [{ postId: 'p1' }],
    });

    await repo.restoreOpportunityRepliesForAdmin(['opp-1']);

    for (const call of oppUpdateMany.mock.calls) {
      expect(call[0].data).not.toHaveProperty('deletedAt');
    }
    for (const call of postUpdateMany.mock.calls) {
      expect(call[0].data).not.toHaveProperty('deletedAt');
    }
  });
});

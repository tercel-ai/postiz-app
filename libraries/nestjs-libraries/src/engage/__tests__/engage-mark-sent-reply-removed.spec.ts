import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { EngageRepository } from '../engage.repository';

// markSentReplyRemoved is the commit-time ALTERNATIVE to publishExtensionReply:
// the extension posted successfully, a logged-out check found the platform had
// removed it seconds later, and this records that fact instead of charging and
// claiming for a reply nobody can read.
//
// Three writes, each pinned here because each has a specific reason NOT to be
// the obvious alternative (see the method's own doc comment): Post stays
// PUBLISHED (not ERROR/DRAFT), removedAt/removedReason lands on the reply
// itself, and the opportunity is DISMISSED (not left NEW, not marked REPLIED).
function buildRepo(opts: { reply?: any } = {}) {
  const sentFindFirst = vi.fn(async () =>
    'reply' in opts
      ? opts.reply
      : { id: 'r1', postId: 'p1', opportunityId: 'o1', projectId: 'proj-1' }
  );
  const sentUpdate = vi.fn(async () => ({}));
  const postUpdate = vi.fn(async () => ({}));
  const oppUpdateMany = vi.fn(async () => ({ count: 1 }));

  const _sentReply = {
    model: {
      engageSentReply: { findFirst: sentFindFirst, update: sentUpdate },
    },
  } as any;
  const _post = { model: { post: { update: postUpdate } } } as any;
  const _oppState = {
    model: { engageOpportunityState: { updateMany: oppUpdateMany } },
  } as any;

  const repo = new EngageRepository(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    _oppState,
    _sentReply,
    {} as any,
    {} as any,
    _post,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  return { repo, sentFindFirst, sentUpdate, postUpdate, oppUpdateMany };
}

describe('EngageRepository.markSentReplyRemoved', () => {
  it('throws NotFoundException for a reply that does not belong to this org', async () => {
    // findFirst is scoped `{ id, organizationId }` — a cross-org id looks
    // exactly like a nonexistent one, and must be refused the same way.
    const { repo, sentUpdate, postUpdate, oppUpdateMany } = buildRepo({
      reply: null,
    });

    await expect(
      repo.markSentReplyRemoved('org-1', 'r1', 'removed', null)
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sentUpdate).not.toHaveBeenCalled();
    expect(postUpdate).not.toHaveBeenCalled();
    expect(oppUpdateMany).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the caller’s own organization', async () => {
    const { repo, sentFindFirst } = buildRepo();

    await repo.markSentReplyRemoved('org-1', 'r1', 'removed', null);

    expect(sentFindFirst.mock.calls[0][0].where).toEqual({
      id: 'r1',
      organizationId: 'org-1',
    });
  });

  it('records removedAt and removedReason on the reply', async () => {
    const { repo, sentUpdate } = buildRepo();

    await repo.markSentReplyRemoved('org-1', 'r1', 'gone', null);

    expect(sentUpdate).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { removedAt: expect.any(Date), removedReason: 'gone' },
    });
  });

  it('keeps the Post PUBLISHED rather than ERROR or DRAFT', async () => {
    // The reply really was published; the platform's removal is a later,
    // separate fact. ERROR would open the retryPost door (re-sending content
    // that was just removed) and null out releaseId; DRAFT would read as
    // "never sent" and invite a duplicate.
    const { repo, postUpdate } = buildRepo();

    await repo.markSentReplyRemoved('org-1', 'r1', 'removed', null);

    expect(postUpdate).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { state: 'PUBLISHED' },
    });
  });

  it('sets releaseURL when the extension captured one', async () => {
    const { repo, postUpdate } = buildRepo();

    await repo.markSentReplyRemoved(
      'org-1',
      'r1',
      'removed',
      'https://www.reddit.com/r/test/comments/a/b/c1/'
    );

    expect(postUpdate).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: {
        state: 'PUBLISHED',
        releaseURL: 'https://www.reddit.com/r/test/comments/a/b/c1/',
      },
    });
  });

  it('never overwrites a stored releaseURL with an empty one', async () => {
    // Falsy inputs (null, undefined, '') must all take the "omit" branch —
    // only a real url is worth writing.
    const { repo, postUpdate } = buildRepo();

    await repo.markSentReplyRemoved('org-1', 'r1', 'removed', '');

    expect(postUpdate).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { state: 'PUBLISHED' },
    });
  });

  it('dismisses the opportunity so it is not offered again', async () => {
    // Not left NEW (would re-offer the same post into the same rule that just
    // removed us) and not REPLIED (asserts a reply is standing there, which is
    // exactly what this path exists to correct).
    const { repo, oppUpdateMany } = buildRepo();

    await repo.markSentReplyRemoved('org-1', 'r1', 'removed', null);

    expect(oppUpdateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', projectId: 'proj-1', opportunityId: 'o1' },
      data: { status: 'DISMISSED' },
    });
  });

  it('scopes the dismissal to the null-project row when the reply has none', async () => {
    // Same nullable-projectId convention as dismissOpportunity elsewhere in
    // this file — a bare `undefined` would target a different row (or none)
    // than Prisma's explicit `null`.
    const { repo, oppUpdateMany } = buildRepo({
      reply: { id: 'r1', postId: 'p1', opportunityId: 'o1', projectId: null },
    });

    await repo.markSentReplyRemoved('org-1', 'r1', 'removed', null);

    expect(oppUpdateMany.mock.calls[0][0].where.projectId).toBeNull();
  });

  it('returns the removal outcome', async () => {
    const { repo } = buildRepo();

    const result = await repo.markSentReplyRemoved(
      'org-1',
      'r1',
      'gone',
      null
    );

    expect(result).toEqual({ id: 'r1', removed: true, reason: 'gone' });
  });

  it('does not charge or claim: no overage/claim call exists on this path', async () => {
    // Structural check rather than a behavioural one — the method has no
    // dependency capable of billing (no PostOverageService, no credit calls),
    // so there is nothing here that COULD charge. Written down because that
    // absence is the entire point of this being a separate method from
    // publishExtensionReply rather than a flag on it.
    const { repo, sentUpdate, postUpdate, oppUpdateMany } = buildRepo();

    await repo.markSentReplyRemoved('org-1', 'r1', 'removed', null);

    expect(sentUpdate).toHaveBeenCalledTimes(1);
    expect(postUpdate).toHaveBeenCalledTimes(1);
    expect(oppUpdateMany).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { EngageRepository } from '../engage.repository';

// The clock the PLATFORM write floor paces against — the one that closed the
// cross-track hole (a queued Hacker News story going out seconds after an engage
// reply, which HN answered with "You're posting too fast").
//
// Two things make it different from getLastSentReplyAt, and both are load-bearing:
//
//   1. It is ORG-wide, not project-scoped. A project is our concept; the
//      throttle belongs to the platform account, and two projects publishing to
//      one login share it.
//   2. It counts only moments the account was actually TOUCHED. Creating a draft
//      is an LLM call and a row insert — a human draft parked in Awaiting Review
//      may never be sent at all.

const REPLY_CLAIMED = new Date('2026-08-27T12:00:00Z');
const POST_CLAIMED = new Date('2026-08-27T12:30:00Z');

function buildRepo() {
  const replyFindFirst = vi.fn();
  const postFindFirst = vi.fn();
  const _sentReply = {
    model: { engageSentReply: { findFirst: replyFindFirst } },
  } as any;
  const _post = { model: { post: { findFirst: postFindFirst } } } as any;
  const repo = new EngageRepository(
    {} as any, {} as any, {} as any, {} as any, {} as any, _sentReply,
    {} as any, {} as any, _post, {} as any, {} as any, {} as any, {} as any
  );
  return { repo, replyFindFirst, postFindFirst };
}

describe('getLastPlatformWriteAt', () => {
  it('takes the later of the reply hand-out and the post hand-out', async () => {
    const { repo, replyFindFirst, postFindFirst } = buildRepo();
    replyFindFirst.mockResolvedValue({ post: { claimedAt: REPLY_CLAIMED } });
    postFindFirst.mockResolvedValue({ claimedAt: POST_CLAIMED });

    expect(await repo.getLastPlatformWriteAt('org-1', 'hackernews')).toEqual(
      POST_CLAIMED
    );
  });

  it('returns whichever side exists when the other has nothing', async () => {
    const { repo, replyFindFirst, postFindFirst } = buildRepo();
    replyFindFirst.mockResolvedValue({ post: { claimedAt: REPLY_CLAIMED } });
    postFindFirst.mockResolvedValue(null);
    expect(await repo.getLastPlatformWriteAt('org-1', 'x')).toEqual(REPLY_CLAIMED);

    replyFindFirst.mockResolvedValue(null);
    postFindFirst.mockResolvedValue({ claimedAt: POST_CLAIMED });
    expect(await repo.getLastPlatformWriteAt('org-1', 'x')).toEqual(POST_CLAIMED);
  });

  it('returns null when this platform has never been written to', async () => {
    const { repo, replyFindFirst, postFindFirst } = buildRepo();
    replyFindFirst.mockResolvedValue(null);
    postFindFirst.mockResolvedValue(null);
    expect(await repo.getLastPlatformWriteAt('org-1', 'reddit')).toBeNull();
  });

  it('counts a reply only once the extension CLAIMED it, never at draft time', async () => {
    // Otherwise one person generating drafts in Awaiting Review holds back every
    // project's replies on that platform for a full floor.
    const { repo, replyFindFirst } = buildRepo();
    replyFindFirst.mockResolvedValue(null);
    await repo.getLastPlatformWriteAt('org-1', 'reddit');

    const where = replyFindFirst.mock.calls[0][0].where;
    expect(where.post).toEqual({ claimedAt: { not: null } });
    expect(replyFindFirst.mock.calls[0][0].orderBy).toEqual({
      post: { claimedAt: 'desc' },
    });
  });

  it('EXCLUDES engage posts from the post lookup — they are stored under the wrong platform', async () => {
    // upsertDraft writes `providerIdentifier: platform === 'x' ? 'x' : 'reddit'`
    // for EVERY platform, so a hackernews reply is persisted as a reddit row.
    // Matching on that column without the filter counted an HN reply as a reddit
    // write and starved the org's reddit replies for a full floor. Engage rows
    // are already covered by the reply lookup, keyed on the TRUE platform.
    const { repo, postFindFirst } = buildRepo();
    postFindFirst.mockResolvedValue(null);
    await repo.getLastPlatformWriteAt('org-1', 'reddit');

    expect(postFindFirst.mock.calls[0][0].where.source).toEqual({ not: 'engage' });
  });

  it('matches a legacy post through its bound integration', async () => {
    // getDuePublishPosts resolves a post's platform as
    // `providerIdentifier || integration.providerIdentifier || settings.__type`.
    // A legacy row with a null column IS published by the extension, so a lookup
    // keyed on the column alone leaves the floor unapplied to it.
    const { repo, postFindFirst } = buildRepo();
    postFindFirst.mockResolvedValue(null);
    await repo.getLastPlatformWriteAt('org-1', 'linkedin');

    expect(postFindFirst.mock.calls[0][0].where.OR).toEqual([
      { providerIdentifier: 'linkedin' },
      { providerIdentifier: null, integration: { providerIdentifier: 'linkedin' } },
    ]);
  });

  it('scopes every lookup to the org and nothing narrower', async () => {
    const { repo, replyFindFirst, postFindFirst } = buildRepo();
    replyFindFirst.mockResolvedValue(null);
    postFindFirst.mockResolvedValue(null);
    await repo.getLastPlatformWriteAt('org-1', 'x');

    // Org-scoped: no cross-tenant read.
    expect(replyFindFirst.mock.calls[0][0].where.organizationId).toBe('org-1');
    expect(postFindFirst.mock.calls[0][0].where.organizationId).toBe('org-1');
    // NOT project-scoped: the throttle belongs to the account, and scoping it by
    // project would let N projects each spend the full floor.
    expect(replyFindFirst.mock.calls[0][0].where.projectId).toBeUndefined();
    expect(postFindFirst.mock.calls[0][0].where.projectId).toBeUndefined();
    // Soft-deleted posts are not writes.
    expect(postFindFirst.mock.calls[0][0].where.deletedAt).toBeNull();
  });
});

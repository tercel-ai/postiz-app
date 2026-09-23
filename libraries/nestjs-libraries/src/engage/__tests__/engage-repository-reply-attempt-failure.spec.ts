import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { EngageRepository } from '../engage.repository';

// Recording WHY a send attempt did not go out, without closing the row.
//
// The distinction this file exists to hold: a reply that failed is not the same
// as a reply that must never be sent again. `closeUnconfirmedReply` is for the
// second (the send FIRED and could not be confirmed, so re-sending risks a
// duplicate comment) and moves the row to ERROR. `recordReplyAttemptFailure` is
// for the first — signed out, network, rate limited, the browser busy with
// another platform write — where nothing reached the platform.
//
// Why `state` must stay untouched there: `claimDueEngageReplies` requires
// `post.state: 'QUEUE'`, so an ERROR row is never handed out again. Closing a
// QUEUE row on a transient failure would permanently kill the unattended retry,
// which is exactly what `logRetryableFailure` — the only thing this path used
// to call — exists not to do. And a DRAFT row has no automatic retry at all, so
// closing it would only move it out of the user's Drafts and claim it is over.
//
// So the assertion that `data` carries NO `state` is not pedantry about a
// field: it is the whole safety property, and the first thing a well-meaning
// "mark it failed" refactor would take away.
function buildRepo(opts: { reply?: any; updated?: number } = {}) {
  const sentFindFirst = vi.fn(async () =>
    'reply' in opts ? opts.reply : { id: 'r1', postId: 'p1' }
  );
  // Answers like Prisma would: a where-clause that matches nothing updates
  // nothing. The default matches, and `updated: 0` models the row having left
  // DRAFT/QUEUE (committed, or already closed) before this write landed.
  const postUpdateMany = vi.fn(async () => ({ count: opts.updated ?? 1 }));
  const postUpdate = vi.fn(async (args: any) => args);

  const _sentReply = {
    model: { engageSentReply: { findFirst: sentFindFirst, findMany: vi.fn() } },
  } as any;
  const _post = {
    model: { post: { updateMany: postUpdateMany, update: postUpdate } },
  } as any;

  const repo = new EngageRepository(
    {} as any, {} as any, {} as any, {} as any, {} as any, _sentReply,
    {} as any, {} as any, _post, {} as any, {} as any, {} as any, {} as any
  );
  return { repo, sentFindFirst, postUpdateMany };
}

describe('EngageRepository.recordReplyAttemptFailure — the row stays sendable', () => {
  it('writes the reason and NOTHING else — never a state', async () => {
    const { repo, postUpdateMany } = buildRepo();

    await repo.recordReplyAttemptFailure('org-1', 'r1', 'not signed in to reddit');

    const call = postUpdateMany.mock.calls[0][0];
    expect(call.data).toEqual({ error: 'not signed in to reddit' });
    // Spelled out separately from the toEqual above: this is the property, and
    // a failure here should read as "the retry path was broken", not as "an
    // object shape changed".
    expect(call.data).not.toHaveProperty('state');
    expect(call.data).not.toHaveProperty('releaseId');
  });

  it('only touches a row that can still be sent', async () => {
    // PUBLISHED: the send succeeded, and a late failure report must not stamp a
    // failure onto a live reply. ERROR: the row is closed and its `error`
    // already explains what closed it.
    const { repo, postUpdateMany } = buildRepo();

    await repo.recordReplyAttemptFailure('org-1', 'r1', 'network');

    expect(postUpdateMany.mock.calls[0][0].where).toEqual({
      id: 'p1',
      state: { in: ['DRAFT', 'QUEUE'] },
    });
  });

  it('reports recorded: false when the row had already moved on', async () => {
    const { repo } = buildRepo({ updated: 0 });

    await expect(
      repo.recordReplyAttemptFailure('org-1', 'r1', 'network')
    ).resolves.toEqual({ recorded: false });
  });

  it('truncates a runaway reason the way closeUnconfirmedReply does', async () => {
    const { repo, postUpdateMany } = buildRepo();

    await repo.recordReplyAttemptFailure('org-1', 'r1', 'x'.repeat(1000));

    expect(postUpdateMany.mock.calls[0][0].data.error).toHaveLength(400);
  });
});

describe('EngageRepository.recordReplyAttemptFailure — authorisation', () => {
  it('scopes the lookup to the calling org', async () => {
    const { repo, sentFindFirst } = buildRepo();

    await repo.recordReplyAttemptFailure('org-1', 'r1', 'network');

    expect(sentFindFirst.mock.calls[0][0].where).toEqual({
      id: 'r1',
      organizationId: 'org-1',
    });
  });

  it('refuses an id that is not this org’s, without writing', async () => {
    const { repo, postUpdateMany } = buildRepo({ reply: null });

    await expect(
      repo.recordReplyAttemptFailure('org-2', 'r1', 'network')
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(postUpdateMany).not.toHaveBeenCalled();
  });
});

// The other half of the contract: a reason recorded on an open row must not
// outlive the attempt it describes. Nothing else clears it, so a commit that
// forgot to would leave a published reply permanently captioned "last attempt
// failed: not signed in" — a row arguing with itself, which is worse than the
// silence this whole feature set out to fix.
function buildCommitRepo() {
  const sentFindFirst = vi.fn().mockResolvedValue({
    id: 'reply-1',
    postId: 'post-1',
    opportunityId: 'opp-1',
    projectId: null,
    opportunity: { platform: 'reddit' },
  });
  const postFindUnique = vi.fn().mockResolvedValue({
    integrationId: 'int-1',
    settings: JSON.stringify({ __type: 'reddit' }),
  });
  const postUpdate = vi.fn().mockResolvedValue({ id: 'post-1' });

  const repo = new EngageRepository(
    {} as any, // _config
    {} as any, // _keyword
    {} as any, // _trackedAccount
    {} as any, // _opportunity
    {
      model: {
        engageOpportunityState: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      },
    } as any,
    {
      model: {
        engageSentReply: {
          findFirst: sentFindFirst,
          update: vi.fn().mockResolvedValue({ id: 'reply-1' }),
        },
      },
    } as any,
    { model: { integration: { findMany: vi.fn().mockResolvedValue([]) } } } as any,
    {} as any, // _integrationProject
    { model: { post: { findUnique: postFindUnique, update: postUpdate } } } as any,
    {} as any, // _tx
    {} as any, // _scanCursor
    {} as any,
    {} as any
  );
  return { repo, postUpdate };
}

describe('updateReplyUrl — a successful commit clears the attempt reason', () => {
  it('clears it on the extension publish commit', async () => {
    const { repo, postUpdate } = buildCommitRepo();

    await repo.updateReplyUrl(
      'org-1',
      'reply-1',
      'https://www.reddit.com/r/t/comments/a/b/',
      undefined,
      { markPublished: true }
    );

    expect(postUpdate.mock.calls[0][0].data.error).toBeNull();
  });

  it('clears it on a URL-less confirm — the reply is live either way', async () => {
    const { repo, postUpdate } = buildCommitRepo();

    await repo.updateReplyUrl('org-1', 'reply-1', null, undefined, {
      markPublished: true,
    });

    expect(postUpdate.mock.calls[0][0].data.error).toBeNull();
  });

  it('clears it on the human paste-the-link path too', async () => {
    // That row may well carry a failed extension attempt's reason; pasting the
    // link settles the reply just as much as the extension committing it does.
    const { repo, postUpdate } = buildCommitRepo();

    await repo.updateReplyUrl(
      'org-1',
      'reply-1',
      'https://www.reddit.com/r/t/comments/a/b/'
    );

    expect(postUpdate.mock.calls[0][0].data.error).toBeNull();
  });
});

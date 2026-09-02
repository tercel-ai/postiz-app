import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostsService } from '../posts.service';

// The Post-side sibling of engage's markExtensionReplyRemoved: the extension
// published this post successfully, then a logged-out check (utils/liveness/,
// currently Reddit only) found the platform had removed it seconds later.
//
// Unlike the engage-reply path, there is nothing to withhold here — the
// commit already happened via markPublishedFromExtension, on purpose (see
// posts.service.ts's own comment: withholding it the way the reply gate does
// would leave the row in QUEUE, re-offered on every publish-due poll, risking
// a duplicate publish). So this only ever RECORDS a fact; it never charges,
// claims, or changes `state`.
function makeService(post: any) {
  const repo: any = {
    getPostById: vi.fn().mockResolvedValue(post),
    markPostRemoved: vi.fn().mockResolvedValue({}),
  };
  const svc = new PostsService(
    repo,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  return { svc, repo };
}

describe('PostsService.markExtensionPostRemoved', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records the removal on a published post', async () => {
    const { svc, repo } = makeService({ id: 'p1', state: 'PUBLISHED' });

    const r = await svc.markExtensionPostRemoved(
      'org-1',
      'p1',
      'removed',
      'https://www.reddit.com/r/test/comments/abc/title/'
    );

    expect(r).toEqual({ ok: true });
    expect(repo.getPostById).toHaveBeenCalledWith('p1', 'org-1');
    expect(repo.markPostRemoved).toHaveBeenCalledWith(
      'p1',
      'removed',
      'https://www.reddit.com/r/test/comments/abc/title/'
    );
  });

  it('passes "gone" through unchanged', async () => {
    const { svc, repo } = makeService({ id: 'p1', state: 'PUBLISHED' });

    await svc.markExtensionPostRemoved('org-1', 'p1', 'gone', null);

    expect(repo.markPostRemoved).toHaveBeenCalledWith('p1', 'gone', null);
  });

  it('normalizes an unrecognised reason to "removed" rather than storing it verbatim', async () => {
    // Defence in depth: the DTO's @IsIn already refuses anything but
    // 'removed'/'gone' at the HTTP boundary, but the service does not trust
    // that as the only line of defence — mirrors the identical test on
    // engage's markExtensionReplyRemoved.
    const { svc, repo } = makeService({ id: 'p1', state: 'PUBLISHED' });

    await svc.markExtensionPostRemoved('org-1', 'p1', 'some-unexpected-value');

    expect(repo.markPostRemoved).toHaveBeenCalledWith(
      'p1',
      'removed',
      undefined
    );
  });

  it('rejects an unknown or foreign-org post', async () => {
    const { svc, repo } = makeService(null);

    const r = await svc.markExtensionPostRemoved('org-1', 'nope', 'removed');

    expect(r).toEqual({ ok: false, reason: 'not-found' });
    expect(repo.markPostRemoved).not.toHaveBeenCalled();
  });

  it('does not require the post to already be PUBLISHED', async () => {
    // The extension only calls this after a successful backfill in practice,
    // but the service itself does not re-check state here — that ordering is
    // the CALLER's contract (queue.ts only checks liveness once
    // attemptBackfill's return value confirms the commit landed), not
    // something worth a second guard duplicating it.
    const { svc, repo } = makeService({ id: 'p1', state: 'QUEUE' });

    const r = await svc.markExtensionPostRemoved('org-1', 'p1', 'removed');

    expect(r).toEqual({ ok: true });
    expect(repo.markPostRemoved).toHaveBeenCalled();
  });

  it('never throws on a missing evidence string — it is optional and only logged', async () => {
    const { svc } = makeService({ id: 'p1', state: 'PUBLISHED' });

    await expect(
      svc.markExtensionPostRemoved('org-1', 'p1', 'removed', null, undefined)
    ).resolves.toEqual({ ok: true });
  });
});

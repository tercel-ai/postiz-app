import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostsService } from '../posts.service';

// Smallest viable PostsService — markPublishFailedFromExtension only touches
// the repository (getPostById + changeState).
function makeService(post: any, chainNodes?: any[]) {
  const repo: any = {
    getPostById: vi.fn().mockResolvedValue(post),
    changeState: vi.fn().mockResolvedValue({}),
    updatePost: vi.fn().mockResolvedValue({}),
    // Thread settling: a chain is published/failed as ONE extension task that
    // reports back against its anchor.
    publishExtensionChainChildren: vi.fn().mockResolvedValue({ count: 0 }),
    failExtensionChainChildren: vi.fn().mockResolvedValue({ count: 0 }),
    publishExtensionChainNodes: vi.fn().mockResolvedValue({ count: 0 }),
    failExtensionChainNodesByIds: vi.fn().mockResolvedValue({ count: 0 }),
    getExtensionPublishChainNodes: vi.fn().mockResolvedValue(chainNodes ?? []),
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

describe('PostsService.markPublishFailedFromExtension', () => {
  beforeEach(() => vi.clearAllMocks());

  it('flips a QUEUE post to ERROR with the reported reason', async () => {
    const { svc, repo } = makeService({ id: 'p1', state: 'QUEUE' });

    const r = await svc.markPublishFailedFromExtension(
      'org-1',
      'p1',
      'HN rejected the submission'
    );

    expect(r).toEqual({ ok: true });
    expect(repo.getPostById).toHaveBeenCalledWith('p1', 'org-1');
    expect(repo.changeState).toHaveBeenCalledWith(
      'p1',
      'ERROR',
      'HN rejected the submission'
    );
  });

  it('never touches a post that already reached PUBLISHED', async () => {
    const { svc, repo } = makeService({ id: 'p1', state: 'PUBLISHED' });

    const r = await svc.markPublishFailedFromExtension('org-1', 'p1', 'late');

    expect(r).toEqual({ ok: false, reason: 'already-published' });
    expect(repo.changeState).not.toHaveBeenCalled();
  });

  it('rejects an unknown or foreign-org post', async () => {
    const { svc, repo } = makeService(null);

    const r = await svc.markPublishFailedFromExtension('org-1', 'nope');

    expect(r).toEqual({ ok: false, reason: 'not-found' });
    expect(repo.changeState).not.toHaveBeenCalled();
  });

  it('refuses to touch a recurring original (clone-per-cycle owns its state)', async () => {
    const { svc, repo } = makeService({
      id: 'p1',
      state: 'QUEUE',
      intervalInDays: 7,
      parentPostId: null,
    });

    const r = await svc.markPublishFailedFromExtension('org-1', 'p1', 'x');

    expect(r).toEqual({ ok: false, reason: 'blocked-recurring-original' });
    expect(repo.changeState).not.toHaveBeenCalled();
  });
});

// A thread reaches the extension as one multi-segment task, so both callbacks
// arrive for the ANCHOR only. Without settling the children they stay QUEUE —
// unreachable (the due query is roots-only) until the stale sweep flips them to
// ERROR naming the wrong cause.
describe('extension callbacks settle the whole thread chain', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a failed anchor fails its children with the same reason', async () => {
    const { svc, repo } = makeService({
      id: 'anchor',
      state: 'QUEUE',
      group: 'g1',
      parentPostId: null,
    });

    const r = await svc.markPublishFailedFromExtension('org-1', 'anchor', 'boom');

    expect(r).toEqual({ ok: true });
    expect(repo.failExtensionChainChildren).toHaveBeenCalledWith(
      'org-1',
      'g1',
      'boom'
    );
  });

  it('a published anchor publishes its children', async () => {
    const { svc, repo } = makeService({
      id: 'anchor',
      state: 'QUEUE',
      group: 'g1',
      parentPostId: null,
    });

    const r = await svc.markPublishedFromExtension(
      'org-1',
      'anchor',
      'https://x.com/u/1',
      'rel-1'
    );

    expect(r).toEqual({ ok: true });
    expect(repo.publishExtensionChainChildren).toHaveBeenCalledWith('org-1', 'g1');
  });

  it('a callback for a CHILD never re-settles the chain', async () => {
    const { svc, repo } = makeService({
      id: 'c1',
      state: 'QUEUE',
      group: 'g1',
      parentPostId: 'anchor',
    });

    await svc.markPublishFailedFromExtension('org-1', 'c1', 'boom');

    expect(repo.failExtensionChainChildren).not.toHaveBeenCalled();
  });

  it('a child-settling failure never un-does an already-published anchor', async () => {
    const { svc, repo } = makeService({
      id: 'anchor',
      state: 'QUEUE',
      group: 'g1',
      parentPostId: null,
    });
    repo.publishExtensionChainChildren.mockRejectedValue(new Error('db down'));

    // The anchor is already PUBLISHED at this point; reporting failure here
    // would invite the extension to re-publish it, which cannot be undone.
    await expect(
      svc.markPublishedFromExtension('org-1', 'anchor', 'https://x.com/u/1', 'rel-1')
    ).resolves.toEqual({ ok: true });
    expect(repo.updatePost).toHaveBeenCalled();
  });
});

// Partial thread failure — the normal shape of a thread failure, since segments
// publish one at a time and the run stops at the first error. The anchor is
// usually already LIVE; recording it ERROR would drop a live post out of every
// metrics path, and its permalink is unrecoverable (it exists only in the
// extension's queue state, discarded when the task settles).
describe('markPublishFailedFromExtension — partial thread success', () => {
  beforeEach(() => vi.clearAllMocks());

  const anchor = { id: 'anchor', state: 'QUEUE', group: 'g1', parentPostId: null };
  const chain = [
    { id: 'anchor', group: 'g1', parentPostId: null },
    { id: 'c1', group: 'g1', parentPostId: 'anchor' },
    { id: 'c2', group: 'g1', parentPostId: 'c1' },
  ];

  it('publishes the reported segments and errors only the rest', async () => {
    const { svc, repo } = makeService(anchor, chain);

    const r = await svc.markPublishFailedFromExtension('org-1', 'anchor', 'seg 3 failed', [
      { postId: 'anchor', url: 'https://x.com/u/1', releaseId: 'rid-1' },
      { postId: 'c1', url: 'https://x.com/u/2' },
    ]);

    expect(r).toEqual({ ok: true, partial: true, published: 2 });
    // The anchor is live — it must NOT be flipped to ERROR.
    expect(repo.changeState).not.toHaveBeenCalled();
    expect(repo.publishExtensionChainNodes).toHaveBeenCalledWith('org-1', [
      { id: 'anchor', url: 'https://x.com/u/1', releaseId: 'rid-1' },
    ]);
    expect(repo.publishExtensionChainNodes).toHaveBeenCalledWith('org-1', [
      { id: 'c1', url: 'https://x.com/u/2', releaseId: undefined },
    ]);
    // Only the segment that never went out becomes ERROR.
    expect(repo.failExtensionChainNodesByIds).toHaveBeenCalledWith(
      'org-1',
      ['c2'],
      'seg 3 failed'
    );
  });

  it('errors the anchor when it is NOT among the published segments', async () => {
    const { svc, repo } = makeService(anchor, chain);

    // Segment 0 itself failed, so nothing is live — the classic total failure
    // even though the caller passed a (empty) list.
    const r = await svc.markPublishFailedFromExtension('org-1', 'anchor', 'boom', []);

    expect(r).toEqual({ ok: true });
    expect(repo.changeState).toHaveBeenCalledWith('anchor', 'ERROR', 'boom');
    expect(repo.publishExtensionChainNodes).not.toHaveBeenCalled();
    // Falls back to the group-wide sweep when there is nothing to split by.
    expect(repo.failExtensionChainChildren).toHaveBeenCalledWith('org-1', 'g1', 'boom');
  });

  it('settles by id, not by position in the reported list', async () => {
    const { svc, repo } = makeService(anchor, chain);

    // Reported out of order: c2 published but c1 did not (possible when a
    // permalink capture fails on one segment only). A positional match would
    // publish c1 — the wrong row — and stamp c2's live URL on it.
    await svc.markPublishFailedFromExtension('org-1', 'anchor', 'x', [
      { postId: 'anchor', url: 'https://x.com/u/1' },
      { postId: 'c2', url: 'https://x.com/u/3' },
    ]);

    expect(repo.publishExtensionChainNodes).toHaveBeenCalledWith('org-1', [
      { id: 'c2', url: 'https://x.com/u/3', releaseId: undefined },
    ]);
    expect(repo.failExtensionChainNodesByIds).toHaveBeenCalledWith('org-1', ['c1'], 'x');
  });

  it('an older extension (no segments) keeps the all-or-nothing behaviour', async () => {
    const { svc, repo } = makeService(anchor, chain);

    const r = await svc.markPublishFailedFromExtension('org-1', 'anchor', 'boom');

    expect(r).toEqual({ ok: true });
    expect(repo.changeState).toHaveBeenCalledWith('anchor', 'ERROR', 'boom');
    expect(repo.failExtensionChainChildren).toHaveBeenCalledWith('org-1', 'g1', 'boom');
    expect(repo.getExtensionPublishChainNodes).not.toHaveBeenCalled();
  });
});

// Success path: the top-level releaseURL describes the ANCHOR only, so without
// per-segment results every follow-up is PUBLISHED with no URL — on every
// successful thread, not just a failing one.
describe('markPublishedFromExtension — per-segment permalinks', () => {
  beforeEach(() => vi.clearAllMocks());

  const anchor = { id: 'anchor', state: 'QUEUE', group: 'g1', parentPostId: null };

  it('backfills each follow-up segment with its own permalink', async () => {
    const { svc, repo } = makeService(anchor, [
      { id: 'anchor', group: 'g1', parentPostId: null },
      { id: 'c1', group: 'g1', parentPostId: 'anchor' },
    ]);

    const r = await svc.markPublishedFromExtension(
      'org-1',
      'anchor',
      'https://x.com/u/1',
      'rid-1',
      [
        { postId: 'anchor', url: 'https://x.com/u/1' },
        { postId: 'c1', url: 'https://x.com/u/2', releaseId: 'rid-2' },
      ]
    );

    expect(r).toEqual({ ok: true });
    // The anchor goes through updatePost (it carries the recurring guard); only
    // the follow-ups are settled here, so it must not be double-written.
    expect(repo.publishExtensionChainNodes).toHaveBeenCalledWith('org-1', [
      { id: 'c1', url: 'https://x.com/u/2', releaseId: 'rid-2' },
    ]);
    // The group sweep still runs to mop up anything not reported; it is
    // QUEUE-guarded, so it cannot overwrite what was just published.
    expect(repo.publishExtensionChainChildren).toHaveBeenCalledWith('org-1', 'g1');
  });

  it('an older extension (no segments) still settles children URL-less', async () => {
    const { svc, repo } = makeService(anchor);

    await svc.markPublishedFromExtension('org-1', 'anchor', 'https://x.com/u/1', 'rid-1');

    expect(repo.publishExtensionChainNodes).not.toHaveBeenCalled();
    expect(repo.publishExtensionChainChildren).toHaveBeenCalledWith('org-1', 'g1');
  });
});

// The reported list is client input on BOTH callbacks, so both must intersect it
// with the real chain. Without that a caller could name any other QUEUE post of
// the org and have a permalink stamped on it.
describe('reported segments are constrained to the chain', () => {
  beforeEach(() => vi.clearAllMocks());

  const anchor = { id: 'anchor', state: 'QUEUE', group: 'g1', parentPostId: null };
  const chain = [
    { id: 'anchor', group: 'g1', parentPostId: null },
    { id: 'c1', group: 'g1', parentPostId: 'anchor' },
  ];

  it('success path ignores a reported id that is not a child of this chain', async () => {
    const { svc, repo } = makeService(anchor, chain);

    await svc.markPublishedFromExtension('org-1', 'anchor', 'https://x.com/u/1', 'rid-1', [
      { postId: 'c1', url: 'https://x.com/u/2' },
      { postId: 'someone-elses-post', url: 'https://evil.example/1' },
    ]);

    expect(repo.publishExtensionChainNodes).toHaveBeenCalledWith('org-1', [
      { id: 'c1', url: 'https://x.com/u/2', releaseId: undefined },
    ]);
  });

  it('failure path ignores a reported id that is not a child of this chain', async () => {
    const { svc, repo } = makeService(anchor, chain);

    await svc.markPublishFailedFromExtension('org-1', 'anchor', 'boom', [
      { postId: 'anchor', url: 'https://x.com/u/1' },
      { postId: 'someone-elses-post', url: 'https://evil.example/1' },
    ]);

    // c1 is the only real child and it did not publish → ERROR; the foreign id
    // is never written at all.
    expect(repo.publishExtensionChainNodes).toHaveBeenCalledTimes(1);
    expect(repo.publishExtensionChainNodes).toHaveBeenCalledWith('org-1', [
      { id: 'anchor', url: 'https://x.com/u/1', releaseId: undefined },
    ]);
    expect(repo.failExtensionChainNodesByIds).toHaveBeenCalledWith('org-1', ['c1'], 'boom');
  });
});

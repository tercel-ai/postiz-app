import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostsService } from '../posts.service';

/**
 * post.published / post.publish_failed on the EXTENSION publish path.
 *
 * The API path emits both from post.workflow.v1.0.1. The extension path has no
 * workflow, so it used to emit nothing at all: a post published by the browser
 * was silent in both directions while an identical API-published one produced
 * two notifications. These tests pin that the two paths now agree — same event
 * keys, same dedup-key format, same data shape.
 */
function makeService(post: any, chainNodes?: any[]) {
  const repo: any = {
    getPostById: vi.fn().mockResolvedValue(post),
    changeState: vi.fn().mockResolvedValue({}),
    updatePost: vi.fn().mockResolvedValue({ id: post?.id }),
    publishExtensionChainChildren: vi.fn().mockResolvedValue({ count: 0 }),
    failExtensionChainChildren: vi.fn().mockResolvedValue({ count: 0 }),
    publishExtensionChainNodes: vi.fn().mockResolvedValue({ count: 0 }),
    failExtensionChainNodesByIds: vi.fn().mockResolvedValue({ count: 0 }),
    getExtensionPublishChainNodes: vi.fn().mockResolvedValue(chainNodes ?? []),
    markPostRemoved: vi.fn().mockResolvedValue({}),
  };
  const notify = vi.fn(async () => true);
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
    {} as any,
    undefined,
    undefined,
    { notify } as any
  );
  return { svc, repo, notify };
}

const queued = {
  id: 'p1',
  state: 'QUEUE',
  organizationId: 'org-1',
  projectId: 'proj-1',
  providerIdentifier: 'quora',
  integration: { providerIdentifier: 'reddit' },
};

describe('extension publish → Aisee notification centre', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits post.published when the extension reports success', async () => {
    const { svc, notify } = makeService(queued);

    await svc.markPublishedFromExtension(
      'org-1',
      'p1',
      'https://reddit.com/r/x/comments/1',
      't3_1'
    );

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      organizationId: 'org-1',
      eventKey: 'post.published',
      // Same format the workflow uses, so a post that somehow travelled both
      // paths dedupes instead of notifying twice.
      dedupKey: 'post.published:p1',
      data: {
        platform: 'Reddit',
        post_id: 'p1',
        project_id: 'proj-1',
        external_url: 'https://reddit.com/r/x/comments/1',
      },
    });
  });

  it('falls back to the persisted platform when no account is bound', async () => {
    // Quora/HN publish through the browser session with no Integration row —
    // the path this whole feature exists for, so it must not report a blank.
    const { svc, notify } = makeService({ ...queued, integration: null });

    await svc.markPublishedFromExtension('org-1', 'p1', '', '');

    expect(notify.mock.calls[0][0].data).toMatchObject({ platform: 'Quora' });
    // A URL-less publish (Quora) is still live; the field is absent, not ''.
    expect(notify.mock.calls[0][0].data.external_url).toBeUndefined();
  });

  it('stays quiet on a repeat success callback', async () => {
    // The first callback already notified; this one writes nothing.
    const { svc, notify } = makeService({ ...queued, state: 'PUBLISHED' });

    const r = await svc.markPublishedFromExtension('org-1', 'p1', 'u', 'r');

    expect(r).toEqual({ ok: true, alreadyPublished: true });
    expect(notify).not.toHaveBeenCalled();
  });

  it('leaves the internal default out of the user-facing copy', async () => {
    // `reason` falls back to 'extension publish failed' for the ERROR column.
    // short_reason is APPENDED to the notification message, so sending that
    // default would render "...couldn't be published. extension publish
    // failed". Absent instead lets the registry use its own clean sentence.
    const { svc, notify } = makeService(queued);

    await svc.markPublishFailedFromExtension('org-1', 'p1');

    expect(notify.mock.calls[0][0].data.short_reason).toBeUndefined();
  });

  it('notifies once per chain, never for a thread child', async () => {
    // The publish-due query is roots-only so only anchors are reported in
    // practice, but the endpoint accepts any id of the org and a child would be
    // a second notification for one thread. The workflow notifies on i===0 only.
    const { svc, notify } = makeService({
      ...queued,
      parentPostId: 'p0',
      group: 'g1',
    });

    await svc.markPublishedFromExtension('org-1', 'p1', 'https://x.com/a/2', '2');

    expect(notify).not.toHaveBeenCalled();
  });

  it('emits post.publish_failed when the extension reports a failure', async () => {
    const { svc, notify } = makeService(queued);

    await svc.markPublishFailedFromExtension(
      'org-1',
      'p1',
      'HN rejected the submission'
    );

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      eventKey: 'post.publish_failed',
      dedupKey: 'post.publish_failed:p1',
      data: {
        platform: 'Reddit',
        post_id: 'p1',
        short_reason: 'HN rejected the submission',
      },
    });
  });

  it('emits BOTH events for a partial thread failure', async () => {
    // The anchor is live and the rest failed — the workflow reports the same
    // pair for the same situation, and suppressing either half would misreport
    // what the user can now see on the platform.
    const { svc, notify } = makeService(queued, [
      { id: 'p1', parentPostId: null },
      { id: 'p2', parentPostId: 'p1' },
    ]);

    await svc.markPublishFailedFromExtension('org-1', 'p1', 'thread broke', [
      { postId: 'p1', url: 'https://x.com/a/1', releaseId: '1' },
    ]);

    expect(notify.mock.calls.map((c: any[]) => c[0].eventKey)).toEqual([
      'post.published',
      'post.publish_failed',
    ]);
    expect(notify.mock.calls[0][0].data.external_url).toBe('https://x.com/a/1');
  });

  it('says nothing about a failure report it refused to act on', async () => {
    const { svc, notify } = makeService({ ...queued, state: 'PUBLISHED' });

    await svc.markPublishFailedFromExtension('org-1', 'p1', 'late');

    expect(notify).not.toHaveBeenCalled();
  });

  it('refuses a recurring original without notifying', async () => {
    const { svc, notify } = makeService({
      ...queued,
      intervalInDays: 7,
      parentPostId: null,
    });

    await svc.markPublishFailedFromExtension('org-1', 'p1', 'boom');

    expect(notify).not.toHaveBeenCalled();
  });

  it('emits post.removed when the platform takes a live post down', async () => {
    // NOT post.publish_failed: the post went out and was live. The user is
    // being told something different — a rule was broken — and there is
    // nothing to retry.
    const { svc, notify } = makeService({
      ...queued,
      state: 'PUBLISHED',
      releaseURL: 'https://reddit.com/r/x/comments/1',
      removedAt: null,
    });

    await svc.markExtensionPostRemoved('org-1', 'p1', 'gone', null, 'HTTP 404');

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      eventKey: 'post.removed',
      dedupKey: 'post.removed:p1',
      data: {
        platform: 'Reddit',
        post_id: 'p1',
        // `verdict`, not `short_reason`: in the registry that name means "a
        // sentence to append to the message", and 'gone' is a detector label.
        verdict: 'gone',
        // Falls back to the stored permalink when the re-check reports none.
        external_url: 'https://reddit.com/r/x/comments/1',
      },
    });
  });

  it('notifies once when the same removal is reported twice', async () => {
    // markPostRemoved is a blind update that re-stamps removedAt, so the row
    // cannot answer "was this new?" after the fact — the pre-write read must.
    const { svc, notify } = makeService({
      ...queued,
      state: 'PUBLISHED',
      removedAt: new Date('2026-09-11T00:00:00Z'),
    });

    const r = await svc.markExtensionPostRemoved('org-1', 'p1', 'removed');

    expect(r).toEqual({ ok: true });
    expect(notify).not.toHaveBeenCalled();
  });

  it('keeps the post published when the notification itself throws', async () => {
    const { svc, notify } = makeService(queued);
    notify.mockRejectedValueOnce(new Error('aisee down'));

    const r = await svc.markPublishedFromExtension('org-1', 'p1', 'u', 'r');

    expect(r).toEqual({ ok: true });
  });
});

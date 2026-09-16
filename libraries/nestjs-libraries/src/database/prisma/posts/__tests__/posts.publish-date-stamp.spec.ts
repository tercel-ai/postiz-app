/**
 * `publishDate` is an intention until the post is sent and the send time
 * afterwards — the calendar, /dashboard/* and every metrics window read it as
 * "when did this go out". A post the extension picks up an hour after its
 * scheduled minute (a closed browser, a lease taken late, a platform retry)
 * used to keep reporting the minute it was scheduled for, so these tests pin
 * the re-stamp at each publish-success commit, and pin the ONE place that must
 * never re-stamp.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PostsRepository } from '../posts.repository';
import { PostsService } from '../posts.service';

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

describe('PostsRepository.updatePost — the send time lands on publishDate', () => {
  it('stamps now() alongside PUBLISHED when no instant is supplied', async () => {
    const update = vi.fn().mockResolvedValue({});
    const repo = createRepo({ update });

    const before = Date.now();
    await repo.updatePost('p1', 'rel-1', 'https://x.com/u/1');
    const after = Date.now();

    const { data } = update.mock.calls[0][0];
    expect(data.state).toBe('PUBLISHED');
    expect(data.publishDate).toBeInstanceOf(Date);
    expect(data.publishDate.getTime()).toBeGreaterThanOrEqual(before);
    expect(data.publishDate.getTime()).toBeLessThanOrEqual(after);
  });

  it('uses the caller-supplied instant so a chain can share one', async () => {
    const update = vi.fn().mockResolvedValue({});
    const repo = createRepo({ update });
    const sentAt = new Date('2026-09-16T11:47:00.000Z');

    await repo.updatePost('p1', 'rel-1', 'https://x.com/u/1', sentAt);

    expect(update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: {
        state: 'PUBLISHED',
        publishDate: sentAt,
        releaseURL: 'https://x.com/u/1',
        releaseId: 'rel-1',
        error: null,
      },
    });
  });
});

describe('PostsRepository — thread segments carry the anchor’s instant', () => {
  it('stamps every reported node with the SAME date', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const repo = createRepo({ updateMany });
    const sentAt = new Date('2026-09-16T11:47:00.000Z');

    await repo.publishExtensionChainNodes(
      'org-1',
      [
        { id: 'c1', url: 'https://x.com/u/2' },
        { id: 'c2', url: 'https://x.com/u/3' },
      ],
      sentAt
    );

    expect(updateMany).toHaveBeenCalledTimes(2);
    for (const call of updateMany.mock.calls) {
      expect(call[0].data.state).toBe('PUBLISHED');
      expect(call[0].data.publishDate).toEqual(sentAt);
    }
  });

  it('resolves one instant for the whole loop when the caller omits it', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const repo = createRepo({ updateMany });

    await repo.publishExtensionChainNodes('org-1', [
      { id: 'c1' },
      { id: 'c2' },
    ]);

    const [first, second] = updateMany.mock.calls.map((c) => c[0].data.publishDate);
    expect(first).toBeInstanceOf(Date);
    expect(second).toEqual(first);
  });

  it('stamps the group-wide sweep too', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const repo = createRepo({ updateMany });
    const sentAt = new Date('2026-09-16T11:47:00.000Z');

    await repo.publishExtensionChainChildren('org-1', 'g1', sentAt);

    expect(updateMany.mock.calls[0][0].data).toEqual({
      state: 'PUBLISHED',
      publishDate: sentAt,
      error: null,
    });
  });
});

// The counter-case, and the reason this is not simply "every write that sets
// PUBLISHED also sets publishDate": for a recurring cycle clone publishDate is
// the identity findOrCreateCycleClone matches on, so moving it would hide the
// published clone from the next lookup for that cycle and let a restarted
// workflow post the content twice.
describe('PostsRepository.finalizeCycleClone — publishDate is an identity', () => {
  it('never touches publishDate when settling a recurring cycle clone', async () => {
    const update = vi.fn().mockResolvedValue({});
    const repo = createRepo({ update });

    await repo.finalizeCycleClone('clone-1', {
      state: 'PUBLISHED',
      releaseId: 'rel-1',
      releaseURL: 'https://x.com/u/1',
    });

    expect(update.mock.calls[0][0].data).not.toHaveProperty('publishDate');
  });
});

function makeService(post: any, chainNodes?: any[]) {
  const repo: any = {
    getPostById: vi.fn().mockResolvedValue(post),
    updatePost: vi.fn().mockResolvedValue({}),
    changeState: vi.fn().mockResolvedValue({}),
    publishExtensionChainChildren: vi.fn().mockResolvedValue({ count: 0 }),
    publishExtensionChainNodes: vi.fn().mockResolvedValue({ count: 0 }),
    failExtensionChainNodesByIds: vi.fn().mockResolvedValue({ count: 0 }),
    failExtensionChainChildren: vi.fn().mockResolvedValue({ count: 0 }),
    getExtensionPublishChainNodes: vi.fn().mockResolvedValue(chainNodes ?? []),
    attributeExtensionPublisher: vi.fn().mockResolvedValue({ count: 0 }),
  };
  const svc = new PostsService(
    repo,
    {} as any,
    { resolveExtensionPublisherId: vi.fn().mockResolvedValue(null) } as any,
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

describe('markPublishedFromExtension — one instant for the whole thread', () => {
  beforeEach(() => vi.clearAllMocks());

  it('gives the anchor, the reported segments and the sweep the same date', async () => {
    const { svc, repo } = makeService(
      { id: 'anchor', state: 'QUEUE', group: 'g1', parentPostId: null },
      [
        { id: 'anchor', group: 'g1', parentPostId: null },
        { id: 'c1', group: 'g1', parentPostId: 'anchor' },
      ]
    );

    await svc.markPublishedFromExtension(
      'org-1',
      'anchor',
      'https://x.com/u/1',
      'rid-1',
      [{ postId: 'c1', url: 'https://x.com/u/2' }]
    );

    const anchorDate = repo.updatePost.mock.calls[0][3];
    expect(anchorDate).toBeInstanceOf(Date);
    expect(repo.publishExtensionChainNodes.mock.calls[0][2]).toEqual(anchorDate);
    expect(repo.publishExtensionChainChildren.mock.calls[0][2]).toEqual(
      anchorDate
    );
  });

  it('stamps a send that lands hours after the scheduled minute', async () => {
    const scheduled = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const { svc, repo } = makeService({
      id: 'p1',
      state: 'QUEUE',
      group: 'g1',
      parentPostId: null,
      publishDate: scheduled,
    });

    await svc.markPublishedFromExtension('org-1', 'p1', 'https://x.com/u/1', 'r');

    const stamped: Date = repo.updatePost.mock.calls[0][3];
    expect(stamped.getTime()).toBeGreaterThan(scheduled.getTime());
  });
});

// A thread that broke mid-chain settles its live segments through two separate
// calls (the anchor, then the surviving children). They are still one send.
describe('markPublishFailedFromExtension — a partial thread is dated once', () => {
  beforeEach(() => vi.clearAllMocks());

  it('gives every segment that DID go out the same date', async () => {
    const { svc, repo } = makeService(
      { id: 'anchor', state: 'QUEUE', group: 'g1', parentPostId: null },
      [
        { id: 'anchor', group: 'g1', parentPostId: null },
        { id: 'c1', group: 'g1', parentPostId: 'anchor' },
        { id: 'c2', group: 'g1', parentPostId: 'anchor' },
      ]
    );

    await svc.markPublishFailedFromExtension('org-1', 'anchor', 'broke', [
      { postId: 'anchor', url: 'https://x.com/u/1' },
      { postId: 'c1', url: 'https://x.com/u/2' },
    ]);

    const [anchorCall, childrenCall] = repo.publishExtensionChainNodes.mock.calls;
    expect(anchorCall[2]).toBeInstanceOf(Date);
    expect(childrenCall[2]).toEqual(anchorCall[2]);
    // c2 never went out, so it is errored rather than dated.
    expect(repo.failExtensionChainNodesByIds).toHaveBeenCalledWith(
      'org-1',
      ['c2'],
      'broke'
    );
  });
});

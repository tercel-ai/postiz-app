import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostsService } from '../posts.service';

// Smallest viable PostsService — getDuePublishPosts only touches the
// repository (claim), media resolution (updateMedia → mediaService) and the
// extension publish config (segment gaps).
function makeService(
  opts: {
    rows?: any[];
    providerIds?: string[];
    segmentGaps?: any;
    chainNodes?: any[];
  } = {}
) {
  const repo: any = {
    claimDueExtensionPublishPosts: vi.fn().mockResolvedValue(opts.rows ?? []),
    // Thread children of the claimed roots; empty means every item is a
    // single-segment post.
    getExtensionPublishChainNodes: vi
      .fn()
      .mockResolvedValue(opts.chainNodes ?? []),
  };
  const integrationManager: any = {
    extensionPublishProviderIds: vi.fn().mockReturnValue(opts.providerIds ?? []),
  };
  const mediaService: any = {
    getMediaById: vi.fn(),
  };
  const extensionPublishConfig: any = {
    getSegmentGaps: vi.fn().mockResolvedValue(opts.segmentGaps ?? {}),
  };
  const svc = new PostsService(
    repo,
    integrationManager,
    {} as any,
    mediaService,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    extensionPublishConfig
  );
  return { svc, repo };
}

describe('PostsService.getDuePublishPosts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves the post image field into absolute URLs on segment 0', async () => {
    const { svc } = makeService({
      rows: [
        {
          id: 'post1',
          content: 'hello world',
          image: JSON.stringify([{ path: 'https://cdn.example.com/a.png' }]),
          settings: '{}',
          title: null,
          publishDate: new Date('2026-07-01T00:00:00.000Z'),
          integration: null,
        },
      ],
    });

    const { due } = await svc.getDuePublishPosts('org-1', 10);

    expect(due).toHaveLength(1);
    expect(due[0].segments).toEqual([
      { postId: 'post1', text: 'hello world', images: ['https://cdn.example.com/a.png'] },
    ]);
  });

  it('omits images when the post has none', async () => {
    const { svc } = makeService({
      rows: [
        {
          id: 'post2',
          content: 'no pictures here',
          image: '[]',
          settings: '{}',
          title: null,
          publishDate: new Date('2026-07-01T00:00:00.000Z'),
          integration: null,
        },
      ],
    });

    const { due } = await svc.getDuePublishPosts('org-1', 10);

    expect(due[0].segments).toEqual([{ postId: 'post2', text: 'no pictures here' }]);
  });

  it('publishes text-only when the stored image field is malformed', async () => {
    const { svc } = makeService({
      rows: [
        {
          id: 'post3',
          content: 'still fine',
          image: 'not-json',
          settings: '{}',
          title: null,
          publishDate: new Date('2026-07-01T00:00:00.000Z'),
          integration: null,
        },
      ],
    });

    const { due } = await svc.getDuePublishPosts('org-1', 10);

    expect(due[0].segments).toEqual([{ postId: 'post3', text: 'still fine' }]);
  });

  it('stamps the platform-resolved segmentGapSeconds on each due item', async () => {
    const { svc } = makeService({
      segmentGaps: { reddit: [45, 180], x: [20, 90] },
      rows: [
        {
          id: 'post4',
          content: 'thread anchor',
          image: '[]',
          settings: JSON.stringify({
            subreddit: [{ value: { subreddit: 'test', title: 'hello' } }],
          }),
          title: 'hello',
          publishDate: new Date('2026-07-01T00:00:00.000Z'),
          providerIdentifier: 'reddit',
          integration: null,
        },
      ],
    });

    const { due } = await svc.getDuePublishPosts('org-1', 10);

    expect(due[0].platform).toBe('reddit');
    expect(due[0].segmentGapSeconds).toEqual([45, 180]);
  });

  it('resolves subreddit from the real RedditSettingsDto array shape (not the raw array)', async () => {
    // settings.subreddit is RedditSettingsValueDto[] — an array of
    // { value: { subreddit, title, type, is_flair_required } }, never a plain
    // string. Forwarding the raw array made the extension's queue validation
    // (`(item.subreddit || '').trim()`) throw on every poll, so the post
    // never left QUEUE. Regression test for that bug.
    const { svc } = makeService({
      rows: [
        {
          id: 'post6',
          content: 'reddit body',
          image: '[]',
          settings: JSON.stringify({
            subreddit: [
              {
                value: {
                  subreddit: 'machinelearning',
                  title: 'hello reddit',
                  type: 'self',
                  is_flair_required: false,
                },
              },
            ],
          }),
          title: 'hello reddit',
          publishDate: new Date('2026-07-01T00:00:00.000Z'),
          providerIdentifier: 'reddit',
          integration: null,
        },
      ],
    });

    const { due } = await svc.getDuePublishPosts('org-1', 10);

    expect(due[0].subreddit).toBe('machinelearning');
  });

  // Same class of bug as the subreddit one above, same settings entry: Reddit
  // stores its title INSIDE subreddit[0].value, and an operation-plan post is
  // materialized with Post.title null, so reading only `p.title ||
  // settings.title` left the item titleless. The extension then rejected it
  // ("reddit post needs a title") and, since a rejected item never leaves
  // QUEUE, the post was re-offered every poll forever.
  it('falls back to the reddit settings title when Post.title is null', async () => {
    const { svc } = makeService({
      rows: [
        {
          id: 'post9',
          content: 'reddit body',
          image: '[]',
          settings: JSON.stringify({
            __type: 'reddit',
            subreddit: [
              {
                value: {
                  subreddit: 'football',
                  title: 'Tactical Deep-Dive: Spain’s defensive record',
                  type: 'self',
                  is_flair_required: false,
                },
              },
            ],
          }),
          title: null,
          publishDate: new Date('2026-07-01T00:00:00.000Z'),
          providerIdentifier: 'reddit',
          integration: null,
        },
      ],
    });

    const { due } = await svc.getDuePublishPosts('org-1', 10);

    expect(due[0].title).toBe('Tactical Deep-Dive: Spain’s defensive record');
    expect(due[0].subreddit).toBe('football');
  });

  it('prefers Post.title over the reddit settings title when both exist', async () => {
    const { svc } = makeService({
      rows: [
        {
          id: 'post10',
          content: 'reddit body',
          image: '[]',
          settings: JSON.stringify({
            subreddit: [{ value: { subreddit: 'football', title: 'settings title' } }],
          }),
          title: 'post row title',
          publishDate: new Date('2026-07-01T00:00:00.000Z'),
          providerIdentifier: 'reddit',
          integration: null,
        },
      ],
    });

    const { due } = await svc.getDuePublishPosts('org-1', 10);

    expect(due[0].title).toBe('post row title');
  });

  // The reddit fallback must not disturb the platforms that legitimately keep
  // their title at the top level of settings (devto/medium/hackernews).
  it('still reads a top-level settings title for non-reddit platforms', async () => {
    const { svc } = makeService({
      rows: [
        {
          id: 'post11',
          content: 'article body',
          image: '[]',
          settings: JSON.stringify({ title: 'My dev.to article' }),
          title: null,
          publishDate: new Date('2026-07-01T00:00:00.000Z'),
          providerIdentifier: 'devto',
          integration: null,
        },
      ],
    });

    const { due } = await svc.getDuePublishPosts('org-1', 10);

    expect(due[0].title).toBe('My dev.to article');
  });

  it('forwards the reddit flair LABEL from settings so the extension can pre-select it', async () => {
    const { svc } = makeService({
      rows: [
        {
          id: 'post7',
          content: 'reddit body',
          image: '[]',
          settings: JSON.stringify({
            subreddit: [
              {
                value: {
                  subreddit: 'machinelearning',
                  title: '[D] hello',
                  type: 'self',
                  is_flair_required: false,
                  flairLabel: 'Discussion',
                },
              },
            ],
          }),
          title: '[D] hello',
          publishDate: new Date('2026-07-01T00:00:00.000Z'),
          providerIdentifier: 'reddit',
          integration: null,
        },
      ],
    });

    const { due } = await svc.getDuePublishPosts('org-1', 10);

    expect(due[0].flairLabel).toBe('Discussion');
  });

  it('omits flairLabel entirely when the plan proposed none', async () => {
    const { svc } = makeService({
      rows: [
        {
          id: 'post8',
          content: 'reddit body',
          image: '[]',
          settings: JSON.stringify({
            subreddit: [{ value: { subreddit: 'webdev', title: 'hello' } }],
          }),
          title: 'hello',
          publishDate: new Date('2026-07-01T00:00:00.000Z'),
          providerIdentifier: 'reddit',
          integration: null,
        },
      ],
    });

    const { due } = await svc.getDuePublishPosts('org-1', 10);

    expect(due[0]).not.toHaveProperty('flairLabel');
  });

  it('omits segmentGapSeconds when the platform has no configured range', async () => {
    const { svc } = makeService({
      segmentGaps: { reddit: [45, 180] },
      rows: [
        {
          id: 'post5',
          content: 'no gap config',
          image: '[]',
          settings: '{}',
          title: null,
          publishDate: new Date('2026-07-01T00:00:00.000Z'),
          providerIdentifier: 'instagram',
          integration: null,
        },
      ],
    });

    const { due } = await svc.getDuePublishPosts('org-1', 10);

    expect(due[0]).not.toHaveProperty('segmentGapSeconds');
  });
});

// Thread reconstruction. A chain is claimed by its ANCHOR only (the due query is
// roots-only) and delivered as one multi-segment item — before this, a root with
// children was excluded from the query outright and never published at all.
describe('PostsService.getDuePublishPosts — thread chains', () => {
  beforeEach(() => vi.clearAllMocks());

  const root = (over: Partial<any> = {}) => ({
    id: 'anchor',
    group: 'g1',
    content: 'part 1',
    image: '[]',
    settings: '{}',
    title: null,
    publishDate: new Date('2026-07-01T00:00:00.000Z'),
    integration: null,
    ...over,
  });

  const child = (over: Partial<any>) => ({
    group: 'g1',
    image: '[]',
    ...over,
  });

  it('expands an anchor into ordered segments by walking parentPostId', async () => {
    const { svc } = makeService({
      rows: [root()],
      // Deliberately out of order: order must come from the parent links, not
      // from the row order the DB happened to return.
      chainNodes: [
        child({ id: 'c2', parentPostId: 'c1', content: 'part 3' }),
        child({ id: 'anchor', parentPostId: null, content: 'part 1' }),
        child({ id: 'c1', parentPostId: 'anchor', content: 'part 2' }),
      ],
    });

    const { due } = await svc.getDuePublishPosts('org-1', 10);

    expect(due).toHaveLength(1);
    expect(due[0].segments).toEqual([
      { postId: 'anchor', text: 'part 1' },
      { postId: 'c1', text: 'part 2' },
      { postId: 'c2', text: 'part 3' },
    ]);
  });

  it('resolves the anchor media and drops media on thread continuations', async () => {
    const { svc } = makeService({
      rows: [
        root({ image: JSON.stringify([{ path: 'https://cdn.example.com/a.png' }]) }),
      ],
      chainNodes: [
        child({
          id: 'c1',
          parentPostId: 'anchor',
          content: 'part 2',
          image: JSON.stringify([{ path: 'https://cdn.example.com/b.png' }]),
        }),
      ],
    });

    const { due } = await svc.getDuePublishPosts('org-1', 10);

    // A thread continuation is a reply/comment whose poster takes text only, and
    // the extension REJECTS an item carrying images past segment 0. A rejected
    // item never leaves Post.state=QUEUE, so emitting them would re-offer this
    // post on every poll forever. Plan thread parts really can carry media
    // (materializePlanPosts writes `image` on every chain node), so this is the
    // case that keeps a threaded plan post publishable at all.
    expect(due[0].segments).toEqual([
      { postId: 'anchor', text: 'part 1', images: ['https://cdn.example.com/a.png'] },
      { postId: 'c1', text: 'part 2' },
    ]);
  });

  it('ignores same-group rows that are not reachable from the anchor', async () => {
    const { svc } = makeService({
      rows: [root()],
      chainNodes: [
        child({ id: 'c1', parentPostId: 'anchor', content: 'part 2' }),
        // Shares the group but hangs off nothing in this chain — corrupt data
        // must not silently become an extra segment.
        child({ id: 'orphan', parentPostId: 'ghost', content: 'should not post' }),
      ],
    });

    const { due } = await svc.getDuePublishPosts('org-1', 10);

    expect(due[0].segments).toEqual([
      { postId: 'anchor', text: 'part 1' },
      { postId: 'c1', text: 'part 2' },
    ]);
  });

  it('terminates on a cyclic parent link instead of hanging the poll', async () => {
    const { svc } = makeService({
      rows: [root()],
      chainNodes: [
        child({ id: 'c1', parentPostId: 'anchor', content: 'part 2' }),
        child({ id: 'anchor', parentPostId: 'c1', content: 'cycle' }),
      ],
    });

    const { due } = await svc.getDuePublishPosts('org-1', 10);

    // Bounded by the node count — the guarantee that matters is that it returns.
    expect(due[0].segments.length).toBeLessThanOrEqual(3);
    expect(due[0].segments[0]).toEqual({ postId: 'anchor', text: 'part 1' });
  });

  it('keeps chains separate when several anchors are claimed in one poll', async () => {
    const { svc } = makeService({
      rows: [
        root({ id: 'a1', group: 'g1', content: 'A1' }),
        root({ id: 'a2', group: 'g2', content: 'B1' }),
      ],
      chainNodes: [
        child({ id: 'a1c', group: 'g1', parentPostId: 'a1', content: 'A2' }),
        child({ id: 'a2c', group: 'g2', parentPostId: 'a2', content: 'B2' }),
      ],
    });

    const { due } = await svc.getDuePublishPosts('org-1', 10);

    expect(due[0].segments).toEqual([
      { postId: 'a1', text: 'A1' },
      { postId: 'a1c', text: 'A2' },
    ]);
    expect(due[1].segments).toEqual([
      { postId: 'a2', text: 'B1' },
      { postId: 'a2c', text: 'B2' },
    ]);
  });

  it('queries chain nodes once for the whole batch, by the claimed groups', async () => {
    const { svc, repo } = makeService({
      rows: [root({ id: 'a1', group: 'g1' }), root({ id: 'a2', group: 'g2' })],
    });

    await svc.getDuePublishPosts('org-1', 10);

    expect(repo.getExtensionPublishChainNodes).toHaveBeenCalledTimes(1);
    expect(repo.getExtensionPublishChainNodes).toHaveBeenCalledWith('org-1', [
      'g1',
      'g2',
    ]);
  });
});

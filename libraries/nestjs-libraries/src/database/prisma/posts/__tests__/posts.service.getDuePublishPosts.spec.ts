import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostsService } from '../posts.service';

// Smallest viable PostsService — getDuePublishPosts only touches the
// repository (claim), media resolution (updateMedia → mediaService) and the
// extension publish config (segment gaps).
function makeService(
  opts: { rows?: any[]; providerIds?: string[]; segmentGaps?: any } = {}
) {
  const repo: any = {
    claimDueExtensionPublishPosts: vi.fn().mockResolvedValue(opts.rows ?? []),
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
      { text: 'hello world', images: ['https://cdn.example.com/a.png'] },
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

    expect(due[0].segments).toEqual([{ text: 'no pictures here' }]);
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

    expect(due[0].segments).toEqual([{ text: 'still fine' }]);
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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostsService } from '../posts.service';

// getPost / getPostsByGroup feed aisee-app's edit dialog directly (the same
// `editable` payload shape create-post-validators.ts checks before a save).
// updateMedia stamps every media item `type: 'image'` regardless of what it
// actually is, so a post whose media is really two videos (X stores an
// animated GIF as an mp4 — see postable-media.ts) would otherwise round-trip
// straight back into the edit dialog still broken. Both read paths must cap
// to one video the same way getDuePublishPosts does at publish time.

function baseRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'post-1',
    group: 'group-1',
    image: JSON.stringify([
      { id: 'm1', path: 'https://files.aisee.live/a.mp4', url: 'https://files.aisee.live/a.mp4', type: 'image' },
      { id: 'm2', path: 'https://files.aisee.live/b.mp4', url: 'https://files.aisee.live/b.mp4', type: 'image' },
    ]),
    settings: '{}',
    integrationId: 'int-1',
    integration: { picture: null },
    childrenPost: [],
    ...overrides,
  };
}

function createService(postRepository: Record<string, any>) {
  return new PostsService(
    postRepository as any,
    {} as any,
    {} as any,
    { getMediaById: vi.fn() } as any,
    { convertTextToShortLinks: vi.fn().mockImplementation((_org, msgs) => msgs) } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
}

describe('PostsService read paths cap media to one video', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getPost keeps only the first video among the post media', async () => {
    const postRepository = {
      getPost: vi.fn().mockResolvedValue(baseRow()),
    };
    const service = createService(postRepository);

    const result = await service.getPost('org-1', 'post-1');

    expect(result.posts[0].image).toEqual([
      { id: 'm1', path: 'https://files.aisee.live/a.mp4', url: 'https://files.aisee.live/a.mp4', type: 'image' },
    ]);
  });

  it('getPostsByGroup keeps only the first video among the post media', async () => {
    const postRepository = {
      getPostsByGroup: vi.fn().mockResolvedValue([baseRow()]),
    };
    const service = createService(postRepository);

    const result = await service.getPostsByGroup('org-1', 'group-1');

    expect(result.posts[0].image).toEqual([
      { id: 'm1', path: 'https://files.aisee.live/a.mp4', url: 'https://files.aisee.live/a.mp4', type: 'image' },
    ]);
  });
});

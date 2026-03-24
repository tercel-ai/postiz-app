import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostsController } from '../posts.controller';

// ---------------------------------------------------------------------------
// Mock dependencies — only what createPost touches
// ---------------------------------------------------------------------------

function createMocks() {
  return {
    postsService: {
      mapTypeToPost: vi.fn().mockResolvedValue({ type: 'schedule', posts: [] }),
      createPost: vi.fn().mockResolvedValue([
        { postId: 'post-123', integration: 'int-1' },
      ]),
    },
    postReleaseService: {},
    agentGraphService: {},
    shortLinkService: {},
  };
}

function createController(mocks: ReturnType<typeof createMocks>) {
  return new PostsController(
    mocks.postsService as any,
    mocks.postReleaseService as any,
    mocks.agentGraphService as any,
    mocks.shortLinkService as any,
  );
}

const fakeOrg = { id: 'org-1' } as any;
const fakeUser = { id: 'user-1' } as any;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostsController.createPost', () => {
  let mocks: ReturnType<typeof createMocks>;
  let controller: PostsController;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    controller = createController(mocks);
  });

  it('passes userId to PostsService.createPost', async () => {
    await controller.createPost(fakeOrg, fakeUser, {});

    expect(mocks.postsService.createPost).toHaveBeenCalledWith(
      'org-1',
      expect.any(Object),
      'user-1',
    );
  });

  it('returns the result from createPost', async () => {
    mocks.postsService.createPost.mockResolvedValue([
      { postId: 'post-abc', integration: 'int-1' },
    ]);

    const result = await controller.createPost(fakeOrg, fakeUser, {});

    expect(result).toEqual([{ postId: 'post-abc', integration: 'int-1' }]);
  });

  it('returns empty array when createPost returns empty', async () => {
    mocks.postsService.createPost.mockResolvedValue([]);

    const result = await controller.createPost(fakeOrg, fakeUser, {});

    expect(result).toEqual([]);
  });
});

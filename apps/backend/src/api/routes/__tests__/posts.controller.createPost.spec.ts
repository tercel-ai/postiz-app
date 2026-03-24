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
    postOverageService: {
      deductIfOverage: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function createController(mocks: ReturnType<typeof createMocks>) {
  return new PostsController(
    mocks.postsService as any,
    mocks.postReleaseService as any,
    mocks.agentGraphService as any,
    mocks.shortLinkService as any,
    mocks.postOverageService as any,
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

  it('calls deductIfOverage with correct postId from createPost result', async () => {
    // createPost returns [{ postId: 'post-123', integration: 'int-1' }]
    // The fix: controller reads result[0].postId (not result[0].id)
    mocks.postsService.createPost.mockResolvedValue([
      { postId: 'post-abc', integration: 'int-1' },
    ]);

    await controller.createPost(fakeOrg, fakeUser, {});

    expect(mocks.postOverageService.deductIfOverage).toHaveBeenCalledTimes(1);
    expect(mocks.postOverageService.deductIfOverage).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'post-abc',
    );
  });

  it('calls deductIfOverage for each post creation (single-post body)', async () => {
    mocks.postsService.createPost.mockResolvedValue([
      { postId: 'post-single', integration: 'int-1' },
    ]);

    const result = await controller.createPost(fakeOrg, fakeUser, {});

    expect(result).toEqual([{ postId: 'post-single', integration: 'int-1' }]);
    expect(mocks.postOverageService.deductIfOverage).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'post-single',
    );
  });

  it('does NOT call deductIfOverage when createPost returns empty array', async () => {
    mocks.postsService.createPost.mockResolvedValue([]);

    await controller.createPost(fakeOrg, fakeUser, {});

    expect(mocks.postOverageService.deductIfOverage).not.toHaveBeenCalled();
  });

  it('does NOT call deductIfOverage when result[0].postId is undefined', async () => {
    // Edge case: createPost returns an object without postId
    mocks.postsService.createPost.mockResolvedValue([
      { integration: 'int-1' }, // no postId
    ]);

    await controller.createPost(fakeOrg, fakeUser, {});

    expect(mocks.postOverageService.deductIfOverage).not.toHaveBeenCalled();
  });

  it('still returns result even if deductIfOverage fails', async () => {
    mocks.postsService.createPost.mockResolvedValue([
      { postId: 'post-err', integration: 'int-1' },
    ]);
    mocks.postOverageService.deductIfOverage.mockRejectedValue(
      new Error('credit service down')
    );

    const result = await controller.createPost(fakeOrg, fakeUser, {});

    // Result should still be returned — deductIfOverage is fire-and-forget
    expect(result).toEqual([{ postId: 'post-err', integration: 'int-1' }]);
  });

  // -------------------------------------------------------------------------
  // Regression: the original bug was accessing result[0]?.id instead of
  // result[0]?.postId, which meant deductIfOverage was NEVER called.
  // -------------------------------------------------------------------------

  it('REGRESSION: would fail if accessing .id instead of .postId', async () => {
    // The return shape has .postId, NOT .id
    const returnValue = [{ postId: 'post-regression', integration: 'int-1' }];
    mocks.postsService.createPost.mockResolvedValue(returnValue);

    // Verify the shape — .id does not exist
    expect(returnValue[0]).not.toHaveProperty('id');
    expect(returnValue[0]).toHaveProperty('postId', 'post-regression');

    await controller.createPost(fakeOrg, fakeUser, {});

    // After the fix, deductIfOverage should be called
    expect(mocks.postOverageService.deductIfOverage).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostsService } from '../posts.service';

const POST_ID = 'post-1';
const ORG_ID = 'org-1';
const PROJECT_ID = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
const CLAIM_TOKEN = 'claim-1';

function createMocks() {
  return {
    postRepository: {
      getPostProjectScope: vi.fn(),
      claimPostForPublishing: vi.fn().mockResolvedValue(true),
      changeState: vi.fn().mockResolvedValue(undefined),
    },
    projectValidation: {
      isProjectActive: vi.fn().mockResolvedValue(true),
    },
  };
}

function createService(mocks: ReturnType<typeof createMocks>) {
  return new PostsService(
    mocks.postRepository as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    mocks.projectValidation as any
  );
}

describe('PostsService.claimPostForPublishing', () => {
  let mocks: ReturnType<typeof createMocks>;
  let service: PostsService;

  beforeEach(() => {
    mocks = createMocks();
    service = createService(mocks);
  });

  it('claims normally when the owning project is active', async () => {
    mocks.postRepository.getPostProjectScope.mockResolvedValue({
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      state: 'QUEUE',
    });

    await expect(
      service.claimPostForPublishing(POST_ID, CLAIM_TOKEN)
    ).resolves.toBe(true);
    expect(mocks.postRepository.claimPostForPublishing).toHaveBeenCalledWith(
      POST_ID,
      CLAIM_TOKEN
    );
    expect(mocks.postRepository.changeState).not.toHaveBeenCalled();
  });

  it('refuses to claim and marks the post ERROR when the project is deactivated', async () => {
    mocks.postRepository.getPostProjectScope.mockResolvedValue({
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      state: 'QUEUE',
    });
    mocks.projectValidation.isProjectActive.mockResolvedValue(false);

    await expect(
      service.claimPostForPublishing(POST_ID, CLAIM_TOKEN)
    ).resolves.toBe(false);
    expect(mocks.postRepository.claimPostForPublishing).not.toHaveBeenCalled();

    const [id, state, error] = mocks.postRepository.changeState.mock.calls[0];
    expect(id).toBe(POST_ID);
    expect(state).toBe('ERROR');
    expect((error as Error).message).toContain('deactivated');
  });

  it('never rewrites an already-PUBLISHED post, even on a deactivated project', async () => {
    mocks.postRepository.getPostProjectScope.mockResolvedValue({
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      state: 'PUBLISHED',
    });
    mocks.projectValidation.isProjectActive.mockResolvedValue(false);

    await expect(
      service.claimPostForPublishing(POST_ID, CLAIM_TOKEN)
    ).resolves.toBe(false);
    expect(mocks.postRepository.changeState).not.toHaveBeenCalled();
    expect(mocks.postRepository.claimPostForPublishing).not.toHaveBeenCalled();
  });

  it('claims legacy posts that carry no projectId without asking aisee-core', async () => {
    mocks.postRepository.getPostProjectScope.mockResolvedValue({
      organizationId: ORG_ID,
      projectId: null,
      state: 'QUEUE',
    });

    await expect(
      service.claimPostForPublishing(POST_ID, CLAIM_TOKEN)
    ).resolves.toBe(true);
    expect(mocks.projectValidation.isProjectActive).not.toHaveBeenCalled();
    expect(mocks.postRepository.claimPostForPublishing).toHaveBeenCalled();
  });

  it('claims when the post no longer exists — the repository decides the outcome', async () => {
    mocks.postRepository.getPostProjectScope.mockResolvedValue(null);
    mocks.postRepository.claimPostForPublishing.mockResolvedValue(false);

    await expect(
      service.claimPostForPublishing(POST_ID, CLAIM_TOKEN)
    ).resolves.toBe(false);
    expect(mocks.projectValidation.isProjectActive).not.toHaveBeenCalled();
  });
});

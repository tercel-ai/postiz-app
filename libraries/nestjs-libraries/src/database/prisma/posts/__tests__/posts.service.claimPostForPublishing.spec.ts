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
      getPostById: vi.fn().mockResolvedValue({
        id: POST_ID,
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        providerIdentifier: 'x',
        integration: { providerIdentifier: 'x' },
      }),
      claimPostForPublishing: vi.fn().mockResolvedValue(true),
      changeState: vi.fn().mockResolvedValue(undefined),
    },
    projectValidation: {
      isProjectActive: vi.fn().mockResolvedValue(true),
    },
    notifications: { notify: vi.fn().mockResolvedValue(true) },
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
    mocks.projectValidation as any,
    undefined,
    mocks.notifications as any
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
    // Refusing the claim means no workflow ever runs, so this is the only
    // report the user gets that the scheduled send will never happen.
    expect(mocks.postRepository.getPostById).toHaveBeenCalledWith(
      POST_ID,
      ORG_ID
    );
    expect(mocks.notifications.notify).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      eventKey: 'post.publish_failed',
      dedupKey: 'post.publish_failed:post-1',
      data: {
        platform: 'X',
        post_id: POST_ID,
        project_id: PROJECT_ID,
        short_reason:
          'Project is deactivated — publishing was skipped. Reactivate the project and reschedule this post.',
      },
    });
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
    expect(mocks.notifications.notify).not.toHaveBeenCalled();
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

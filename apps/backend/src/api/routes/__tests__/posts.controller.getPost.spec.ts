import { describe, it, expect, vi } from 'vitest';
import { PostsController } from '../posts.controller';

function createController() {
  const postsService = {
    getPost: vi.fn().mockResolvedValue({ group: 'g1', posts: [] }),
  };
  const controller = new PostsController(
    postsService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  return { controller, postsService };
}

const fakeOrg = { id: 'org-1' } as any;

describe('PostsController.getPost', () => {
  it('passes the projectId query param through to PostsService.getPost', async () => {
    const { controller, postsService } = createController();

    await controller.getPost(fakeOrg, 'post-1', 'proj-1');

    expect(postsService.getPost).toHaveBeenCalledWith('org-1', 'post-1', false, 'proj-1');
  });

  it('passes undefined projectId for a legacy, non-project request', async () => {
    const { controller, postsService } = createController();

    await controller.getPost(fakeOrg, 'post-1');

    expect(postsService.getPost).toHaveBeenCalledWith('org-1', 'post-1', false, undefined);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostsService } from '../posts.service';

// The stale sweep is the only terminal path for a post whose workflow never
// started, so it must announce the failure itself — with the same event and
// dedup key the workflow uses, so a post that did report there is a no-op.
function makeService(
  sweep: { count: number; closedRoots: any[] },
  notifications?: { notify: any }
) {
  const repo: any = {
    markStaleQueuePostsAsError: vi.fn().mockResolvedValue(sweep),
  };
  const integrations: any = {
    extensionPublishProviderIds: vi.fn().mockReturnValue(['mastodon']),
  };
  const svc = new PostsService(
    repo,
    integrations,
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
    notifications as any
  );
  return { svc, repo, integrations };
}

describe('PostsService.markStaleQueuePostsAsError', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the swept count and announces each closed root once', async () => {
    const notify = vi.fn().mockResolvedValue(true);
    const { svc, repo, integrations } = makeService(
      {
        count: 3,
        closedRoots: [
          {
            id: 'post-1',
            organizationId: 'org-1',
            projectId: 'project-1',
            providerIdentifier: 'mastodon',
            integration: { providerIdentifier: 'mastodon' },
          },
          {
            id: 'post-2',
            organizationId: 'org-1',
            projectId: null,
            providerIdentifier: null,
            integration: null,
          },
        ],
      },
      { notify }
    );

    const count = await svc.markStaleQueuePostsAsError();

    expect(count).toBe(3);
    expect(repo.markStaleQueuePostsAsError).toHaveBeenCalledWith(['mastodon']);
    expect(integrations.extensionPublishProviderIds).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith({
      organizationId: 'org-1',
      eventKey: 'post.publish_failed',
      // Keyed on the root row, exactly like the workflow's failure path.
      dedupKey: 'post.publish_failed:post-1',
      data: {
        platform: 'Mastodon',
        post_id: 'post-1',
        project_id: 'project-1',
        short_reason: 'It fell outside the recovery window.',
      },
    });
    // A post with no provider still notifies: the registry carries a fallback.
    expect(notify.mock.calls[1][0].data.platform).toBe('');
  });

  it('does not announce anything when the sweep closed nothing', async () => {
    const notify = vi.fn().mockResolvedValue(true);
    const { svc } = makeService({ count: 0, closedRoots: [] }, { notify });

    await svc.markStaleQueuePostsAsError();

    expect(notify).not.toHaveBeenCalled();
  });
});

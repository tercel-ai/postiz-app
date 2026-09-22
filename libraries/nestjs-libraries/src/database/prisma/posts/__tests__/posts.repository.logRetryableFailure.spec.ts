import { describe, expect, it, vi } from 'vitest';
import { PostsRepository } from '../posts.repository';

// logRetryableFailure exists specifically because logError assumes a bound
// integration (`post.integration.providerIdentifier`), which throws for any
// post with integrationId=null — routine for extension-posted rows (engage
// replies go out through a signed-in browser session, not a connected
// integration). It must also never touch Post.state: the queue item stays
// exactly as it was and may still succeed on a later poll.
function createRepo(postModel: Record<string, any>, errorsModel: Record<string, any>) {
  return new PostsRepository(
    { model: { post: postModel } } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { model: { errors: errorsModel } } as any
  );
}

describe('PostsRepository.logRetryableFailure', () => {
  it('prefers the bound integration platform, and never touches Post.state', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      organizationId: 'org1',
      providerIdentifier: 'reddit-caller-label',
      integration: { providerIdentifier: 'reddit' },
    });
    const update = vi.fn();
    const create = vi.fn().mockResolvedValue({});
    const repo = createRepo({ findUnique, update }, { create });

    await repo.logRetryableFailure('p1', 'x', 'signed out');

    expect(create).toHaveBeenCalledWith({
      data: {
        message: 'signed out',
        organizationId: 'org1',
        platform: 'reddit',
        postId: 'p1',
        body: '',
      },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('falls back to providerIdentifier when there is no bound integration', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      organizationId: 'org1',
      providerIdentifier: 'quora',
      integration: null,
    });
    const create = vi.fn().mockResolvedValue({});
    const repo = createRepo({ findUnique }, { create });

    await repo.logRetryableFailure('p1', 'x', 'rate limited');

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ platform: 'quora' }),
    });
  });

  it('falls back to the caller-supplied platform as a last resort', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      organizationId: 'org1',
      providerIdentifier: null,
      integration: null,
    });
    const create = vi.fn().mockResolvedValue({});
    const repo = createRepo({ findUnique }, { create });

    await repo.logRetryableFailure('p1', 'devto', 'network error');

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ platform: 'devto' }),
    });
  });

  it('does nothing when the post cannot be found', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const create = vi.fn();
    const repo = createRepo({ findUnique }, { create });

    await repo.logRetryableFailure('missing', 'x', 'boom');

    expect(create).not.toHaveBeenCalled();
  });

  it('swallows an Errors.create failure — a failed log must never throw', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      organizationId: 'org1',
      providerIdentifier: 'x',
      integration: null,
    });
    const create = vi.fn().mockRejectedValue(new Error('db down'));
    const repo = createRepo({ findUnique }, { create });

    await expect(
      repo.logRetryableFailure('p1', 'x', 'boom')
    ).resolves.toBeUndefined();
  });
});

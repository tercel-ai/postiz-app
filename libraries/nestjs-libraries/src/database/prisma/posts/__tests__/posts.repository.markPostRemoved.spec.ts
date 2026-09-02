import { describe, expect, it, vi } from 'vitest';
import { PostsRepository } from '../posts.repository';

// markPostRemoved is the single write this whole path makes: `state` is
// deliberately left untouched (PUBLISHED stays PUBLISHED — see the field's
// own comment on the Post model for why ERROR/DRAFT are each wrong here, the
// same reasoning as EngageSentReply.removedAt's sibling on the engage side).
function createRepo(model: Record<string, any>) {
  return new PostsRepository(
    { model: { post: model } } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
}

describe('PostsRepository.markPostRemoved', () => {
  it('stamps removedAt and removedReason, leaving state untouched', async () => {
    const update = vi.fn().mockResolvedValue({});
    const repo = createRepo({ update });

    await repo.markPostRemoved('p1', 'removed', null);

    expect(update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { removedAt: expect.any(Date), removedReason: 'removed' },
    });
  });

  it('sets releaseURL when the extension captured one', async () => {
    const update = vi.fn().mockResolvedValue({});
    const repo = createRepo({ update });

    await repo.markPostRemoved(
      'p1',
      'gone',
      'https://www.reddit.com/r/test/comments/abc/title/'
    );

    expect(update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: {
        removedAt: expect.any(Date),
        removedReason: 'gone',
        releaseURL: 'https://www.reddit.com/r/test/comments/abc/title/',
      },
    });
  });

  it('never overwrites a stored releaseURL with an empty one', async () => {
    const update = vi.fn().mockResolvedValue({});
    const repo = createRepo({ update });

    await repo.markPostRemoved('p1', 'removed', '');

    expect(update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { removedAt: expect.any(Date), removedReason: 'removed' },
    });
  });

  it('scopes the write to id only, no organizationId re-check', async () => {
    // Mirrors changeState just above it: the caller (markExtensionPostRemoved,
    // via getPostById(id, org)) is expected to have already org-scoped the
    // read that led here.
    const update = vi.fn().mockResolvedValue({});
    const repo = createRepo({ update });

    await repo.markPostRemoved('p1', 'removed', null);

    expect(update.mock.calls[0][0].where).toEqual({ id: 'p1' });
  });
});

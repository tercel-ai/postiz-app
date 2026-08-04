import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostsService } from '../posts.service';

// Smallest viable PostsService — markPublishFailedFromExtension only touches
// the repository (getPostById + changeState).
function makeService(post: any) {
  const repo: any = {
    getPostById: vi.fn().mockResolvedValue(post),
    changeState: vi.fn().mockResolvedValue({}),
  };
  const svc = new PostsService(
    repo,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  return { svc, repo };
}

describe('PostsService.markPublishFailedFromExtension', () => {
  beforeEach(() => vi.clearAllMocks());

  it('flips a QUEUE post to ERROR with the reported reason', async () => {
    const { svc, repo } = makeService({ id: 'p1', state: 'QUEUE' });

    const r = await svc.markPublishFailedFromExtension(
      'org-1',
      'p1',
      'HN rejected the submission'
    );

    expect(r).toEqual({ ok: true });
    expect(repo.getPostById).toHaveBeenCalledWith('p1', 'org-1');
    expect(repo.changeState).toHaveBeenCalledWith(
      'p1',
      'ERROR',
      'HN rejected the submission'
    );
  });

  it('never touches a post that already reached PUBLISHED', async () => {
    const { svc, repo } = makeService({ id: 'p1', state: 'PUBLISHED' });

    const r = await svc.markPublishFailedFromExtension('org-1', 'p1', 'late');

    expect(r).toEqual({ ok: false, reason: 'already-published' });
    expect(repo.changeState).not.toHaveBeenCalled();
  });

  it('rejects an unknown or foreign-org post', async () => {
    const { svc, repo } = makeService(null);

    const r = await svc.markPublishFailedFromExtension('org-1', 'nope');

    expect(r).toEqual({ ok: false, reason: 'not-found' });
    expect(repo.changeState).not.toHaveBeenCalled();
  });

  it('refuses to touch a recurring original (clone-per-cycle owns its state)', async () => {
    const { svc, repo } = makeService({
      id: 'p1',
      state: 'QUEUE',
      intervalInDays: 7,
      parentPostId: null,
    });

    const r = await svc.markPublishFailedFromExtension('org-1', 'p1', 'x');

    expect(r).toEqual({ ok: false, reason: 'blocked-recurring-original' });
    expect(repo.changeState).not.toHaveBeenCalled();
  });
});

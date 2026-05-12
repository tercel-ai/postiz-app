import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PostsService } from '../posts.service';

// Smallest viable PostsService instance — only the deps changeDate touches need
// to be real, the rest can stay undefined and the test never reaches them.
function makeService(opts: {
  post?: any | null;
  startWorkflow?: ReturnType<typeof vi.fn>;
  changeDateFn?: ReturnType<typeof vi.fn>;
} = {}) {
  const repo: any = {
    getPostById: vi.fn().mockResolvedValue(opts.post ?? null),
    changeDate: opts.changeDateFn ?? vi.fn().mockResolvedValue({ id: 'post-1' }),
  };
  const svc = new PostsService(
    repo,
    {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any,
  );
  const startWorkflow = opts.startWorkflow ?? vi.fn().mockResolvedValue(undefined);
  (svc as any).startWorkflow = startWorkflow;
  return { svc, repo, startWorkflow };
}

function makePost(overrides: Partial<any> = {}) {
  return {
    id: 'post-1',
    organizationId: 'org-1',
    state: 'QUEUE',
    releaseId: null,
    publishDate: new Date(Date.now() + 60 * 60 * 1000), // 1 hour out — well clear of the 30s gate
    integration: { providerIdentifier: 'x' },
    ...overrides,
  };
}

describe('PostsService.changeDate — gates against modify-mid-publish race', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy path: rewrites publishDate and restarts the workflow', async () => {
    const post = makePost();
    const { svc, repo, startWorkflow } = makeService({ post });

    await svc.changeDate('org-1', 'post-1', '2099-01-01T00:00:00Z');

    expect(repo.changeDate).toHaveBeenCalledWith('org-1', 'post-1', '2099-01-01T00:00:00Z');
    expect(startWorkflow).toHaveBeenCalledTimes(1);
  });

  it('rejects when post does not exist', async () => {
    const { svc, repo, startWorkflow } = makeService({ post: null });

    await expect(svc.changeDate('org-1', 'missing', 'date')).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.changeDate).not.toHaveBeenCalled();
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('rejects when integration has been removed', async () => {
    const { svc, repo, startWorkflow } = makeService({
      post: makePost({ integration: null }),
    });

    await expect(svc.changeDate('org-1', 'post-1', 'date'))
      .rejects.toThrow(/Integration not found/);
    expect(repo.changeDate).not.toHaveBeenCalled();
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('rejects when post is not in QUEUE (already PUBLISHED / ERROR / DRAFT)', async () => {
    const { svc, repo, startWorkflow } = makeService({
      post: makePost({ state: 'PUBLISHED' }),
    });

    await expect(svc.changeDate('org-1', 'post-1', 'date')).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.changeDate).not.toHaveBeenCalled();
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('claim gate: rejects when releaseId is a claim token (workflow already publishing)', async () => {
    const { svc, repo, startWorkflow } = makeService({
      post: makePost({ releaseId: 'claim_2026-05-12T15:00:00.000Z_abc123' }),
    });

    await expect(svc.changeDate('org-1', 'post-1', 'date'))
      .rejects.toThrow(/being published/);
    expect(repo.changeDate).not.toHaveBeenCalled();
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('window gate: rejects when publishDate is within 30s', async () => {
    const { svc, repo, startWorkflow } = makeService({
      post: makePost({ publishDate: new Date(Date.now() + 10_000) }), // 10s away
    });

    await expect(svc.changeDate('org-1', 'post-1', 'date'))
      .rejects.toThrow(/too late to reschedule/);
    expect(repo.changeDate).not.toHaveBeenCalled();
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('window gate: rejects when publishDate is in the past', async () => {
    const { svc } = makeService({
      post: makePost({ publishDate: new Date(Date.now() - 10_000) }),
    });

    await expect(svc.changeDate('org-1', 'post-1', 'date'))
      .rejects.toThrow(/too late to reschedule/);
  });

  it('window gate: allows reschedule exactly at the 30s boundary + a small margin', async () => {
    const { svc, repo, startWorkflow } = makeService({
      post: makePost({ publishDate: new Date(Date.now() + 31_000) }),
    });

    await expect(svc.changeDate('org-1', 'post-1', 'date')).resolves.toBeDefined();
    expect(repo.changeDate).toHaveBeenCalled();
    expect(startWorkflow).toHaveBeenCalled();
  });

  // Pin the boundary semantics: comparison is strict `<`, so msToPublish === 30_000
  // passes the gate. If anyone flips this to `<=`, this test catches it.
  // Uses fake timers because dayjs() under the hood uses `new Date()`, which
  // a `Date.now` spy cannot intercept.
  it('window gate: 29s away is rejected, 30s+ is allowed (boundary)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T15:00:00.000Z'));
    const fixedNow = Date.now();

    try {
      const inside = makeService({
        post: makePost({ publishDate: new Date(fixedNow + 29_000) }),
      });
      await expect(inside.svc.changeDate('org-1', 'post-1', 'date'))
        .rejects.toThrow(/too late to reschedule/);

      const onBoundary = makeService({
        post: makePost({ publishDate: new Date(fixedNow + 30_000) }),
      });
      await expect(onBoundary.svc.changeDate('org-1', 'post-1', 'date'))
        .resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('startWorkflow generic failure → BadRequestException (no longer swallowed silently)', async () => {
    const { svc } = makeService({
      post: makePost(),
      startWorkflow: vi.fn().mockRejectedValue(new Error('temporal unavailable')),
    });

    await expect(svc.changeDate('org-1', 'post-1', 'date'))
      .rejects.toThrow(/Reschedule failed/);
  });
});

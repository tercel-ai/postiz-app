import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { EngageRepository } from '../engage.repository';
import { EngageService } from '../engage.service';
import { ReportReplyFailedDto } from '../dtos/engage.dto';
import { EngageController } from '@gitroom/backend/api/routes/engage.controller';

function buildRepo(state = 'QUEUE', releaseURL: string | null = null, projectId: string | null = 'proj-1') {
  const post = {
    state,
    releaseURL,
    error: null as string | null,
    deletedAt: null,
    releaseId: 'old-lease' as string | null,
    claimedAt: new Date('2026-10-08T00:00:00Z'),
  };
  const sentFindFirst = vi.fn(async (args: any) => {
    if (args.where.organizationId !== 'org-1') return null;
    return {
      id: 'r1', postId: 'p1', projectId, opportunityId: 'o1', post,
      opportunity: { externalPostUrl: 'https://dev.to/example/article-123' },
    };
  });
  const sentFindMany = vi.fn(async (args: any) => {
    if (args.where.post.state) {
      return post.state === args.where.post.state ? [{ postId: 'p1' }] : [];
    }
    return post.releaseId === args.where.post.releaseId ? [{
      id: 'r1', projectId, opportunity: { id: 'o1', platform: 'devto', externalPostUrl: 'https://dev.to/example/article-123' },
      post: { content: 'a reply' },
    }] : [];
  });
  const postUpdateMany = vi.fn(async (args: any) => {
    const states = typeof args.where.state === 'string' ? [args.where.state] : args.where.state.in;
    if (!states.includes(post.state)) return { count: 0 };
    if ('releaseURL' in args.where && post.releaseURL !== args.where.releaseURL) return { count: 0 };
    Object.assign(post, args.data);
    return { count: 1 };
  });
  const oppUpdateMany = vi.fn(async (_args: any) => ({ count: 1 }));
  const tx = {
    engageSentReply: { findFirst: sentFindFirst, findMany: sentFindMany },
    post: { updateMany: postUpdateMany },
    engageOpportunityState: { updateMany: oppUpdateMany },
  };
  const transaction = vi.fn(async (fn: (client: any) => Promise<unknown>) => fn(tx));
  const repo = new EngageRepository(
    {} as any, {} as any, {} as any, {} as any, { model: tx } as any,
    { model: tx } as any, {} as any, {} as any, { model: tx } as any,
    { model: { $transaction: transaction } } as any, {} as any, {} as any, {} as any
  );
  return { repo, post, sentFindFirst, sentFindMany, postUpdateMany, oppUpdateMany, transaction };
}

describe('manual failure persistence', () => {
  it.each(['DRAFT', 'QUEUE', 'ERROR'])('closes a %s reply, saves its reason and dismisses only its project opportunity', async (state) => {
    const { repo, post, oppUpdateMany, transaction } = buildRepo(state);
    await repo.closeManuallyFailedReply('org-1', 'r1', 'The article is unavailable.');
    expect(post.state).toBe('ERROR');
    expect(post.error).toBe('Manually marked failed: The article is unavailable.');
    expect(post.releaseId).toBeNull();
    expect(post.claimedAt).toEqual(new Date('2026-10-08T00:00:00Z'));
    expect(transaction).toHaveBeenCalledOnce();
    expect(oppUpdateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', projectId: 'proj-1', opportunityId: 'o1', status: { not: 'REPLIED' } },
      data: { status: 'DISMISSED' },
    });
  });

  it('is idempotent and returns the manual decision in subsequent status reads', async () => {
    const { repo } = buildRepo();
    await repo.closeManuallyFailedReply('org-1', 'r1', 'Stop retrying.');
    await repo.closeManuallyFailedReply('org-1', 'r1', 'Stop retrying.');
    expect(await repo.getSentReplyStatus('org-1', 'r1')).toMatchObject({
      state: 'ERROR', manuallyFailed: true, manualFailureReason: 'Stop retrying.',
    });
  });

  it('does not offer the manually failed reply on the next day', async () => {
    const { repo } = buildRepo();
    await repo.closeManuallyFailedReply('org-1', 'r1', 'Stop retrying.');
    const due = await repo.claimDueEngageReplies('org-1', 'proj-1', 'devto', {
      limit: 1, leaseToken: 'next-day', now: new Date('2026-10-09T00:00:00Z'),
      leaseCutoff: new Date('2026-10-08T23:30:00Z'),
    });
    expect(due).toEqual([]);
  });

  it('keeps ordinary failures retryable on the next day', async () => {
    const { repo } = buildRepo();
    await repo.recordReplyAttemptFailure('org-1', 'r1', 'Temporarily signed out.');
    const due = await repo.claimDueEngageReplies('org-1', 'proj-1', 'devto', {
      limit: 1, leaseToken: 'next-day', now: new Date('2026-10-09T00:00:00Z'),
      leaseCutoff: new Date('2026-10-08T23:30:00Z'),
    });
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe('r1');
  });

  it('refuses another organization without making any writes', async () => {
    const { repo, postUpdateMany, oppUpdateMany } = buildRepo();
    await expect(repo.closeManuallyFailedReply('org-2', 'r1', 'Stop retrying.')).rejects.toBeInstanceOf(NotFoundException);
    expect(postUpdateMany).not.toHaveBeenCalled();
    expect(oppUpdateMany).not.toHaveBeenCalled();
  });

  it.each([['PUBLISHED', null], ['QUEUE', 'https://dev.to/comment/1']] as const)(
    'does not overwrite a published reply (%s, %s)', async (state, url) => {
      const { repo, post, oppUpdateMany } = buildRepo(state, url);
      await expect(repo.closeManuallyFailedReply('org-1', 'r1', 'Stop retrying.')).rejects.toBeInstanceOf(ConflictException);
      expect(post.state).toBe(state);
      expect(post.error).toBeNull();
      expect(oppUpdateMany).not.toHaveBeenCalled();
    }
  );

  it('handles the legacy null-project scope explicitly', async () => {
    const { repo, oppUpdateMany } = buildRepo('QUEUE', null, null);
    await repo.closeManuallyFailedReply('org-1', 'r1', 'Stop retrying.');
    expect(oppUpdateMany.mock.calls[0][0].where.projectId).toBeNull();
  });
});

describe('manual failure API contract', () => {
  const org = { id: 'org-1' } as any;
  function build() {
    const close = vi.fn(async () => undefined);
    const repo = { closeManuallyFailedReply: close } as any;
    const service = new EngageService(repo, {} as any, {} as any, {} as any, {} as any);
    return { service, close };
  }

  it('acknowledges termination only after the repository has persisted it', async () => {
    const { service, close } = build();
    expect(await service.closeManuallyFailedReply(org, 'r1', ' Stop retrying. ')).toEqual({
      ok: true, terminal: true, state: 'ERROR',
    });
    expect(close).toHaveBeenCalledWith('org-1', 'r1', 'Stop retrying.');
  });

  it('propagates persistence failure instead of acknowledging a closure', async () => {
    const { service, close } = build();
    close.mockRejectedValue(new ConflictException('Already published'));
    await expect(service.closeManuallyFailedReply(org, 'r1', 'Stop retrying.')).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([' ', 'x'.repeat(501)])('requires a bounded nonblank reason', async (reason) => {
    const { service, close } = build();
    await expect(service.closeManuallyFailedReply(org, 'r1', reason)).rejects.toBeInstanceOf(BadRequestException);
    expect(close).not.toHaveBeenCalled();
  });

  it('routes an explicit terminal report to closure instead of retryable telemetry', async () => {
    const service = {
      closeManuallyFailedReply: vi.fn(async () => ({ ok: true, terminal: true, state: 'ERROR' })),
      reportReplyFailed: vi.fn(),
    };
    const controller = new EngageController(service as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const result = await controller.reportReplyFailed(org, 'r1', { terminal: true, source: 'manual', reason: 'Stop retrying.' });
    expect(service.closeManuallyFailedReply).toHaveBeenCalledWith(org, 'r1', 'Stop retrying.');
    expect(service.reportReplyFailed).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, terminal: true, state: 'ERROR' });
  });

  it('rejects string booleans rather than accidentally closing ordinary failures', async () => {
    const dto = Object.assign(new ReportReplyFailedDto(), { terminal: 'true', reason: 'A transient failure.' });
    expect((await validate(dto)).some((error) => error.property === 'terminal')).toBe(true);
  });
});

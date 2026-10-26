import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { EngageRepository } from '../engage.repository';
import { EngageService } from '../engage.service';
import { ReportReplyFailedDto } from '../dtos/engage.dto';
import { EngageController } from '@gitroom/backend/api/routes/engage.controller';
import { sendBusinessSummary } from '../../extension/send-business-summary';

function buildRepo(state = 'QUEUE', releaseURL: string | null = null, projectId: string | null = 'proj-1') {
  const post = {
    id: 'p1', organizationId: 'org-1', projectId,
    sendIntentId: null as string | null, parentPostId: null,
    state,
    releaseURL,
    error: null as string | null,
    deletedAt: null,
    releaseId: 'old-lease' as string | null,
    claimedAt: new Date('2026-10-08T00:00:00Z'),
  };
  const intent = {
    id: 'intent-1', organizationId: 'org-1', projectId, rootPostId: 'p1', action: 'REPLY',
    status: 'FAILED_FINAL', activeExecutionId: null as string | null, hasConfirmedSegments: false, revision: 1,
  };
  const executions = [{ id: 'execution-1', status: 'FAILED_FINAL' }];
  const segments = [{ executionId: 'execution-1', postId: 'p1', status: 'NOT_SUBMITTED' }];
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
    if ('sendIntentId' in args.where && post.sendIntentId !== args.where.sendIntentId) return { count: 0 };
    if ('releaseURL' in args.where && post.releaseURL !== args.where.releaseURL) return { count: 0 };
    Object.assign(post, args.data);
    return { count: 1 };
  });
  const oppUpdateMany = vi.fn(async (_args: any) => ({ count: 1 }));
  const tx = {
    engageSentReply: { findFirst: sentFindFirst, findMany: sentFindMany },
    post: { findFirst: vi.fn(async () => post), updateMany: postUpdateMany },
    engageOpportunityState: { updateMany: oppUpdateMany },
    sendIntent: {
      findFirst: vi.fn(async () => intent),
      updateMany: vi.fn(async (args: any) => {
        Object.assign(intent, args.data, { revision: intent.revision + 1 });
        return { count: 1 };
      }),
    },
    sendExecution: { findMany: vi.fn(async () => executions) },
    sendSegment: { findMany: vi.fn(async () => segments) },
    accountWriteState: { findFirst: vi.fn(async () => null) },
  };
  const transaction = vi.fn(async (fn: (client: any) => Promise<unknown>) => fn(tx));
  const repo = new EngageRepository(
    {} as any, {} as any, {} as any, {} as any, { model: tx } as any,
    { model: tx } as any, {} as any, {} as any, { model: tx } as any,
    { model: { $transaction: transaction } } as any, {} as any, {} as any, {} as any
  );
  return { repo, post, intent, executions, segments, tx, sentFindFirst, sentFindMany, postUpdateMany, oppUpdateMany, transaction };
}

describe('manual failure persistence', () => {
  it.each([false, true])('preserves legacy uncertainty without captured receipts (send modes enabled: %s)', async withModes => {
    const { repo, post, tx, postUpdateMany, oppUpdateMany } = buildRepo('ERROR');
    post.releaseId = null;
    post.error = 'Send unconfirmed: Confirmation timed out. — the reply may be live on the platform, so it will NOT be re-sent.';
    const before = structuredClone(post);
    if (withModes) (repo as any)._sendModes = {
      lockIn: vi.fn(), activeLegacyPostIdsIn: vi.fn(async () => []),
    };
    await expect(repo.closeManuallyFailedReply('org-1', 'r1', 'Stop retrying.'))
      .rejects.toBeInstanceOf(ConflictException);
    expect(post).toEqual(before);
    expect(postUpdateMany).not.toHaveBeenCalled();
    expect(oppUpdateMany).not.toHaveBeenCalled();
    expect(tx.sendIntent.updateMany).not.toHaveBeenCalled();
  });

  it('scopes the linked controlled intent to the original organization, project, root and reply action', async () => {
    const { repo, post, intent, tx } = buildRepo('ERROR');
    post.sendIntentId = intent.id;
    post.releaseId = null;
    tx.sendIntent.findFirst.mockResolvedValueOnce(null as any);
    await expect(repo.closeManuallyFailedReply('org-1', 'r1', 'Stop.')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.sendIntent.findFirst).toHaveBeenCalledWith({ where: {
      id: intent.id, organizationId: 'org-1', projectId: 'proj-1', rootPostId: 'p1', action: 'REPLY',
    } });
    expect(tx.sendIntent.updateMany).not.toHaveBeenCalled();
  });

  it('serializes with captured legacy work and refuses to discard its ownership', async () => {
    const { repo, tx, postUpdateMany } = buildRepo();
    const modes = { lockIn: vi.fn(), activeLegacyPostIdsIn: vi.fn(async () => ['p1']) };
    (repo as any)._sendModes = modes;
    await expect(repo.closeManuallyFailedReply('org-1', 'r1', 'Stop.')).rejects.toBeInstanceOf(ConflictException);
    expect(modes.lockIn).toHaveBeenCalledWith(tx, 'org-1');
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it('rejects a writer held by a historical execution without releasing its account', async () => {
    const { repo, post, intent, tx } = buildRepo('ERROR');
    post.sendIntentId = intent.id;
    post.releaseId = null;
    tx.accountWriteState.findFirst.mockResolvedValueOnce({ id: 'writer-1' } as any);
    await expect(repo.closeManuallyFailedReply('org-1', 'r1', 'Stop.')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.sendIntent.updateMany).not.toHaveBeenCalled();
  });

  it('rejects confirmed evidence in an earlier execution, not only the latest one', async () => {
    const { repo, post, intent, executions, segments, tx } = buildRepo('ERROR');
    post.sendIntentId = intent.id;
    post.releaseId = null;
    executions.push({ id: 'old-execution', status: 'FAILED_FINAL' });
    segments.push({ executionId: 'old-execution', postId: 'p1', status: 'CONFIRMED' });
    await expect(repo.closeManuallyFailedReply('org-1', 'r1', 'Stop.')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.sendIntent.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a concurrent intent change instead of acknowledging a manual closure', async () => {
    const { repo, post, intent, tx, postUpdateMany } = buildRepo('ERROR');
    post.sendIntentId = intent.id;
    post.releaseId = null;
    tx.sendIntent.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(repo.closeManuallyFailedReply('org-1', 'r1', 'Stop.')).rejects.toBeInstanceOf(ConflictException);
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it('closes a controlled definitely unsubmitted reply and prevents coordinator retry', async () => {
    const { repo, post, intent, transaction, tx } = buildRepo('ERROR');
    post.sendIntentId = intent.id;
    post.releaseId = null;
    await repo.closeManuallyFailedReply('org-1', 'r1', 'Only group members can comment.');
    expect(post).toMatchObject({ state: 'ERROR', error: 'Manually marked failed: Only group members can comment.' });
    expect(intent.status).toBe('CANCELLED');
    expect(sendBusinessSummary(post, intent, [], [], null, true).allowedActions.retry.allowed).toBe(false);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    expect(tx.sendExecution.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'org-1', sendIntentId: intent.id } }));
    expect(tx.sendIntent.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: intent.id, organizationId: 'org-1', revision: 1 }),
      data: { status: 'CANCELLED', revision: { increment: 1 } },
    }));
    await repo.closeManuallyFailedReply('org-1', 'r1', 'Only group members can comment.');
    expect(intent.status).toBe('CANCELLED');
  });

  it('cancels an unclaimed controlled queue without creating or releasing an execution', async () => {
    const { repo, post, intent, executions, segments } = buildRepo('QUEUE');
    post.sendIntentId = intent.id;
    post.releaseId = null;
    intent.status = 'QUEUED';
    executions.length = 0;
    segments.length = 0;
    await repo.closeManuallyFailedReply('org-1', 'r1', 'Do not send this reply.');
    expect(post.state).toBe('ERROR');
    expect(intent.status).toBe('CANCELLED');
  });

  it('closes a failed reply with an expired never-authorized historical reservation', async () => {
    const { repo, post, intent, executions, segments } = buildRepo('ERROR');
    post.sendIntentId = intent.id;
    post.releaseId = null;
    executions.push({ id: 'expired-reservation', status: 'EXPIRED' });
    segments.push({ executionId: 'expired-reservation', postId: 'p1', status: 'PENDING' });
    const history = structuredClone({ executions, segments });

    await repo.closeManuallyFailedReply('org-1', 'r1', 'Stop this reply.');

    expect(intent.status).toBe('CANCELLED');
    expect(post.error).toBe('Manually marked failed: Stop this reply.');
    expect({ executions, segments }).toEqual(history);
    await repo.closeManuallyFailedReply('org-1', 'r1', 'Stop this reply.');
    expect(intent.status).toBe('CANCELLED');
  });

  it.each(['AUTHORIZED', 'UNKNOWN', 'CONFIRMED'])(
    'does not discard %s evidence from an expired historical execution', async status => {
      const { repo, post, intent, executions, segments, tx } = buildRepo('ERROR');
      post.sendIntentId = intent.id;
      post.releaseId = null;
      executions.push({ id: 'expired-reservation', status: 'EXPIRED' });
      segments.push({ executionId: 'expired-reservation', postId: 'p1', status });

      await expect(repo.closeManuallyFailedReply('org-1', 'r1', 'Stop.')).rejects.toBeInstanceOf(ConflictException);
      expect(tx.sendIntent.updateMany).not.toHaveBeenCalled();
    }
  );

  it.each([
    { startedAt: new Date('2026-10-08T00:00:00Z') },
    { authorizedAt: new Date('2026-10-08T00:00:00Z') },
    { permitHash: 'permit' },
    { submitBefore: new Date('2026-10-08T00:01:00Z') },
    { confirmedAt: new Date('2026-10-08T00:00:00Z') },
    { result: { platformId: 'published' } },
  ])('rejects expired pending history with submission evidence: %j', async evidence => {
    const { repo, post, intent, executions, segments, tx } = buildRepo('ERROR');
    post.sendIntentId = intent.id;
    post.releaseId = null;
    executions.push({ id: 'expired-reservation', status: 'EXPIRED', ...('startedAt' in evidence ? evidence : {}) } as any);
    segments.push({ executionId: 'expired-reservation', postId: 'p1', status: 'PENDING', ...evidence } as any);

    await expect(repo.closeManuallyFailedReply('org-1', 'r1', 'Stop.')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.sendIntent.updateMany).not.toHaveBeenCalled();
  });

  it.each(['RESERVED', 'SENDING', 'RECONCILING', 'SUCCEEDED'])(
    'refuses a controlled %s task without changing its post or receipts', async status => {
      const { repo, post, intent, tx, oppUpdateMany } = buildRepo('QUEUE');
      post.sendIntentId = intent.id;
      post.releaseId = null;
      intent.status = status;
      await expect(repo.closeManuallyFailedReply('org-1', 'r1', 'Stop.')).rejects.toBeInstanceOf(ConflictException);
      expect(tx.sendIntent.updateMany).not.toHaveBeenCalled();
      expect(post.error).toBeNull();
      expect(oppUpdateMany).not.toHaveBeenCalled();
    }
  );

  it.each(['AUTHORIZED', 'UNKNOWN', 'CONFIRMED', 'PENDING'])(
    'retains a failed controlled intent with an unsafe %s segment', async status => {
      const { repo, post, intent, segments, tx } = buildRepo('ERROR');
      post.sendIntentId = intent.id;
      post.releaseId = null;
      segments[0].status = status;
      await expect(repo.closeManuallyFailedReply('org-1', 'r1', 'Stop.')).rejects.toBeInstanceOf(ConflictException);
      expect(tx.sendIntent.updateMany).not.toHaveBeenCalled();
      expect(post.error).toBeNull();
    }
  );

  it('refuses an active writer even when its intent says FAILED_FINAL', async () => {
    const { repo, post, intent, tx } = buildRepo('ERROR');
    post.sendIntentId = intent.id;
    post.releaseId = null;
    intent.activeExecutionId = 'execution-1';
    await expect(repo.closeManuallyFailedReply('org-1', 'r1', 'Stop.')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.sendIntent.updateMany).not.toHaveBeenCalled();
  });

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

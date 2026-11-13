import { describe, expect, it, vi } from 'vitest';
import { EngageRepository } from '../engage.repository';
import { EngageService } from '../engage.service';
import { memorySendDatabase } from '../../extension/__tests__/support/memory-send-database';

function fixture(overrides: Record<string, unknown> = {}) {
  const db = memorySendDatabase();
  db.seed('post', { id: 'post', organizationId: 'org', projectId: null, state: 'DRAFT',
    content: 'original evidence', error: 'original failure', releaseURL: null,
    executionProtocol: 'LEGACY', sendOrigin: 'MANUAL', integrationId: 'account',
    settings: '{}', ...overrides });
  db.seed('engageSentReply', { id: 'reply', organizationId: 'org', projectId: null,
    opportunityId: 'opportunity', postId: 'post', inputData: { original: true },
    post: structuredClone(db.rows('post')[0]), opportunity: { platform: 'reddit' } });
  const model = { model: db } as any;
  const repo = new EngageRepository(model, model, model, model, model, model, model,
    model, model, model, model, model, model);
  const claim = vi.spyOn(repo, 'claimOpportunityForReply').mockResolvedValue({} as any);
  const snapshot = vi.spyOn(repo, 'snapshotSentReplyMatchedKeywords').mockResolvedValue(undefined);
  const billing = { deductIfOverage: vi.fn(async () => undefined) };
  const service = new EngageService(repo, { client: undefined } as any, {} as any,
    billing as any, {} as any);
  return { db, repo, service, claim, snapshot, billing };
}

const quarantined = { executionProtocol: 'LEGACY_QUARANTINED', deletedAt: new Date('2026-11-01') };

describe('legacy reply quarantine fences', () => {
  it.each([
    quarantined,
    { executionProtocol: 'LEGACY_QUARANTINED', deletedAt: null },
    { executionProtocol: 'LEGACY', deletedAt: new Date('2026-11-01') },
    { executionProtocol: 'ACCOUNT_BOUND_V1', sendIntentId: 'intent' },
    { executionProtocol: 'ACCOUNT_BOUND_V1', sendIntentId: null },
  ])('refuses a late publish callback before all side effects: %j', async overrides => {
    const { db, repo, service, claim, snapshot, billing } = fixture(overrides);
    const update = vi.spyOn(repo, 'updateReplyUrl');
    const original = structuredClone(db.rows('post')[0]);
    await expect(service.publishExtensionReply({ id: 'org' } as any, 'user', 'reply', null))
      .rejects.toThrow();
    expect(db.rows('post')[0]).toEqual(original);
    expect(update).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(billing.deductIfOverage).not.toHaveBeenCalled();
  });

  it('rechecks quarantine at the publish write after the context read, without claiming or billing', async () => {
    const { db, repo, service, claim, snapshot, billing } = fixture();
    const update = repo.updateReplyUrl.bind(repo);
    vi.spyOn(repo, 'updateReplyUrl').mockImplementation(async (...args) => {
      Object.assign(db.rows('post')[0], quarantined);
      return update(...args);
    });
    await expect(service.publishExtensionReply({ id: 'org' } as any, 'user', 'reply', null))
      .rejects.toThrow();
    expect(db.rows('post')[0]).toMatchObject({ ...quarantined, state: 'DRAFT', content: 'original evidence', error: 'original failure' });
    expect(claim).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(billing.deductIfOverage).not.toHaveBeenCalled();
  });

  it.each([null, 'LEGACY'])('preserves live %s legacy publish callbacks', async executionProtocol => {
    const { db, service, billing } = fixture({ executionProtocol });
    await service.publishExtensionReply({ id: 'org' } as any, 'user', 'reply', null);
    expect(db.rows('post')[0].state).toBe('PUBLISHED');
    expect(billing.deductIfOverage).toHaveBeenCalledOnce();
  });

  it.each([quarantined, { executionProtocol: 'LEGACY_QUARANTINED', deletedAt: null },
    { deletedAt: new Date('2026-11-01') }, { executionProtocol: 'ACCOUNT_BOUND_V1' },
    { organizationId: 'other-org' }])('does not annotate or close a protected post: %j', async overrides => {
    const { db, repo } = fixture(overrides);
    const original = structuredClone(db.rows('post')[0]);
    await expect(repo.recordReplyAttemptFailure('org', 'reply', 'late failure')).resolves.toEqual({ recorded: false });
    await expect(repo.closeUnconfirmedReply('org', 'reply', 'late uncertainty')).resolves.toEqual({ closed: false });
    expect(db.rows('post')[0]).toEqual(original);
  });

  it.each([null, 'LEGACY'])('still annotates and closes live %s legacy drafts', async executionProtocol => {
    const { repo, db } = fixture({ executionProtocol });
    await expect(repo.recordReplyAttemptFailure('org', 'reply', 'network')).resolves.toEqual({ recorded: true });
    await expect(repo.closeUnconfirmedReply('org', 'reply', 'uncertain')).resolves.toEqual({ closed: true });
    expect(db.rows('post')[0].state).toBe('ERROR');
  });

  it.each([quarantined, { executionProtocol: 'LEGACY_QUARANTINED', deletedAt: null },
    { deletedAt: new Date('2026-11-01') }])('saving another draft preserves archived content: %j', async overrides => {
    const { db, repo } = fixture(overrides);
    const original = structuredClone(db.rows('post')[0]);
    await repo.upsertDraft('org', 'opportunity', { platform: 'reddit', content: 'new draft', inputData: {} });
    expect(db.rows('post').find(post => post.id === 'post')).toEqual(original);
    expect(db.rows('post').filter(post => post.content === 'new draft')).toHaveLength(1);
    expect(db.rows('engageSentReply').find(reply => reply.id === 'reply').inputData).toEqual({ original: true });
  });

  it('rechecks draft eligibility atomically if quarantine races the lookup', async () => {
    const { db, repo } = fixture();
    const originalUpdate = db.post.update;
    (repo as any)._tx = { model: { $transaction: async (work: any) => work({
      engageSentReply: db.engageSentReply,
      post: { ...db.post, update: async (args: any) => {
        Object.assign(db.rows('post')[0], quarantined);
        return originalUpdate(args);
      } },
    }) } };
    await expect(repo.upsertDraft('org', 'opportunity', { platform: 'reddit', content: 'overwrite', inputData: {} }))
      .rejects.toThrow();
    expect(db.rows('post')[0]).toMatchObject({ ...quarantined, content: 'original evidence' });
    expect(db.rows('engageSentReply')[0].inputData).toEqual({ original: true });
  });

  it.each([null, 'LEGACY'])('retains live %s manual draft reuse', async executionProtocol => {
    const { db, repo } = fixture({ executionProtocol });
    await repo.upsertDraft('org', 'opportunity', { platform: 'reddit', content: 'edited draft', inputData: {} });
    expect(db.rows('post')).toHaveLength(1);
    expect(db.rows('post')[0].content).toBe('edited draft');
  });

  it.each(['gone', 'disabled'])('does not close an archived row when a %s report races selection', async kind => {
    const { db, repo } = fixture({ state: 'QUEUE' });
    db.seed('engageOpportunity', { id: 'opportunity', repliesDisabledAt: null });
    const originalUpdate = db.post.updateMany;
    (repo as any)._tx = { model: { $transaction: async (work: any) => work({
      engageOpportunity: db.engageOpportunity,
      post: { updateMany: async (args: any) => {
        Object.assign(db.rows('post')[0], { executionProtocol: 'LEGACY_QUARANTINED' });
        return originalUpdate(args);
      } },
    }) } };
    const result = kind === 'gone'
      ? await repo.markOpportunityTargetGone('org', 'opportunity', 'gone', false)
      : await repo.markOpportunityRepliesDisabled('org', 'opportunity', 'disabled');
    expect(result.repliesClosed).toBe(0);
    expect(db.rows('post')[0]).toMatchObject({ executionProtocol: 'LEGACY_QUARANTINED', state: 'QUEUE', error: 'original failure' });
  });

  it('rejects late background author enrichment after quarantine', async () => {
    const { db, repo } = fixture();
    Object.assign(db.rows('post')[0], quarantined);
    const original = structuredClone(db.rows('post')[0]);
    await expect(repo.updateReplyAuthor('org', 'reply', { handle: 'late-author' })).rejects.toThrow();
    expect(db.rows('post')[0]).toEqual(original);
  });

  it.each([null, 'LEGACY'])('retains live %s legacy author enrichment', async executionProtocol => {
    const { db, repo } = fixture({ executionProtocol });
    await repo.updateReplyAuthor('org', 'reply', { handle: 'actual-author' });
    expect(JSON.parse(db.rows('post')[0].settings).engageAuthor).toEqual({ handle: 'actual-author' });
  });

  it('retains controlled automatic draft reuse', async () => {
    const { db, repo } = fixture({ executionProtocol: 'ACCOUNT_BOUND_V1', sendOrigin: 'AUTOMATION' });
    await repo.upsertDraft('org', 'opportunity', { platform: 'reddit', content: 'updated automatic draft', inputData: {}, coordinatedAutomatic: true });
    expect(db.rows('post')).toHaveLength(1);
    expect(db.rows('post')[0]).toMatchObject({ content: 'updated automatic draft', executionProtocol: 'ACCOUNT_BOUND_V1', sendOrigin: 'AUTOMATION' });
  });
});


function settledReplyFixture(intentOverrides: Record<string, unknown> = {}, postOverrides: Record<string, unknown> = {}) {
  const f = fixture({ projectId: 'project', state: 'PUBLISHED', executionProtocol: 'ACCOUNT_BOUND_V1',
    sendIntentId: 'intent', releaseId: 'confirmed-platform-id', publishDate: new Date('2026-11-01'),
    settings: JSON.stringify({ engageAuthor: { handle: 'confirmed-author' } }), ...postOverrides });
  f.db.rows('engageSentReply')[0].projectId = 'project';
  f.db.seed('sendIntent', { id: 'intent', organizationId: 'org', projectId: 'project', rootPostId: 'post',
    action: 'REPLY', status: 'SUCCEEDED', hasConfirmedSegments: true, ...intentOverrides });
  return f;
}

const replyUrl = 'https://www.reddit.com/r/test/comments/abc123/comment/def456/';

describe('confirmed coordinated reply URL metadata', () => {
  it.each([null, 'https://www.reddit.com/r/test/comments/abc123/comment/old456/'])('preserves manual link backfill/replacement without changing publication, attribution or settlement: %s', async releaseURL => {
    const { db, service, claim, snapshot, billing } = settledReplyFixture({}, { releaseURL });
    const posts = structuredClone(db.rows('post'));
    const intent = structuredClone(db.rows('sendIntent'));
    await service.submitManualReplyUrl({ id: 'org' } as any, 'reply', replyUrl, { handle: 'other-author' });
    expect(db.rows('post')).toEqual([{ ...posts[0], releaseURL: replyUrl }]);
    expect(db.rows('sendIntent')).toEqual(intent);
    expect(db.rows('sendExecution')).toHaveLength(0);
    expect(db.rows('accountWriteState')).toHaveLength(0);
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
    expect(claim).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(billing.deductIfOverage).not.toHaveBeenCalled();
  });

  it.each(['QUEUED', 'RESERVED', 'SENDING', 'RECONCILING', 'FAILED_FINAL', 'CANCELLED'])('does not backfill an unsettled %s intent', async status => {
    const { db, service } = settledReplyFixture({ status });
    const original = structuredClone(db.rows('post')[0]);
    await expect(service.submitManualReplyUrl({ id: 'org' } as any, 'reply', replyUrl, { handle: 'other-author' })).rejects.toThrow();
    expect(db.rows('post')[0]).toEqual(original);
  });

  it.each([
    { organizationId: 'other-org' }, { projectId: 'other-project' }, { rootPostId: 'other-post' },
    { action: 'POST' }, { hasConfirmedSegments: false }, { activeExecutionId: 'execution' },
  ])('does not backfill without matching settled reply ownership: %j', async intentOverrides => {
    const { db, service } = settledReplyFixture(intentOverrides);
    const original = structuredClone(db.rows('post')[0]);
    await expect(service.submitManualReplyUrl({ id: 'org' } as any, 'reply', replyUrl, { handle: 'other-author' })).rejects.toThrow();
    expect(db.rows('post')[0]).toEqual(original);
  });

  it('rechecks the publication and intent at the atomic metadata write', async () => {
    const { db, repo, service } = settledReplyFixture();
    const original = structuredClone(db.rows('post')[0]);
    const update = db.post.update;
    (repo as any)._post = { model: { ...db, post: { ...db.post, update: async (args: any) => {
      db.rows('sendIntent')[0].status = 'RECONCILING';
      return update(args);
    } } } };
    await expect(service.submitManualReplyUrl({ id: 'org' } as any, 'reply', replyUrl, { handle: 'other-author' })).rejects.toThrow();
    expect(db.rows('post')[0]).toEqual(original);
  });

  it.each([quarantined, { deletedAt: new Date('2026-11-01') }])('does not restore archived publication metadata: %j', async overrides => {
    const { db, service } = settledReplyFixture({}, overrides);
    const original = structuredClone(db.rows('post')[0]);
    await expect(service.submitManualReplyUrl({ id: 'org' } as any, 'reply', replyUrl, { handle: 'other-author' })).rejects.toThrow();
    expect(db.rows('post')[0]).toEqual(original);
  });

  it('keeps the legacy publication callback fenced even after successful settlement', async () => {
    const { db, repo } = settledReplyFixture();
    const original = structuredClone(db.rows('post')[0]);
    await expect(repo.updateReplyUrl('org', 'reply', replyUrl, { handle: 'other-author' }, { markPublished: true })).rejects.toThrow();
    expect(db.rows('post')[0]).toEqual(original);
  });
});

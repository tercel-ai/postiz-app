import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSend, sendNow } from './support/send-fixture';
import { SendModeService } from '../send-mode.service';
import { sendBusinessSummary } from '../send-business-summary';
import { EngageRepository } from '../../engage/engage.repository';
import { EngageService } from '../../engage/engage.service';
import { EngageController } from '../../../../../apps/backend/src/api/routes/engage.controller';
import { IntegrationsController } from '../../../../../apps/backend/src/api/routes/integrations.controller';
import { PostsController } from '../../../../../apps/backend/src/api/routes/posts.controller';
import { PostsService } from '../../database/prisma/posts/posts.service';
import { CONTROLLED_SEND_PLATFORMS } from '../controlled-platforms';
import { validateSync } from 'class-validator';
import { ClaimSendDto, EnqueueSendDto, QueueStoredReplyDto } from '../send-execution.dto';
import { SendIntentsController } from '../../../../../apps/backend/src/api/routes/send-executions.controller';
import { SendExecutionService } from '../send-execution.service';

beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());

async function draft(method: 'API' | 'EXTENSION' = 'API') {
  const fixture = setupSend();
  await fixture.create('root', method);
  fixture.bindings.resolveForEnqueueInTransaction.mockClear();
  // Restore an unqueued, saved reply without replacing its content identity.
  fixture.db.rows('sendIntent').length = 0;
  Object.assign(fixture.db.rows('post')[0], {
    sendIntentId: null, contentUnitId: null, state: 'DRAFT', source: 'engage',
    integrationId: null, accountSelectionMode: null, routeRevision: 2, contentRevision: 3,
  });
  fixture.db.seed('engageSentReply', {
    id: 'reply', organizationId: 'org', projectId: 'project', postId: 'root',
    opportunityId: 'opp', opportunity: { externalPostId: 'target', externalPostUrl: 'https://x.com/u/status/target' },
  });
  fixture.db.seed('engageOpportunityState', {
    id: 'opp-state', organizationId: 'org', projectId: 'project', opportunityId: 'opp',
    status: 'NEW', matchedKeywords: [],
  });
  return fixture;
}
const selection = {
  sentReplyId: 'reply', integrationId: 'account', requestId: 'selection-1',
  expectedRouteRevision: 2, expectedContentRevision: 3,
};

describe('saved reply enqueue contract', () => {
  it('atomically binds the same root and replays concurrent identical requests once', async () => {
    const { db, service, bindings } = await draft();
    const results = await Promise.all(Array.from({ length: 5 }, () => service.enqueueSavedReply('org', 'user', 'reply', selection)));
    expect(results.every(row => row.id === 'root')).toBe(true);
    expect(db.rows('post')).toHaveLength(1);
    expect(db.rows('engageSentReply')).toHaveLength(1);
    expect(db.rows('sendIntent')).toHaveLength(1);
    expect(db.rows('sendMutationReceipt')).toHaveLength(1);
    expect(db.rows('sendIntent')[0]).toMatchObject({ integrationId: 'account', routeRevision: 3, contentRevision: 3 });
    expect(db.rows('post')[0]).toMatchObject({ accountSelectionMode: 'EXPLICIT', routeRevision: 3 });
    expect(bindings.resolveForEnqueueInTransaction).toHaveBeenCalledTimes(1);
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
    expect(db.rows('sendExecution')).toHaveLength(0);
    expect(db.rows('engageOpportunityState')[0].status).toBe('SCHEDULED');
  });
  it('rejects competing selections without changing the frozen root or target', async () => {
    const { db, service } = await draft();
    const results = await Promise.allSettled([
      service.enqueueSavedReply('org', 'user', 'reply', selection),
      service.enqueueSavedReply('org', 'user', 'reply', { ...selection, integrationId: 'other', requestId: 'selection-2' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(db.rows('sendIntent')).toHaveLength(1);
    expect(db.rows('post')[0].integrationId).toBe('account');
  });
  it('replays a lost response after completion, but rejects a different body for that request', async () => {
    const { db, service } = await draft();
    await service.enqueueSavedReply('org', 'user', 'reply', selection);
    Object.assign(db.rows('post')[0], { state: 'PUBLISHED', releaseId: 'external' });
    db.rows('sendIntent')[0].status = 'SUCCEEDED';
    expect((await service.enqueueSavedReply('org', 'user', 'reply', selection)).state).toBe('PUBLISHED');
    await expect(service.enqueueSavedReply('org', 'user', 'reply', { ...selection, integrationId: 'other' })).rejects.toThrow('REQUEST_ID_CONFLICT');
    expect(db.rows('sendIntent')).toHaveLength(1);
  });
  it.each(['expectedRouteRevision', 'expectedContentRevision'] as const)('rejects stale %s', async field => {
    const { db, service } = await draft();
    await expect(service.enqueueSavedReply('org', 'user', 'reply', { ...selection, [field]: 1 })).rejects.toThrow('SEND_CONTENT_REVISION_CONFLICT');
    expect(db.rows('sendIntent')).toHaveLength(0);
    expect(db.rows('sendMutationReceipt')).toHaveLength(0);
    expect(db.rows('post')[0].state).toBe('DRAFT');
  });
  it('requires complete metadata only when a legacy caller supplies a request id', async () => {
    const { service } = await draft();
    await expect(service.enqueueSavedReply('org', 'user', 'reply', { sentReplyId: 'reply', integrationId: 'account', requestId: 'partial-legacy' })).rejects.toThrow('SEND_SELECTION_VERSION_REQUIRED');
  });
  it('clears the draft choice and resolves defaults when integrationId is null', async () => {
    const { db, service, bindings } = await draft();
    Object.assign(db.rows('post')[0], { integrationId: 'old', accountSelectionMode: 'EXPLICIT' });
    await service.enqueueSavedReply('org', 'user', 'reply', { ...selection, integrationId: null });
    expect(bindings.resolveForEnqueueInTransaction.mock.calls[0][5]).toBeUndefined();
    expect(db.rows('post')[0].accountSelectionMode).toBe('INHERIT');
  });
  it('supports a versioned request without a per-item account and preserves default resolution', async () => {
    const { db, service, bindings } = await draft();
    const { integrationId, ...body } = selection;
    await service.enqueueSavedReply('org', 'user', 'reply', body);
    await service.enqueueSavedReply('org', 'user', 'reply', body);
    expect(bindings.resolveForEnqueueInTransaction.mock.calls[0][5]).toBeUndefined();
    expect(db.rows('post')[0]).toMatchObject({ routeRevision: 2, accountSelectionMode: 'INHERIT' });
    expect(db.rows('sendIntent')).toHaveLength(1);
    expect(db.rows('sendMutationReceipt')).toHaveLength(1);
  });
  it('rolls back selection and target setup if project account validation fails', async () => {
    const { db, service, bindings } = await draft();
    bindings.resolveForEnqueueInTransaction.mockRejectedValueOnce(new Error('REPLY_ACCOUNT_DISABLED'));
    await expect(service.enqueueSavedReply('org', 'user', 'reply', selection)).rejects.toThrow('REPLY_ACCOUNT_DISABLED');
    expect(db.rows('post')[0]).toMatchObject({ routeRevision: 2, settings: '{}', state: 'DRAFT' });
    expect(db.rows('sendIntent')).toHaveLength(0);
    expect(db.rows('engageOpportunityState')[0].status).toBe('NEW');
  });
  it('enforces organization membership, record scope and project activation even for an existing intent', async () => {
    const { service, projects, db } = await draft();
    await expect(service.enqueueSavedReply('other-org', 'user', 'reply', selection)).rejects.toThrow('ORGANIZATION_MEMBERSHIP_REQUIRED');
    await expect(service.enqueueSavedReply('org', 'user', 'missing', selection)).rejects.toThrow('SAVED_REPLY_NOT_FOUND');
    await service.enqueueSavedReply('org', 'user', 'reply', selection);
    projects.assertProjectActive.mockRejectedValueOnce(new Error('PROJECT_INACTIVE'));
    await expect(service.enqueueSavedReply('org', 'user', 'reply')).rejects.toThrow('PROJECT_INACTIVE');
    db.rows('userOrganization')[0].disabled = true;
    await expect(service.enqueueSavedReply('org', 'user', 'reply', selection)).rejects.toThrow('ORGANIZATION_MEMBERSHIP_REQUIRED');
  });
});

describe('simple saved reply business idempotency', () => {
  it.each(['administrator', 'original-user', 'original-user-older-receipt', 'original-user-missing-claim-time'])(
    'recovers an unbound claim as %s, then enqueues the same saved reply exactly once', async role => {
    const { service, db } = await draft();
    db.rows('userOrganization')[0].role = role === 'administrator' ? 'ADMIN' : 'USER';
    const post = db.rows('post')[0];
    Object.assign(post, { executionProtocol: 'LEGACY', state: 'QUEUE', publishMethod: 'EXTENSION',
      releaseId: 'historical-claim', claimedAt: sendNow });
    db.seed('engageOpportunity', { id: 'opp', platform: 'x', externalPostId: 'target', externalPostUrl: 'https://x.com/u/status/target' });
    db.seed('sendMutationReceipt', { id: 'proof', organizationId: 'org', userId: 'old-browser',
      operation: 'autonomous-side-effect', requestId: 'proof-request', requestHash: 'old-hash',
      result: { source: 'BROWSER', platform: 'x', browserUserId: 'old-browser', integrationId: 'browser:old-browser:x',
        action: 'COMMENT', postIds: ['root'], recurring: false, occurrenceKey: 'single', status: 'NOT_SUBMITTED', revision: 2 } });
    await expect(service.enqueueSavedReply('org', 'user', 'reply', { sentReplyId: 'reply' }))
      .rejects.toThrow('LEGACY_CONTENT_DRAIN_REQUIRED');
    const modes = new SendModeService(db);
    const repository = Object.assign(Object.create(EngageRepository.prototype), {
      _sentReply: { model: { engageSentReply: { findFirst: async () => ({
        ...db.rows('engageSentReply')[0], post: db.rows('post')[0], opportunity: db.rows('engageOpportunity')[0],
      }) } } },
    });
    const posts = Object.assign(Object.create(PostsService.prototype), { _sendCoordinator: service });
    const engage = Object.assign(Object.create(EngageService.prototype), {
      _engageRepository: repository, _postsService: posts, _sendModes: modes,
    });
    const readStatus = () => engage.getSentReplyStatus({ id: 'org' }, 'reply', 'user');
    expect((await readStatus()).sending.allowedActions.enqueue)
      .toEqual({ allowed: false, reason: 'LEGACY_CONTENT_DRAIN_REQUIRED' });
    if (role !== 'administrator') {
      const proof = db.rows('sendMutationReceipt').find(row => row.id === 'proof');
      proof.userId = proof.result.browserUserId = 'user';
      proof.result.integrationId = 'browser:user:x';
      proof.createdAt = new Date(sendNow.getTime() + (role === 'original-user-older-receipt' ? -1000 : 1000));
      if (role === 'original-user-missing-claim-time') post.claimedAt = null;
      const diagnosis = await modes.getBrowserReplyRecovery('org', 'user', 'reply');
      expect(diagnosis).toMatchObject({ canResolve: false, canReview: true });
      await modes.resolveBrowserReplyRecovery('org', 'user', 'reply', {
        expectedOrganizationId: 'org', expectedUserId: 'user', requestId: 'recover-historical',
        expectedRecoveryRevision: diagnosis.recoveryRevision, reviewConfirmed: true,
      });
    } else {
    const diagnosis = await modes.getLegacyReplyRecovery('org', 'user', 'reply');
    expect(diagnosis.canResolve).toBe(true);
    await modes.resolveLegacyReplyRecovery('org', 'user', 'reply', {
      expectedOrganizationId: 'org', expectedUserId: 'user', requestId: 'recover-historical',
      expectedRecoveryRevision: diagnosis.recoveryRevision,
      executorStopped: true, noPendingSubmit: true, replyAbsent: true,
      evidence: 'All old workers stopped; platform target checked and reply absent.',
    });
    }
    const recovered = await readStatus();
    expect(recovered).toMatchObject({ state: 'QUEUE', sendIntentId: null, sending: {
      allowedActions: { enqueue: { allowed: true }, selectAccount: { allowed: false } },
    } });
    expect(db.rows('sendIntent')).toEqual([]);
    expect(db.rows('sendExecution')).toEqual([]);
    await service.enqueueSavedReply('org', 'user', 'reply', { sentReplyId: 'reply' });
    await service.enqueueSavedReply('org', 'user', 'reply', { sentReplyId: 'reply' });
    expect((await readStatus()).sending.allowedActions.enqueue.allowed).toBe(false);
    expect(db.rows('sendIntent')).toHaveLength(1);
    expect(db.rows('post')).toHaveLength(1);
    expect(db.rows('engageSentReply')).toHaveLength(1);
    expect(db.rows('engageOpportunityState')[0].status).toBe('SCHEDULED');
    expect(db.rows('sendExecution')).toEqual([]);
    expect(db.rows('sendQuotaReservation')).toEqual([]);
  });

  const simple = { sentReplyId: 'reply', integrationId: 'account' };

  it('accepts a real two-field controller request without frontend revisions or request ids', async () => {
    const { service, db } = await draft();
    const id = '22222222-2222-4222-8222-222222222222';
    db.rows('engageSentReply')[0].id = id;
    const body = Object.assign(new QueueStoredReplyDto(), { sentReplyId: id, integrationId: 'account' });
    expect(validateSync(body)).toEqual([]);
    const controller = new SendIntentsController({} as any, service);
    expect(await controller.reply({ id: 'org' } as any, { id: 'user' } as any, body))
      .toMatchObject({ id: 'root', state: 'QUEUE', integrationId: 'account' });
  });

  it('creates only one task for concurrent two-field requests and never reserves quota at enqueue', async () => {
    const { service, db, bindings } = await draft();
    const results = await Promise.all(Array.from({ length: 5 }, () => service.enqueueSavedReply('org', 'user', 'reply', simple)));
    expect(new Set(results.map(row => row.sendIntentId)).size).toBe(1);
    expect(db.rows('sendIntent')).toHaveLength(1);
    expect(db.rows('post')).toHaveLength(1);
    expect(db.rows('engageSentReply')).toHaveLength(1);
    expect(db.rows('post')[0]).toMatchObject({ accountSelectionMode: 'EXPLICIT', routeRevision: 3, contentRevision: 3 });
    expect(db.rows('engageOpportunityState')[0].status).toBe('SCHEDULED');
    expect(bindings.resolveForEnqueueInTransaction).toHaveBeenCalledTimes(1);
    expect(db.rows('sendExecution')).toHaveLength(0);
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
  });

  it.each([['account', 'other'], ['other', 'account']])('lets only the first of competing %s / %s account choices enqueue', async (first, second) => {
    const { service, db, bindings } = await draft();
    bindings.resolveForEnqueueInTransaction.mockImplementation(async (...args: any[]) => ({
      integrationId: args[5], canonicalAccountKey: 'account-key', providerIdentifier: 'x',
      bindingSource: 'EXPLICIT', bindingRevision: null, targetAccount: { id: '123', idNamespace: 'x.rest_id' },
    }));
    const results = await Promise.allSettled([
      service.enqueueSavedReply('org', 'user', 'reply', { ...simple, integrationId: first }),
      service.enqueueSavedReply('org', 'user', 'reply', { ...simple, integrationId: second }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { message: 'SEND_INTENT_IMMUTABLE' } });
    expect(db.rows('sendIntent')).toHaveLength(1);
    expect(db.rows('sendIntent')[0].integrationId).toBe(first);
    expect(bindings.resolveForEnqueueInTransaction).toHaveBeenCalledTimes(1);
  });

  it('uses the latest stored draft read inside admission rather than an earlier precheck snapshot', async () => {
    const { service, db } = await draft();
    // Cache the harness delegate so this spy intercepts the actual precheck read.
    const posts = db.post;
    db.post = posts;
    const read = posts.findFirst.bind(posts);
    vi.spyOn(posts, 'findFirst').mockImplementationOnce(async (query: any) => {
      const stale = await read(query);
      Object.assign(db.rows('post')[0], { content: 'Latest saved body', contentRevision: 4, routeRevision: 5 });
      return stale;
    });
    await service.enqueueSavedReply('org', 'user', 'reply', simple);
    expect(db.rows('sendIntent')[0]).toMatchObject({ contentRevision: 4, routeRevision: 6 });
    expect(db.rows('post')[0].content).toBe('Latest saved body');
  });

  it.each([undefined, null])('keeps the first resolved default frozen on replay (%s)', async integrationId => {
    const { service, db, bindings } = await draft();
    if (integrationId === null) Object.assign(db.rows('post')[0], { integrationId: 'old', accountSelectionMode: 'EXPLICIT' });
    const body = integrationId === undefined ? { sentReplyId: 'reply' } : { sentReplyId: 'reply', integrationId };
    const first = await service.enqueueSavedReply('org', 'user', 'reply', body);
    const before = structuredClone(db.rows('sendIntent')[0]);
    bindings.resolveForEnqueueInTransaction.mockRejectedValue(new Error('DEFAULT_CHANGED'));
    const replay = await service.enqueueSavedReply('org', 'user', 'reply', body);
    expect(replay.sendIntentId).toBe(first.sendIntentId);
    expect(db.rows('sendIntent')).toEqual([before]);
    expect(bindings.resolveForEnqueueInTransaction).toHaveBeenCalledTimes(1);
  });

  it('forbids clearing a frozen explicit account', async () => {
    const { service, db } = await draft();
    await service.enqueueSavedReply('org', 'user', 'reply', simple);
    await expect(service.enqueueSavedReply('org', 'user', 'reply', { sentReplyId: 'reply', integrationId: null }))
      .rejects.toThrow('SEND_INTENT_IMMUTABLE');
    expect(db.rows('post')[0]).toMatchObject({ accountSelectionMode: 'EXPLICIT', integrationId: 'account' });
    expect(db.rows('sendIntent')).toHaveLength(1);
  });

  it('replays across active members without creating another task', async () => {
    const { service, db } = await draft();
    const first = await service.enqueueSavedReply('org', 'user', 'reply', simple);
    db.seed('userOrganization', { userId: 'other-user', organizationId: 'org', disabled: false });
    const replay = await service.enqueueSavedReply('org', 'other-user', 'reply', simple);
    expect(replay.sendIntentId).toBe(first.sendIntentId);
    expect(db.rows('sendIntent')).toHaveLength(1);
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
  });

  it('does not return a stale linked task after the reply no longer matches its stored root', async () => {
    const { service, db } = await draft();
    await service.enqueueSavedReply('org', 'user', 'reply', simple);
    db.rows('post')[0].sendIntentId = 'unrelated-task';
    await expect(service.enqueueSavedReply('org', 'user', 'reply', simple)).rejects.toThrow('SEND_CONTENT_CHANGED');
    expect(db.rows('sendIntent')).toHaveLength(1);
  });

  it('does not bypass failed project/account validation when metadata is omitted', async () => {
    const { service, db, bindings } = await draft();
    bindings.resolveForEnqueueInTransaction.mockRejectedValueOnce(new Error('REPLY_ACCOUNT_DISABLED'));
    await expect(service.enqueueSavedReply('org', 'user', 'reply', simple)).rejects.toThrow('REPLY_ACCOUNT_DISABLED');
    expect(db.rows('sendIntent')).toHaveLength(0);
    expect(db.rows('post')[0]).toMatchObject({ state: 'DRAFT', routeRevision: 2 });
    expect(db.rows('engageOpportunityState')[0].status).toBe('NEW');
  });

  it('preserves held/unknown/confirmed settlement facts across repeated enqueue calls', async () => {
    vi.stubEnv('SEND_EXECUTION_CREDENTIAL_KEY', 'simple-reply-credential-key-at-least-thirty-two-characters');
    const { service, db } = await draft();
    await service.enqueueSavedReply('org', 'user', 'reply', simple);
    const execution = await service.reserveApi('org', 'root', 'worker', sendNow);
    await service.authorizeApiSegment('org', execution.id, 0, { id: '123', idNamespace: 'x.rest_id' }, sendNow);
    const facts = () => structuredClone({
      executions: db.rows('sendExecution'), segments: db.rows('sendSegment'),
      buckets: db.rows('sendQuotaBucket'), reservations: db.rows('sendQuotaReservation'),
      events: db.rows('sendOutcomeEvent'), accounts: db.rows('accountWriteState'),
    });
    const held = facts();
    await service.enqueueSavedReply('org', 'user', 'reply', simple);
    expect(facts()).toEqual(held);
    await service.apiOutcome('org', execution.id, 0, { eventId: 'uncertain', status: 'unknown' }, sendNow);
    const uncertain = facts();
    await service.enqueueSavedReply('org', 'user', 'reply', simple);
    expect(facts()).toEqual(uncertain);
    await expect(service.reserveApi('org', 'root', 'second-worker', sendNow)).rejects.toThrow();
    const outcome = { eventId: 'confirmed', status: 'confirmed' as const, platformId: 'external', url: 'https://x.com/u/status/external' };
    await service.apiOutcome('org', execution.id, 0, outcome, sendNow);
    await service.apiOutcome('org', execution.id, 0, outcome, sendNow);
    const confirmed = facts();
    expect((await service.enqueueSavedReply('org', 'user', 'reply', simple)).state).toBe('PUBLISHED');
    expect(facts()).toEqual(confirmed);
    expect(db.rows('sendIntent')).toHaveLength(1);
    expect(db.rows('sendExecution')).toHaveLength(1);
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({ heldUnits: 0, confirmedUnits: 1 });
  });
});

describe('ordinary user sending summary', () => {
  it.each(['{', 'null', '[]', '"not-settings"'])('does not enable enqueue for malformed queued reply settings: %s', async settings => {
    const { db, service } = await draft();
    Object.assign(db.rows('post')[0], { state: 'QUEUE', executionProtocol: 'LEGACY', settings });
    db.seed('engageOpportunity', { id: 'opp', platform: 'x', externalPostId: 'target' });
    const summary = await service.businessSummary('org', 'user', 'root');
    expect(summary.allowedActions.enqueue).toEqual({ allowed: false, reason: 'CONTENT_NOT_ENQUEUEABLE' });
    expect(summary.allowedActions.selectAccount.allowed).toBe(false);
    expect(db.rows('sendIntent')).toEqual([]);
    expect(db.rows('sendExecution')).toEqual([]);
  });
  it.each([
    ...['linkedin', 'medium', 'quora', 'hackernews', 'devto'].flatMap(platform => [
      { platform, url: undefined, settings: {}, allowed: false },
      { platform, url: 'https://example.com/not-a-platform-target', settings: {}, allowed: false },
    ]),
    { platform: 'linkedin', url: 'https://www.linkedin.com/feed/update/urn:li:activity:123/', settings: {}, allowed: true },
    { platform: 'linkedin', url: undefined, settings: { replyUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:123/' }, allowed: true },
    { platform: 'linkedin', url: 'https://example.com/not-linkedin', settings: { replyUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:123/' }, allowed: false },
    { platform: 'x', url: undefined, settings: {}, allowed: true },
    { platform: 'reddit', url: undefined, settings: {}, allowed: true },
  ])('projects the actual queued target contract for $platform ($url, $settings)', async ({ platform, url, settings, allowed }) => {
    const { db, service } = await draft();
    Object.assign(db.rows('post')[0], { state: 'QUEUE', executionProtocol: 'LEGACY', publishMethod: 'EXTENSION',
      providerIdentifier: platform, settings: JSON.stringify(settings) });
    const opportunity = { id: 'opp', platform, externalPostId: 'target', externalPostUrl: url };
    db.seed('engageOpportunity', opportunity);
    db.rows('engageSentReply')[0].opportunity = opportunity;
    const summary = await service.businessSummary('org', 'user', 'root');
    expect(summary.allowedActions.enqueue).toEqual({ allowed, reason: allowed ? null : 'REPLY_TARGET_REQUIRED' });
    expect(summary.allowedActions.selectAccount.allowed).toBe(false);
    expect(db.rows('sendIntent')).toEqual([]);
    const enqueue = service.enqueueSavedReply('org', 'user', 'reply', { sentReplyId: 'reply' });
    if (allowed) {
      await expect(enqueue).resolves.toMatchObject({ id: 'root' });
      expect(db.rows('sendIntent')).toHaveLength(1);
    } else {
      await expect(enqueue).rejects.toThrow('REPLY_TARGET_REQUIRED');
      expect(db.rows('sendIntent')).toEqual([]);
    }
    expect(db.rows('sendExecution')).toEqual([]);
  });
  it.each([
    ['ordinary-post', 'CONTENT_NOT_ENQUEUEABLE'],
    ['no-saved-reply', 'SAVED_REPLY_NOT_FOUND'],
    ['claimed', 'LEGACY_CONTENT_DRAIN_REQUIRED'],
    ['published-url', 'LEGACY_CONTENT_DRAIN_REQUIRED'],
    ['recurring', 'CONTROLLED_RECURRING_OCCURRENCE_REQUIRED'],
    ['replied', 'REPLY_OPPORTUNITY_NOT_ACTIONABLE'],
    ['scheduled', 'REPLY_OPPORTUNITY_NOT_ACTIONABLE'],
    ['no-target', 'REPLY_TARGET_REQUIRED'],
    ['unsupported-platform', 'CONTROLLED_PLATFORM_UNSUPPORTED'],
    ['account-unconfirmed', 'SEND_BINDING_RECONFIRMATION_REQUIRED'],
    ['inactive-project', 'PROJECT_INACTIVE'],
  ])('does not unfreeze a legacy queued reply or post for %s', async (kind, reason) => {
    const { db, service, projects } = await draft();
    const post = db.rows('post')[0];
    Object.assign(post, { state: 'QUEUE', executionProtocol: 'LEGACY', publishMethod: 'EXTENSION' });
    db.seed('engageOpportunity', { id: 'opp', platform: 'x', externalPostId: 'target' });
    if (kind === 'ordinary-post') post.source = 'calendar';
    if (kind === 'no-saved-reply') db.rows('engageSentReply').length = 0;
    if (kind === 'claimed') { post.releaseId = 'claim'; post.claimedAt = sendNow; }
    if (kind === 'published-url') post.releaseURL = 'https://x.com/u/status/already-sent';
    if (kind === 'recurring') post.intervalInDays = 1;
    if (kind === 'replied') db.rows('engageOpportunityState')[0].status = 'REPLIED';
    if (kind === 'scheduled') db.rows('engageOpportunityState')[0].status = 'SCHEDULED';
    if (kind === 'no-target') db.rows('engageOpportunity')[0].externalPostId = null;
    if (kind === 'unsupported-platform') post.providerIdentifier = 'unsupported';
    if (kind === 'account-unconfirmed') post.integrationId = 'account';
    if (kind === 'inactive-project') projects.getActivationVerdict.mockResolvedValue('inactive');
    const summary = await service.businessSummary('org', 'user', 'root');
    expect(summary.allowedActions.enqueue).toEqual({ allowed: false, reason });
    expect(summary.allowedActions.selectAccount.allowed).toBe(false);
    expect(summary.allowedActions.retry.allowed).toBe(false);
    expect(db.rows('sendIntent')).toEqual([]);
    expect(db.rows('sendExecution')).toEqual([]);
  });
  it('reports the same legacy ownership restriction as enqueue for a claimed saved reply', async () => {
    const { db, service } = await draft();
    Object.assign(db.rows('post')[0], { executionProtocol: 'LEGACY', releaseId: 'old-lease', claimedAt: sendNow });
    const summary = await service.businessSummary('org', 'user', 'root');
    expect(summary.allowedActions.enqueue).toEqual({ allowed: false, reason: 'LEGACY_CONTENT_DRAIN_REQUIRED' });
    expect(summary.allowedActions.retry).toEqual({ allowed: false, reason: 'LEGACY_CONTENT_DRAIN_REQUIRED' });
    expect(JSON.stringify(summary)).not.toContain('old-lease');
    await expect(service.enqueueSavedReply('org', 'user', 'reply')).rejects.toThrow('LEGACY_CONTENT_DRAIN_REQUIRED');
    Object.assign(db.rows('post')[0], { releaseId: null, claimedAt: null });
    expect((await service.businessSummary('org', 'user', 'root')).allowedActions.enqueue.allowed).toBe(true);
  });
  it('also projects legacy ownership held by a descendant of the saved root', async () => {
    const { db, service } = await draft();
    const post = db.rows('post')[0];
    Object.assign(post, { executionProtocol: 'LEGACY' });
    db.seed('post', { ...post, id: 'child', parentPostId: post.id, releaseId: 'child-lease', claimedAt: sendNow });
    expect((await service.businessSummary('org', 'user', 'root')).allowedActions.enqueue)
      .toEqual({ allowed: false, reason: 'LEGACY_CONTENT_DRAIN_REQUIRED' });
  });
  it('does not block an unrelated saved draft because another legacy root is still claimed', async () => {
    const { db, service } = await draft();
    db.seed('post', { ...db.rows('post')[0], id: 'other', group: 'other', executionProtocol: 'LEGACY',
      releaseId: 'other-lease', claimedAt: sendNow });
    expect((await service.businessSummary('org', 'user', 'root')).allowedActions.enqueue.allowed).toBe(true);
  });

  it('whitelists public fields, exposes uncertainty and forbids all new sending for unknown work', async () => {
    const { db, service, create } = setupSend();
    await create();
    const intent = db.rows('sendIntent')[0];
    Object.assign(intent, { status: 'RECONCILING', activeExecutionId: 'execution', target: { id: '123', idNamespace: 'x.rest_id', credentialHash: 'secret' } });
    db.seed('sendExecution', { id: 'execution', organizationId: 'org', sendIntentId: intent.id, status: 'RECONCILING', payload: { token: 'secret' }, leaseTokenHash: 'secret' });
    db.seed('sendSegment', { executionId: 'execution', organizationId: 'org', segmentIndex: 0, status: 'UNKNOWN', permitHash: 'secret', result: { evidence: 'secret' } });
    const result = await service.businessSummary('org', 'user', 'root');
    expect(result.status).toBe('RECONCILING');
    expect(Object.values(result.allowedActions).every(action => !action.allowed)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('checks membership and project ownership, including after the feature is disabled', async () => {
    const { service, create, projects } = setupSend();
    await create();
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
    const result = await service.businessSummary('org', 'user', 'root');
    expect(result).toMatchObject({ paused: true, protocol: 'ACCOUNT_BOUND_V1', allowedActions: { retry: { allowed: false } } });
    expect(projects.assertProjectAccess).toHaveBeenCalledWith('org', 'project');
    await expect(service.businessSummary('org', 'outsider', 'root')).rejects.toThrow('ORGANIZATION_MEMBERSHIP_REQUIRED');
    projects.assertProjectAccess.mockRejectedValueOnce(new Error('PROJECT_NOT_FOUND'));
    await expect(service.businessSummary('org', 'user', 'root')).rejects.toThrow('PROJECT_NOT_FOUND');
  });
  it.each(['QUEUED', 'RESERVED', 'SENDING', 'RECONCILING', 'SUCCEEDED'])('does not offer retry for %s', status => {
    const result = sendBusinessSummary({ id: 'root', state: 'QUEUE' }, { status }, [], []);
    expect(result.allowedActions.retry.allowed).toBe(false);
    expect(result.allowedActions.selectAccount).toEqual({ allowed: false, reason: 'SEND_INTENT_IMMUTABLE' });
    expect(result.allowedActions.reschedule.reason).toBe('SEND_INTENT_REQUIRES_CONTROLLED_RESCHEDULE');
  });
  it('only offers retry after a definite failure without active, uncertain or confirmed work', () => {
    const intent = { status: 'FAILED_FINAL', activeExecutionId: null, hasConfirmedSegments: false };
    const post = { id: 'root', state: 'ERROR', publishDate: sendNow };
    expect(sendBusinessSummary(post, intent, [], [{ status: 'NOT_SUBMITTED' }]).allowedActions.retry.allowed).toBe(true);
    for (const status of ['CONFIRMED', 'AUTHORIZED', 'UNKNOWN']) {
      expect(sendBusinessSummary(post, intent, [], [{ status }]).allowedActions.retry.allowed).toBe(false);
    }
    expect(sendBusinessSummary(post, { ...intent, hasConfirmedSegments: true }, [], []).status).toBe('PARTIAL_SUCCESS');
  });
});

describe('action-specific project account projections', () => {
  function repository(rows: any[]) {
    const findMany = vi.fn().mockResolvedValue(rows);
    const repo = Object.create(EngageRepository.prototype) as any;
    repo._integration = { model: { integration: { findMany } } };
    return { repo, findMany };
  }
  const account = { id: 'account', internalId: '123', identityNamespace: 'x.rest_id', disabled: false, token: 'secret' };
  it('does not grant reply permission to missing, disabled or opted-out project relations', async () => {
    const { repo, findMany } = repository([
      { ...account },
      { ...account, id: 'disabled', integrationProjects: [{ disabled: true, engageEnabled: true }] },
      { ...account, id: 'opted-out', integrationProjects: [{ disabled: false, engageEnabled: false }] },
      { ...account, id: 'valid', integrationProjects: [{ disabled: false, engageEnabled: true }] },
    ]);
    const rows = await repo.listReplyAccountIntegrations('org', 'project', CONTROLLED_SEND_PLATFORMS, true);
    expect(rows.map((row: any) => row.blockCode)).toEqual(['ACCOUNT_NOT_ASSIGNED', 'ACCOUNT_NOT_ASSIGNED', 'REPLY_ACCOUNT_DISABLED', null]);
    expect(rows[0].engageEnabled).toBe(false);
    expect(JSON.stringify(rows)).not.toContain('secret');
    expect(findMany.mock.calls[0][0].include.integrationProjects.where).toEqual({ projectId: 'project', organizationId: 'org' });
  });
  it('keeps legacy X enumeration and no-binding defaults, while controlled queries enumerate seven platforms', async () => {
    const { repo } = repository([{ ...account }]);
    expect((await repo.listReplyAccountIntegrations('org', 'project'))[0].engageEnabled).toBe(true);
    const service = Object.create(EngageService.prototype) as any;
    service._engageRepository = { listReplyAccountIntegrations: vi.fn().mockResolvedValue([]) };
    service._projectValidation = { assertProjectAccess: vi.fn() };
    await service.listReplyAccounts({ id: 'org' }, 'project');
    expect(service._engageRepository.listReplyAccountIntegrations.mock.calls[0][2]).toEqual([...CONTROLLED_SEND_PLATFORMS, 'linkedin-page']);
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
    await service.listReplyAccounts({ id: 'org' }, 'project');
    expect(service._engageRepository.listReplyAccountIntegrations.mock.calls[1][2]).toEqual(['x']);
  });
  it('projects REPLY node capability rather than POST capability in the project list', async () => {
    const controller = Object.create(IntegrationsController.prototype) as any;
    controller._integrationService = { listProjectIntegrations: vi.fn().mockResolvedValue([{ disabled: false, engageEnabled: true, integration: { ...account, providerIdentifier: 'x' } }]) };
    controller._integrationManager = { getSocialIntegration: vi.fn().mockReturnValue({ editor: 'normal' }) };
    controller._extensionNodes = { accountViews: vi.fn().mockResolvedValue(new Map([['account', { sendAvailability: 'WAITING_FOR_TERMINAL', terminals: [] }]])) };
    const result = await controller.listProjectIntegrations({ id: 'org' }, 'project', { id: 'user' }, 'REPLY');
    expect(controller._extensionNodes.accountViews.mock.calls[0][3]).toBe('reply');
    expect(result.integrations[0]).toMatchObject({ engageEnabled: true, action: 'REPLY', projectAssigned: true, identityNamespace: 'x.rest_id' });
    await expect(controller.listProjectIntegrations({ id: 'org' }, 'project', { id: 'user' }, 'wrong')).rejects.toThrow('SEND_ACTION_INVALID');
  });
});

describe('business status wiring and retry admission', () => {
  it('returns the canonical intent root when reading a controlled thread segment', async () => {
    const { service, db, create } = setupSend();
    await create();
    db.seed('post', { ...db.rows('post')[0], id: 'child', parentPostId: 'root' });
    expect(await service.businessSummary('org', 'user', 'child')).toMatchObject({ rootPostId: 'root' });
  });
  it.each(['REPLIED', 'SCHEDULED', 'EXPIRED', 'DISMISSED'])('does not enqueue a stored draft for a %s opportunity', async status => {
    const { service, db } = await draft();
    db.rows('engageOpportunityState')[0].status = status;
    await expect(service.enqueueSavedReply('org', 'user', 'reply', selection)).rejects.toThrow('REPLY_OPPORTUNITY_NOT_ACTIONABLE');
    expect(db.rows('sendIntent')).toHaveLength(0);
    expect(db.rows('sendMutationReceipt')).toHaveLength(0);
  });
  it.each(['REPLIED', 'SCHEDULED', 'EXPIRED', 'DISMISSED'])('blocks generic enqueue from bypassing a %s saved reply opportunity', async status => {
    const { service, db } = await draft();
    db.rows('engageOpportunityState')[0].status = status;
    await expect(service.enqueue('org', 'root', { userId: 'user', origin: 'MANUAL' }))
      .rejects.toThrow('REPLY_OPPORTUNITY_NOT_ACTIONABLE');
    expect(db.rows('post')[0]).toMatchObject({ state: 'DRAFT', sendIntentId: null, settings: '{}' });
    expect(db.rows('engageOpportunityState')[0].status).toBe(status);
    expect(db.rows('sendIntent')).toHaveLength(0);
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
  });
  it('claims a saved reply opportunity through generic enqueue and replays the same intent', async () => {
    const { service, db } = await draft();
    const first = await service.enqueue('org', 'root', { userId: 'user', origin: 'MANUAL' });
    const replay = await service.enqueue('org', 'root', { userId: 'user', origin: 'MANUAL' });
    expect(replay.sendIntentId).toBe(first.sendIntentId);
    expect(db.rows('engageOpportunityState')[0].status).toBe('SCHEDULED');
    expect(db.rows('sendIntent')).toHaveLength(1);
  });
  it('creates one intent when generic and versioned saved reply entry points compete', async () => {
    const { service, db } = await draft();
    const results = await Promise.allSettled([
      service.enqueue('org', 'root', { userId: 'user', origin: 'MANUAL' }),
      service.enqueueSavedReply('org', 'user', 'reply', selection),
    ]);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    expect(db.rows('post')).toHaveLength(1);
    expect(db.rows('sendIntent')).toHaveLength(1);
    expect(db.rows('engageOpportunityState')[0].status).toBe('SCHEDULED');
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
    expect(db.rows('sendExecution')).toHaveLength(0);
  });
  it.each([{ content: 'changed' }, { inputData: { strategy: 'AMPLIFY' } }])('rejects edits to a frozen reply through the legacy scheduled editor: %j', async data => {
    const repo = Object.create(EngageRepository.prototype) as any;
    const row = { id: 'reply', postId: 'root', post: { id: 'root', state: 'QUEUE', sendIntentId: 'intent', executionProtocol: 'ACCOUNT_BOUND_V1' } };
    repo._sentReply = { model: { engageSentReply: { findFirst: vi.fn().mockResolvedValue(row) } } };
    const update = vi.fn();
    repo._tx = { model: { $transaction: async (work: any) => work({ post: { update }, engageSentReply: { update } }) } };
    await expect(repo.updateScheduledReply('org', 'reply', data)).rejects.toThrow('SEND_INTENT_IMMUTABLE');
    expect(update).not.toHaveBeenCalled();
  });
  it('rechecks the frozen boundary atomically if enqueue wins after the legacy editor read', async () => {
    const repo = Object.create(EngageRepository.prototype) as any;
    const row = { id: 'reply', postId: 'root', post: { id: 'root', state: 'QUEUE', sendIntentId: null, executionProtocol: 'LEGACY' } };
    repo._sentReply = { model: { engageSentReply: { findFirst: vi.fn().mockResolvedValue(row) } } };
    const update = vi.fn().mockRejectedValue({ code: 'P2025' });
    const updateMetadata = vi.fn();
    repo._tx = { model: { $transaction: async (work: any) => work({ post: { update }, engageSentReply: { update: updateMetadata } }) } };
    await expect(repo.updateScheduledReply('org', 'reply', { inputData: { strategy: 'AMPLIFY' } })).rejects.toThrow('SEND_REPLY_CHANGED');
    expect(update.mock.calls[0][0].where).toMatchObject({ id: 'root', organizationId: 'org', state: 'QUEUE', sendIntentId: null });
    expect(updateMetadata).not.toHaveBeenCalled();
  });
  it('preserves legacy scheduled editing with a version increment and no account changes', async () => {
    const repo = Object.create(EngageRepository.prototype) as any;
    const row = { id: 'reply', postId: 'root', post: { id: 'root', state: 'QUEUE', sendIntentId: null, executionProtocol: 'LEGACY' } };
    repo._sentReply = { model: { engageSentReply: { findFirst: vi.fn().mockResolvedValue(row) } } };
    const update = vi.fn();
    const updateMetadata = vi.fn();
    repo._tx = { model: { $transaction: async (work: any) => work({ post: { update }, engageSentReply: { update: updateMetadata } }) } };
    await repo.updateScheduledReply('org', 'reply', { content: 'edited', inputData: { strategy: 'AMPLIFY' } });
    expect(update.mock.calls[0][0].data).toEqual({ content: 'edited', contentRevision: { increment: 1 } });
    expect(updateMetadata).toHaveBeenCalledOnce();
  });
  it('adds the ordinary-user summary to both Post detail read routes', async () => {
    const controller = Object.create(PostsController.prototype) as any;
    const detail = { group: 'group', posts: [{ id: 'root', sendIntentId: 'intent', executionProtocol: 'ACCOUNT_BOUND_V1' }] };
    controller._postsService = {
      getPost: vi.fn().mockResolvedValue(detail), getPostsByGroup: vi.fn().mockResolvedValue(detail),
      getSendingSummary: vi.fn().mockResolvedValue({ status: 'QUEUED' }),
    };
    expect(await controller.getPost({ id: 'org' }, 'root', undefined, { id: 'user' })).toMatchObject({ sending: { status: 'QUEUED' } });
    expect(await controller.getPostsByGroup({ id: 'org' }, 'group', { id: 'user' })).toMatchObject({ sending: { status: 'QUEUED' } });
    expect(controller._postsService.getSendingSummary).toHaveBeenCalledWith('org', 'user', 'root');
  });
  it('keeps inactive projects readable while disabling enqueue and retry', async () => {
    const { service, projects, create } = setupSend();
    await create();
    projects.getActivationVerdict.mockResolvedValue('inactive');
    const result = await service.businessSummary('org', 'user', 'root');
    expect(result.allowedActions.retry).toEqual({ allowed: false, reason: 'PROJECT_INACTIVE' });
    expect(result.allowedActions.enqueue.allowed).toBe(false);
  });
  it('enforces the same uncertainty guard during retry and never creates a new intent', async () => {
    const { service, db, create } = setupSend();
    await create();
    const intent = db.rows('sendIntent')[0];
    intent.status = 'FAILED_FINAL';
    db.seed('sendExecution', { id: 'old', organizationId: 'org', sendIntentId: intent.id, status: 'FAILED_FINAL' });
    db.seed('sendSegment', { executionId: 'old', organizationId: 'org', status: 'UNKNOWN' });
    await expect(service.retry('org', 'root', 'user')).rejects.toThrow('SEND_RETRY_UNSAFE');
    expect(db.rows('sendIntent')).toHaveLength(1);
    expect(db.rows('sendIntent')[0].status).toBe('FAILED_FINAL');
  });
  it.each([
    ['QUEUED', 'API'], ['FAILED_FINAL', 'API'],
    ['QUEUED', 'EXTENSION'], ['FAILED_FINAL', 'EXTENSION'],
  ] as const)('blocks actual retry, reservation and browser claim after manually closing %s %s work', async (status, method) => {
    const { service, db } = await draft(method);
    await service.enqueueSavedReply('org', 'user', 'reply', selection);
    const intent = db.rows('sendIntent')[0];
    if (status === 'FAILED_FINAL') {
      Object.assign(intent, { status, lastErrorCode: 'SEND_DEFINITELY_NOT_SUBMITTED' });
      Object.assign(db.rows('post')[0], { state: 'ERROR', error: 'SEND_DEFINITELY_NOT_SUBMITTED' });
      db.seed('sendExecution', { id: 'stopped', organizationId: 'org', sendIntentId: intent.id,
        kind: method, status: 'FAILED_FINAL' });
      db.seed('sendSegment', { id: 'stopped-segment', organizationId: 'org', executionId: 'stopped',
        postId: 'root', status: 'NOT_SUBMITTED' });
      db.seed('sendQuotaReservation', { id: 'released-quota', organizationId: 'org', executionId: 'stopped', state: 'RELEASED' });
    }
    const evidence = () => structuredClone({
      executions: db.rows('sendExecution'), segments: db.rows('sendSegment'),
      quotas: db.rows('sendQuotaReservation'), accounts: db.rows('accountWriteState'),
    });
    const before = evidence();
    const repo = Object.create(EngageRepository.prototype) as any;
    repo._tx = { model: db };
    repo._sendModes = new SendModeService(db as any);
    await repo.closeManuallyFailedReply('org', 'reply', 'Only group members can comment.');
    expect(db.rows('sendIntent')[0]).toMatchObject({ id: intent.id, status: 'CANCELLED', activeExecutionId: null });
    await expect(service.retry('org', 'root', 'user')).rejects.toThrow('SEND_RETRY_UNSAFE');
    await expect(service.reserveApi('org', 'root', 'after-close', sendNow)).rejects.toThrow('CONTENT_NOT_SENDABLE');
    await expect(db.$transaction((tx: any) => service.reserveIn(tx, 'org', 'root', 'EXTENSION', 'after-close-node', {}, sendNow)))
      .rejects.toThrow('CONTENT_NOT_SENDABLE');
    db.seed('extensionNode', { id: 'node', nodeId: 'node', organizationId: 'org', credentialVersion: 1,
      capabilities: { x: { reply: true, strictAccountVerification: true } } });
    db.seed('extensionNodeSession', { extensionNodeId: 'node', organizationId: 'org', platform: 'x',
      integrationId: 'account', verificationStatus: 'VERIFIED', sessionRevision: 1,
      verificationExpiresAt: new Date(Date.now() + 300_000), accountIdentity: { id: '123', namespace: 'x.rest_id' } });
    const nodes = { authenticateIn: vi.fn(async () => db.rows('extensionNode')[0]) };
    const executions = new SendExecutionService(db as any, nodes as any, service);
    expect((await executions.claim({ org: 'org', user: 'user', nodeId: 'node', token: 'token' }, {
      requestId: 'after-close-claim', action: 'REPLY', rootPostId: 'root',
    })).items).toEqual([]);
    expect(db.rows('sendIntent')).toHaveLength(1);
    expect(db.rows('post')[0]).toMatchObject({ state: 'ERROR', sendIntentId: intent.id,
      error: 'Manually marked failed: Only group members can comment.' });
    expect(db.rows('engageOpportunityState')[0].status).toBe('DISMISSED');
    expect(evidence()).toEqual(before);
  });
  it('retries the same root once under concurrent requests after definite non-submission', async () => {
    const { service, db, create } = setupSend();
    await create();
    db.rows('sendIntent')[0].status = 'FAILED_FINAL';
    const attempts = await Promise.allSettled([service.retry('org', 'root', 'user'), service.retry('org', 'root', 'user')]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(db.rows('sendIntent')).toHaveLength(1);
    expect(db.rows('post')).toHaveLength(1);
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
  });
  it('adds the sanitized summary to ordinary Reply polling when controlled, including paused intents', async () => {
    const service = Object.create(EngageService.prototype) as any;
    service._engageRepository = { getSentReplyStatus: vi.fn().mockResolvedValue({ id: 'reply', postId: 'root', state: 'QUEUE', sendIntentId: 'intent', executionProtocol: 'ACCOUNT_BOUND_V1' }) };
    service._postsService = { getSendingSummary: vi.fn().mockResolvedValue({ status: 'RECONCILING', allowedActions: { retry: { allowed: false } } }) };
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
    expect(await service.getSentReplyStatus({ id: 'org' }, 'reply', 'user')).toMatchObject({ sending: { status: 'RECONCILING' } });
    expect(service._postsService.getSendingSummary).toHaveBeenCalledWith('org', 'user', 'root');
    service._engageRepository.getSentReplyStatus.mockResolvedValue({ id: 'reply', postId: 'root', executionProtocol: 'LEGACY' });
    service._postsService.getSendingSummary.mockClear();
    expect(await service.getSentReplyStatus({ id: 'org' }, 'reply', 'user')).not.toHaveProperty('sending');
    expect(service._postsService.getSendingSummary).not.toHaveBeenCalled();
  });
});


it('accepts saved Post CUID roots for enqueue and claim while preserving UUID reply identities', () => {
  const rootPostId = 'cmvg4xcg00001qmjxkonk44ii';
  expect(validateSync(Object.assign(new ClaimSendDto(), { rootPostId, requestId: 'request', action: 'REPLY' }))).toEqual([]);
  expect(validateSync(Object.assign(new EnqueueSendDto(), { rootPostId }))).toEqual([]);
  expect(validateSync(Object.assign(new QueueStoredReplyDto(), { sentReplyId: rootPostId })).length).toBeGreaterThan(0);
  for (const invalid of ['', ' ', 'a'.repeat(129)]) {
    expect(validateSync(Object.assign(new ClaimSendDto(), { rootPostId: invalid, requestId: 'request', action: 'REPLY' })).length).toBeGreaterThan(0);
  }
});


it('automatically settles a proven unsent old claim and enqueues the same reply once after cutover', async () => {
  const { db, service } = await draft();
  Object.assign(db.rows('post')[0], { executionProtocol: 'LEGACY', state: 'QUEUE',
    releaseId: 'old-claim', claimedAt: sendNow });
  db.rows('engageOpportunityState')[0].status = 'AUTO_QUEUED';
  db.seed('engageOpportunity', { id: 'opp', platform: 'x' });
  db.rows('userOrganization')[0].role = 'ADMIN';
  db.rows('settings').find(row => row.key === 'sending.organization_mode:org').value = { mode: 'AUTONOMOUS', revision: 1 };
  const modes = new SendModeService(db as any);
  const owner = { expectedOrganizationId: 'org', expectedUserId: 'user' };
  const grant = await modes.beginBrowserWrite('org', 'user', { ...owner, requestId: 'old-write',
    sentReplyId: 'reply', platform: 'x', contentHash: 'a'.repeat(64) });
  await modes.save('org', 'user', { ...owner, mode: 'CONTROLLED', expectedRevision: 1, requestId: 'cutover' });
  await modes.settleBrowserWrite('org', 'user', grant.id, { ...owner, status: 'NOT_SUBMITTED' });
  const first = await service.enqueueSavedReply('org', 'user', 'reply');
  const replay = await service.enqueueSavedReply('org', 'user', 'reply');
  expect(first.id).toBe('root');
  expect(replay.sendIntentId).toBe(first.sendIntentId);
  expect(db.rows('sendIntent')).toHaveLength(1);
  expect(db.rows('engageSentReply')).toHaveLength(1);
  expect(db.rows('post')[0]).toMatchObject({ state: 'QUEUE', executionProtocol: 'ACCOUNT_BOUND_V1', releaseId: null });
});


describe('Engage list and detail sending projections', () => {
  function fixture(controlled = true, protocol: string | null = 'ACCOUNT_BOUND_V1') {
    const item = { id: 'reply', postId: 'root', post: { id: 'root', state: 'QUEUE', executionProtocol: protocol, sendIntentId: protocol ? 'intent' : null } };
    const summary = { status: 'RECONCILING', rootPostId: 'root', allowedActions: { retry: { allowed: false, reason: 'SEND_RETRY_UNSAFE' } } };
    const service = Object.assign(Object.create(EngageService.prototype), {
      _sendModes: { isControlled: vi.fn().mockResolvedValue(controlled) },
      _postsService: { getSendingSummary: vi.fn().mockResolvedValue(summary) },
      _engageRepository: {
        listSentReplies: vi.fn().mockResolvedValue({ items: [item], total: 1, page: 1, limit: 20 }),
        getSentReplyItemById: vi.fn().mockResolvedValue(item),
      },
    }) as any;
    return { item, summary, service };
  }

  it('returns the same sanitized reconciliation status in list and detail, preserving pagination', async () => {
    const { item, summary, service } = fixture();
    const list = await service.listSentReplies({ id: 'org' }, { page: 1, limit: 20 }, 'user');
    const detail = await service.getSentReplyItemById({ id: 'org' }, item.id, 'user');
    expect(list).toMatchObject({ total: 1, page: 1, limit: 20, items: [{ sending: summary, post: { sending: summary } }] });
    expect(detail).toMatchObject({ sending: summary, post: { sending: summary } });
    expect(service._postsService.getSendingSummary).toHaveBeenCalledWith('org', 'user', 'root');
    expect(item).not.toHaveProperty('sending');
  });

  it('still projects stored controlled replies after the organization returns to autonomous mode', async () => {
    const { service } = fixture(false);
    expect((await service.listSentReplies({ id: 'org' }, {}, 'user')).items[0].sending.status).toBe('RECONCILING');
    expect((await service.getSentReplyItemById({ id: 'org' }, 'reply', 'user')).sending.status).toBe('RECONCILING');
  });

  it('uses current controlled mode for a legacy draft while leaving autonomous legacy replies untouched', async () => {
    const { service } = fixture(true, null);
    expect((await service.listSentReplies({ id: 'org' }, {}, 'user')).items[0].sending.status).toBe('RECONCILING');
    service._sendModes.isControlled.mockResolvedValue(false);
    service._postsService.getSendingSummary.mockClear();
    expect((await service.listSentReplies({ id: 'org' }, {}, 'user')).items[0]).not.toHaveProperty('sending');
    expect(await service.getSentReplyItemById({ id: 'org' }, 'reply', 'user')).not.toHaveProperty('sending');
    expect(service._postsService.getSendingSummary).not.toHaveBeenCalled();
  });

  it('checks mode once and shares one summary read per post within the current page', async () => {
    const { item, service } = fixture();
    service._engageRepository.listSentReplies.mockResolvedValue({ items: [item, { ...item, id: 'second' }], total: 200 });
    const result = await service.listSentReplies({ id: 'org' }, {}, 'user');
    expect(result.items).toHaveLength(2);
    expect(service._sendModes.isControlled).toHaveBeenCalledTimes(1);
    expect(service._postsService.getSendingSummary).toHaveBeenCalledTimes(1);
    expect(service._engageRepository.listSentReplies).toHaveBeenCalledTimes(1);
  });

  it.each(['ORGANIZATION_MEMBERSHIP_REQUIRED', 'PROJECT_ACCESS_DENIED', 'SEND_STATUS_UNAVAILABLE'])('does not hide a summary refusal and restore legacy send buttons: %s', async reason => {
    const { service } = fixture();
    service._postsService.getSendingSummary.mockRejectedValue(new Error(reason));
    await expect(service.listSentReplies({ id: 'org' }, {}, 'user')).rejects.toThrow(reason);
    await expect(service.getSentReplyItemById({ id: 'org' }, 'reply', 'user')).rejects.toThrow(reason);
  });

  it('passes the authenticated user through both HTTP read routes', async () => {
    const service = { listSentReplies: vi.fn(), getSentReplyItemById: vi.fn() };
    const controller = Object.assign(Object.create(EngageController.prototype), { _engageService: service }) as any;
    const org = { id: 'org' }, user = { id: 'user' }, query = { page: 1 };
    controller.listSentReplies(org, query, user);
    controller.getSentReplyById(org, 'reply', user);
    expect(service.listSentReplies).toHaveBeenCalledWith(org, query, 'user');
    expect(service.getSentReplyItemById).toHaveBeenCalledWith(org, 'reply', 'user');
  });

  it.each(['listSentReplies', 'getSentReplyItemById'] as const)('selects stored execution markers on the repository %s read', async method => {
    const findMany = vi.fn().mockResolvedValue([]);
    const findFirst = vi.fn().mockResolvedValue(null);
    const repository = Object.assign(Object.create(EngageRepository.prototype), {
      _sentReply: { model: { engageSentReply: { findMany, findFirst, count: vi.fn().mockResolvedValue(0) } } },
      _opportunityState: { model: { engageOpportunityState: { findMany: vi.fn().mockResolvedValue([]) } } },
    }) as any;
    if (method === 'listSentReplies') {
      await repository.listSentReplies('org', {});
      expect(findMany.mock.calls[0][0].include.post.select).toMatchObject({ executionProtocol: true, sendIntentId: true });
    } else {
      await expect(repository.getSentReplyItemById('org', 'reply')).rejects.toThrow();
      expect(findFirst.mock.calls[0][0].include.post.select).toMatchObject({ executionProtocol: true, sendIntentId: true });
    }
  });
});


describe('queued send timing projection', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(sendNow); });
  afterEach(() => vi.useRealTimers());

  it.each([
    { schedule: 60_000, cooldown: 180_000, reason: 'ACCOUNT_WRITE_INTERVAL' },
    { schedule: 240_000, cooldown: 180_000, reason: 'SEND_NOT_DUE' },
  ])('projects the later bound without granting send permission: $reason', async ({ schedule, cooldown, reason }) => {
    const { db, service, create } = setupSend();
    await create('root', 'EXTENSION');
    db.rows('post')[0].publishDate = new Date(sendNow.getTime() + schedule);
    db.rows('accountWriteState')[0].nextWriteNotBefore = new Date(sendNow.getTime() + cooldown);
    const before = JSON.stringify([db.rows('post'), db.rows('sendIntent'), db.rows('accountWriteState'), db.rows('sendExecution')]);
    const result = await service.businessSummary('org', 'user', 'root');
    expect(result).toMatchObject({ timing: {
      serverNow: sendNow, nextSendNotBefore: new Date(sendNow.getTime() + Math.max(schedule, cooldown)), reason,
    } });
    expect(result.allowedActions.retry.allowed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('canonicalAccountKey');
    expect(JSON.stringify([db.rows('post'), db.rows('sendIntent'), db.rows('accountWriteState'), db.rows('sendExecution')])).toBe(before);
  });

  it.each(['PROJECT_INACTIVE', 'ACCOUNT_WRITE_BUSY', 'ACCOUNT_COORDINATION_AUDIT_REQUIRED', 'SEND_RECONCILIATION_REQUIRED', 'ACCOUNT_BINDINGS_NOT_ENABLED'])(
    'does not predict a send time for an indefinite blocker: %s', async reason => {
      const { db, service, create, projects } = setupSend();
      await create('root', 'EXTENSION');
      const account = db.rows('accountWriteState')[0];
      account.nextWriteNotBefore = new Date(sendNow.getTime() + 180_000);
      if (reason === 'PROJECT_INACTIVE') projects.getActivationVerdict.mockResolvedValue('inactive');
      if (reason === 'ACCOUNT_WRITE_BUSY') account.activeExecutionId = 'other-execution';
      if (reason === 'ACCOUNT_COORDINATION_AUDIT_REQUIRED') account.rolloutReady = false;
      if (reason === 'SEND_RECONCILIATION_REQUIRED') db.rows('sendIntent')[0].status = 'RECONCILING';
      if (reason === 'ACCOUNT_BINDINGS_NOT_ENABLED') vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
      expect(await service.businessSummary('org', 'user', 'root')).toMatchObject({ timing: {
        serverNow: sendNow, nextSendNotBefore: null, reason,
      } });
    }
  );

  it('does not borrow another organization or account cooldown and clears elapsed bounds', async () => {
    const { db, service, create } = setupSend();
    await create('root', 'EXTENSION');
    db.rows('accountWriteState')[0].nextWriteNotBefore = new Date(sendNow.getTime() - 1);
    for (const [id, organizationId, canonicalAccountKey] of [['foreign-org', 'other', 'account-key'], ['foreign-account', 'org', 'other-key']]) {
      db.seed('accountWriteState', { id, organizationId, canonicalAccountKey, nextWriteNotBefore: new Date(sendNow.getTime() + 999_000), rolloutReady: true });
    }
    expect(await service.businessSummary('org', 'user', 'root')).toMatchObject({ timing: {
      serverNow: sendNow, nextSendNotBefore: null, reason: null,
    } });
  });
});

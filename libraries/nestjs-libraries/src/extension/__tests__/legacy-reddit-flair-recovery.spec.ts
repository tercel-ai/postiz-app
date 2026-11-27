import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendModeService } from '../send-mode.service';
import { memorySendDatabase } from './support/memory-send-database';
import { setupSend, sendNow } from './support/send-fixture';
import { RedditTargetResolutionService } from '../../engage/reddit-target-resolution.service';
import { canChangePostAccount } from '../send-account-change';

const owner = { expectedOrganizationId: 'org', expectedUserId: 'user' };
const claimedAt = new Date('2026-10-21T03:00:00Z');
function setup(status = 'NOT_SUBMITTED') {
  const db = memorySendDatabase();
  db.seed('userOrganization', { organizationId: 'org', userId: 'user', role: 'USER', disabled: false });
  db.seed('post', { id: 'post', organizationId: 'org', projectId: 'project', operationPlanId: 'plan',
    group: 'post', parentPostId: null, state: 'QUEUE', source: 'calendar', providerIdentifier: 'reddit',
    executionProtocol: null, sendIntentId: null, releaseId: 'lease', releaseURL: null, claimedAt,
    routeRevision: 0, contentRevision: 0, publishDate: new Date('2026-10-20T03:00:00Z'),
    settings: JSON.stringify({ subreddit: [{ value: { subreddit: 'test', title: 'Title', type: 'self' } }] }) });
  db.seed('sendMutationReceipt', { id: 'old', organizationId: 'org', userId: 'user',
    operation: 'autonomous-side-effect', requestId: 'old', requestHash: 'old-hash',
    result: { source: 'BROWSER', platform: 'reddit', browserUserId: 'user', integrationId: 'browser:user:reddit',
      action: 'POST', postIds: ['post'], occurrenceKey: 'single', recurring: false, status, revision: 2 } });
  return { db, service: new SendModeService(db) };
}
beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());
describe('reviewing historical Reddit post claims', () => {
  it('requires owner review and stages the original post without altering evidence', async () => {
    const { db, service } = setup();
    const view = await service.getBrowserRedditFlairRecovery('org', 'user', 'post');
    expect(view).toMatchObject({ canReview: true, postId: 'post' });
    const body = { ...owner, requestId: 'review', expectedRecoveryRevision: view.recoveryRevision, reviewConfirmed: true as const };
    const proof = structuredClone(db.rows('sendMutationReceipt')[0]);
    expect(await service.resolveBrowserRedditFlairRecovery('org', 'user', 'post', body)).toMatchObject({ resolved: true });
    expect(db.rows('post')[0]).toMatchObject({ state: 'QUEUE', releaseId: null, claimedAt });
    expect(JSON.parse(db.rows('post')[0].settings).redditTargetPending.reason).toBe('flair-pending');
    expect(db.rows('sendMutationReceipt').find(row => row.id === 'old')).toEqual(proof);
    expect(await service.resolveBrowserRedditFlairRecovery('org', 'user', 'post', body)).toMatchObject({ resolved: true });
  });
  it('parks an explicitly reviewed failed post as a draft for Flair resolution', async () => {
    const { db, service } = setup();
    db.rows('post')[0].state = 'ERROR';
    db.rows('post')[0].releaseId = null;
    const view = await service.getBrowserRedditFlairRecovery('org', 'user', 'post');
    expect(view.canReview).toBe(true);
    await service.resolveBrowserRedditFlairRecovery('org', 'user', 'post', { ...owner, requestId: 'review-error',
      expectedRecoveryRevision: view.recoveryRevision, reviewConfirmed: true });
    expect(db.rows('post')[0]).toMatchObject({ state: 'DRAFT', releaseId: null, claimedAt });
    expect(JSON.parse(db.rows('post')[0].settings).redditTargetPending.reason).toBe('flair-pending');
  });
  it('lets the original user review after mode cutover while preserving another captured task', async () => {
    const { db, service } = setup();
    db.seed('settings', { key: 'sending.organization_mode:org', value: { mode: 'CONTROLLED', revision: 3,
      legacyDrain: { version: 2, targetMode: 'CONTROLLED', requestedAt: claimedAt.toISOString(), requestedByUserId: 'user',
        initialPendingCount: 2, eligiblePostIds: ['post', 'other'], eligiblePostOccurrences: {
          post: '2026-10-20T03:00:00.000Z', other: null }, effectReceiptIds: ['old'] } } });
    const view = await service.getBrowserRedditFlairRecovery('org', 'user', 'post');
    expect(view.canReview).toBe(true);
    await service.resolveBrowserRedditFlairRecovery('org', 'user', 'post', { ...owner, requestId: 'controlled-review',
      expectedRecoveryRevision: view.recoveryRevision, reviewConfirmed: true });
    expect(db.rows('post')[0]).toMatchObject({ state: 'QUEUE', releaseId: null, claimedAt });
    expect(db.rows('settings')[0].value.legacyDrain.eligiblePostIds).toEqual(['other']);
    expect(db.rows('settings')[0].value.reallocation).toMatchObject({ version: 1 });
  });

  it('reviews, resolves and reallocates the same legacy Post to one editable controlled intent', async () => {
    const f = setupSend();
    const db = f.db;
    db.rows('integration')[0].providerIdentifier = 'reddit';
    db.rows('settings')[0].value = { mode: 'CONTROLLED', revision: 3, legacyDrain: {
      version: 2, targetMode: 'CONTROLLED', requestedAt: claimedAt.toISOString(), requestedByUserId: 'user',
      initialPendingCount: 1, eligiblePostIds: ['post'], eligiblePostOccurrences: { post: sendNow.toISOString() }, effectReceiptIds: ['old'] } };
    db.seed('post', { id: 'post', organizationId: 'org', projectId: 'project', operationPlanId: 'plan',
      group: 'post', parentPostId: null, state: 'QUEUE', source: 'calendar', providerIdentifier: 'reddit',
      integrationId: 'account', executionProtocol: null, sendIntentId: null, releaseId: 'lease', releaseURL: null, claimedAt,
      routeRevision: 0, contentRevision: 1, publishMethod: 'EXTENSION', publishDate: sendNow, content: 'Body', image: '[]',
      settings: JSON.stringify({ subreddit: [{ value: { subreddit: 'test', title: 'Title', type: 'self' } }] }) });
    db.seed('sendMutationReceipt', { id: 'old', organizationId: 'org', userId: 'user', operation: 'autonomous-side-effect',
      requestId: 'old', result: { source: 'BROWSER', platform: 'reddit', browserUserId: 'user', integrationId: 'browser:user:reddit',
        action: 'POST', postIds: ['post'], occurrenceKey: 'single', recurring: false, status: 'NOT_SUBMITTED', revision: 2 } });
    const modes = new SendModeService(db);
    const view = await modes.getBrowserRedditFlairRecovery('org', 'user', 'post');
    await modes.resolveBrowserRedditFlairRecovery('org', 'user', 'post', { ...owner, requestId: 'review-chain',
      expectedRecoveryRevision: view.recoveryRevision, reviewConfirmed: true });
    const resolver = new RedditTargetResolutionService({ model: db } as any, { model: db } as any,
      { getRedditChannelCapability: vi.fn(async () => ({})) } as any,
      { generateStructuredText: vi.fn(async () => ({ data: { option: 0 } })) } as any,
      { schedulePlanPosts: vi.fn(), isControlled: vi.fn(async () => true) } as any, {} as any);
    const [pending] = await resolver.listPending('org');
    expect(pending).toBeDefined();
    expect(await resolver.resolve('org', [{ postId: 'post', pendingRevision: pending.pendingRevision,
      subreddit: 'test', flairOptions: ['Discussion'], flairRequired: true }])).toMatchObject({ resolved: 1 });
    expect(await f.service.reallocateUnsentLegacy('org', 'user')).toEqual([]);
    expect(db.rows('sendIntent')).toHaveLength(1);
    const post = db.rows('post')[0], intent = db.rows('sendIntent')[0];
    expect(post).toMatchObject({ state: 'QUEUE', claimedAt: null, sendIntentId: intent.id, publishDate: sendNow });
    expect(canChangePostAccount(post, intent, [], [])).toBe(true);
    await expect(f.service.rescheduleQueuedPost('org', post.id, 'user', new Date('2026-10-16T00:00:00Z'),
      post.routeRevision, post.contentRevision)).resolves.toBeDefined();
  });

  it('rejects a changed claim or missing explicit review without changing the post', async () => {
    const { db, service } = setup();
    const view = await service.getBrowserRedditFlairRecovery('org', 'user', 'post');
    await expect(service.resolveBrowserRedditFlairRecovery('org', 'user', 'post', { ...owner, requestId: 'review',
      expectedRecoveryRevision: view.recoveryRevision })).rejects.toThrow('INVALID_LEGACY_POST_RECOVERY');
    db.rows('post')[0].releaseId = 'new-lease';
    await expect(service.resolveBrowserRedditFlairRecovery('org', 'user', 'post', { ...owner, requestId: 'review',
      expectedRecoveryRevision: view.recoveryRevision, reviewConfirmed: true })).rejects.toThrow('LEGACY_POST_RECOVERY_CHANGED');
    expect(db.rows('post')[0].releaseId).toBe('new-lease');
  });
  it('does not treat a cross-group child as a standalone post', async () => {
    const { db, service } = setup();
    db.seed('post', { id: 'child', organizationId: 'org', parentPostId: 'post', group: 'other-group', deletedAt: null });
    expect((await service.getBrowserRedditFlairRecovery('org', 'user', 'post')).canReview).toBe(false);
  });
  it('does not let another user review someone else’s original receipt', async () => {
    const { db, service } = setup();
    db.seed('userOrganization', { organizationId: 'org', userId: 'other', role: 'USER', disabled: false });
    expect((await service.getBrowserRedditFlairRecovery('org', 'other', 'post')).canReview).toBe(false);
  });
  it.each(['AUTONOMOUS', 'CONTROLLED'] as const)(
    'does not recover an unassociated browser receipt in %s mode', async mode => {
      const { db, service } = setup();
      delete db.rows('sendMutationReceipt')[0].result.postIds;
      if (mode === 'CONTROLLED') db.seed('settings', { key: 'sending.organization_mode:org', value: {
        mode: 'CONTROLLED', revision: 3, legacyDrain: { version: 2, targetMode: 'CONTROLLED',
          requestedAt: claimedAt.toISOString(), requestedByUserId: 'user', initialPendingCount: 1,
          eligiblePostIds: ['post'], eligiblePostOccurrences: { post: '2026-10-20T03:00:00.000Z' }, effectReceiptIds: ['old'] },
      } });
      const originalPost = structuredClone(db.rows('post')[0]);
      const originalReceipts = structuredClone(db.rows('sendMutationReceipt'));
      const view = await service.getBrowserRedditFlairRecovery('org', 'user', 'post');
      expect(view.canReview).toBe(false);
      await expect(service.resolveBrowserRedditFlairRecovery('org', 'user', 'post', { ...owner,
        requestId: 'unassociated', expectedRecoveryRevision: view.recoveryRevision, reviewConfirmed: true,
      })).rejects.toThrow('LEGACY_POST_RECOVERY_UNSAFE');
      expect(db.rows('post')[0]).toEqual(originalPost);
      expect(db.rows('sendMutationReceipt')).toEqual(originalReceipts);
    },
  );

  it.each(['UNKNOWN', 'CONFIRMED', 'AUTHORIZED'])('never opens review when an outcome is %s', async status => {
    const { db, service } = setup(status);
    const view = await service.getBrowserRedditFlairRecovery('org', 'user', 'post');
    expect(view.canReview).toBe(false);
    await expect(service.resolveBrowserRedditFlairRecovery('org', 'user', 'post', { ...owner, requestId: 'review',
      expectedRecoveryRevision: view.recoveryRevision, reviewConfirmed: true })).rejects.toThrow();
    expect(db.rows('post')[0].releaseId).toBe('lease');
  });
});

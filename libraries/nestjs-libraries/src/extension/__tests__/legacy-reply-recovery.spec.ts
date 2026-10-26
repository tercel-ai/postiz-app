import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendModeService, organizationSendModeKey } from '../send-mode.service';
import { memorySendDatabase } from './support/memory-send-database';

const owner = { expectedOrganizationId: 'org', expectedUserId: 'admin' };
const claimedAt = new Date('2026-10-21T03:00:00Z');
function setup() {
  const db = memorySendDatabase();
  db.seed('userOrganization', { organizationId: 'org', userId: 'admin', role: 'ADMIN', disabled: false });
  db.seed('userOrganization', { organizationId: 'org', userId: 'member', role: 'USER', disabled: false });
  db.seed('post', { id: 'post', organizationId: 'org', projectId: 'project', state: 'QUEUE',
    source: 'engage', providerIdentifier: 'linkedin', content: 'saved reply', settings: '{}',
    releaseId: 'private-lease', claimedAt, publishDate: new Date('2026-10-20T03:00:00Z'),
    error: 'Previous attempt failed before submission.' });
  db.seed('engageSentReply', { id: 'reply', organizationId: 'org', projectId: 'project',
    postId: 'post', opportunityId: 'opp' });
  db.seed('engageOpportunity', { id: 'opp', platform: 'linkedin', externalPostUrl: 'https://linkedin.com/posts/target' });
  db.seed('engageOpportunityState', { id: 'opp-state', organizationId: 'org', projectId: 'project',
    opportunityId: 'opp', status: 'AUTO_QUEUED' });
  db.seed('sendMutationReceipt', { id: 'old-proof', organizationId: 'org', userId: 'browser-user',
    operation: 'autonomous-side-effect', requestId: 'old-request', requestHash: 'private-request-hash',
    result: { source: 'BROWSER', platform: 'linkedin', browserUserId: 'browser-user',
      integrationId: 'browser:browser-user:linkedin', action: 'COMMENT', postIds: ['post'],
      occurrenceKey: 'single', recurring: false, status: 'NOT_SUBMITTED', revision: 2 } });
  db.seed('settings', { key: organizationSendModeKey('org'), value: { mode: 'CONTROLLED', revision: 3,
    legacyDrain: { version: 2, targetMode: 'CONTROLLED', requestedAt: claimedAt.toISOString(),
      requestedByUserId: 'admin', initialPendingCount: 2, eligiblePostIds: ['post', 'unrelated'],
      eligiblePostOccurrences: { post: '2026-10-20T03:00:00.000Z', unrelated: null },
      effectReceiptIds: ['old-proof'] }, marker: 'preserve' } });
  return { db, service: new SendModeService(db) };
}
async function confirmation(service: SendModeService, patch: Record<string, unknown> = {}) {
  const diagnostic = await service.getLegacyReplyRecovery('org', 'admin', 'reply');
  return { ...owner, requestId: 'repair', expectedRecoveryRevision: diagnostic.recoveryRevision,
    executorStopped: true as const, noPendingSubmit: true as const, replyAbsent: true as const,
    evidence: 'Old executors stopped; target checked and reply absent.', ...patch };
}
beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());

describe('administrator reconciliation of historical legacy reply ownership', () => {
  it('lets the original ordinary browser user recover only their proven unsent historical reply', async () => {
    const { db, service } = setup();
    const receipt = db.rows('sendMutationReceipt')[0];
    receipt.userId = receipt.result.browserUserId = 'member';
    receipt.result.integrationId = 'browser:member:linkedin';
    receipt.createdAt = new Date(claimedAt.getTime() + 1000);
    receipt.result.legacyClaim = { releaseId: 'private-lease', claimedAt: claimedAt.toISOString() };
    const view = await service.getBrowserReplyRecovery('org', 'member', 'reply');
    expect(view.canResolve).toBe(true);
    const body = { expectedOrganizationId: 'org', expectedUserId: 'member', requestId: 'self-recover',
      expectedRecoveryRevision: view.recoveryRevision };
    const result = await service.resolveBrowserReplyRecovery('org', 'member', 'reply', body);
    expect(result).toMatchObject({ resolved: true, sentReplyId: 'reply' });
    expect(db.rows('post')[0]).toMatchObject({ releaseId: null, claimedAt, state: 'QUEUE', content: 'saved reply' });
    expect(db.rows('settings')[0].value.legacyDrain.eligiblePostIds).toEqual(['unrelated']);
    expect(await service.resolveBrowserReplyRecovery('org', 'member', 'reply', body)).toEqual(result);
    expect(db.rows('sendExecution')).toEqual([]);
  });

  it.each(['other-user', 'changed-binding', 'changed-claim-time', 'bound-without-claim-time', 'UNKNOWN', 'CONFIRMED', 'AUTHORIZED'])(
    'keeps self-service recovery closed for %s', async kind => {
      const { db, service } = setup();
      const receipt = db.rows('sendMutationReceipt')[0];
      receipt.userId = receipt.result.browserUserId = 'member';
      receipt.result.integrationId = 'browser:member:linkedin';
      receipt.createdAt = new Date(claimedAt.getTime() + 1000);
      if (kind === 'other-user') { receipt.userId = receipt.result.browserUserId = 'admin'; receipt.result.integrationId = 'browser:admin:linkedin'; }
      if (kind === 'changed-binding') receipt.result.legacyClaim = { releaseId: 'different', claimedAt: claimedAt.toISOString() };
      if (kind === 'changed-claim-time' || kind === 'bound-without-claim-time') {
        receipt.result.legacyClaim = { releaseId: 'private-lease', claimedAt: claimedAt.toISOString() };
        db.rows('post')[0].claimedAt = kind === 'changed-claim-time' ? new Date(claimedAt.getTime() + 1000) : null;
      }
      if (['UNKNOWN', 'CONFIRMED', 'AUTHORIZED'].includes(kind)) receipt.result.status = kind;
      const view = await service.getBrowserReplyRecovery('org', 'member', 'reply');
      expect(view.canResolve).toBe(false);
      expect(view.canReview).toBe(false);
      await expect(service.resolveBrowserReplyRecovery('org', 'member', 'reply', {
        expectedOrganizationId: 'org', expectedUserId: 'member', requestId: 'self-recover',
        expectedRecoveryRevision: view.recoveryRevision, reviewConfirmed: true,
      })).rejects.toThrow('LEGACY_REPLY_RECOVERY_UNSAFE');
      expect(db.rows('post')[0].releaseId).toBe('private-lease');
    });

  it('requires explicit original-user review for unbound historical proof and never exposes receipt identifiers', async () => {
    const { db, service } = setup();
    const receipt = db.rows('sendMutationReceipt')[0];
    receipt.userId = receipt.result.browserUserId = 'member';
    receipt.result.integrationId = 'browser:member:linkedin';
    receipt.createdAt = new Date(claimedAt.getTime() + 1000);
    const view = await service.getBrowserReplyRecovery('org', 'member', 'reply');
    expect(view).toMatchObject({ canResolve: false, canReview: true });
    expect(JSON.stringify(view)).not.toMatch(/old-proof|private-lease|browser-user/);
    const body = { expectedOrganizationId: 'org', expectedUserId: 'member', requestId: 'self-recover', expectedRecoveryRevision: view.recoveryRevision };
    await expect(service.resolveBrowserReplyRecovery('org', 'member', 'reply', body)).rejects.toThrow('LEGACY_REPLY_RECOVERY_UNSAFE');
    await service.resolveBrowserReplyRecovery('org', 'member', 'reply', { ...body, reviewConfirmed: true });
    expect(db.rows('post')[0].releaseId).toBe(null);
    expect(db.rows('sendMutationReceipt').find(row => row.operation === 'browser-reply-recovery').result.proofKind).toBe('OWNER_REVIEWED_HISTORICAL_RECEIPTS');
  });

  it.each(['missing-claim-time', 'older-receipt', 'multiple-attempts'])(
    'offers explicit owner review when historical proof lacks claim timing: %s', async kind => {
      const { db, service } = setup();
      const receipt = db.rows('sendMutationReceipt')[0];
      receipt.userId = receipt.result.browserUserId = 'member';
      receipt.result.integrationId = 'browser:member:linkedin';
      receipt.createdAt = new Date(claimedAt.getTime() - 1000);
      if (kind === 'missing-claim-time') db.rows('post')[0].claimedAt = null;
      if (kind === 'multiple-attempts') db.seed('sendMutationReceipt', {
        ...receipt, id: 'later-proof', requestId: 'later-request',
        createdAt: new Date(claimedAt.getTime() + 1000),
      });
      const previousReceipt = structuredClone(receipt);
      const view = await service.getBrowserReplyRecovery('org', 'member', 'reply');
      expect(view).toMatchObject({ canResolve: false, canReview: true,
        reasons: ['EXPLICIT_OWNER_REVIEW_REQUIRED'] });
      const body = { expectedOrganizationId: 'org', expectedUserId: 'member', requestId: 'review-historical',
        expectedRecoveryRevision: view.recoveryRevision };
      await expect(service.resolveBrowserReplyRecovery('org', 'member', 'reply', body))
        .rejects.toThrow('LEGACY_REPLY_RECOVERY_UNSAFE');
      expect(db.rows('post')[0].releaseId).toBe('private-lease');
      await service.resolveBrowserReplyRecovery('org', 'member', 'reply', { ...body, reviewConfirmed: true });
      expect(db.rows('post')[0]).toMatchObject({ releaseId: null, state: 'QUEUE', content: 'saved reply' });
      expect(db.rows('sendMutationReceipt').find(row => row.id === previousReceipt.id)).toEqual(previousReceipt);
      expect(db.rows('settings')[0].value.legacyDrain.eligiblePostIds).toEqual(['unrelated']);
      expect(db.rows('sendMutationReceipt').find(row => row.operation === 'browser-reply-recovery').result.proofKind)
        .toBe('OWNER_REVIEWED_HISTORICAL_RECEIPTS');
      expect(db.rows('sendExecution')).toEqual([]);
      expect(db.rows('sendIntent')).toEqual([]);
    });

  it('accepts exact current-claim proof alongside an older terminal unbound attempt', async () => {
    const { db, service } = setup();
    const receipt = db.rows('sendMutationReceipt')[0];
    receipt.userId = receipt.result.browserUserId = 'member';
    receipt.result.integrationId = 'browser:member:linkedin';
    receipt.createdAt = new Date(claimedAt.getTime() - 1000);
    db.seed('sendMutationReceipt', { ...receipt, id: 'current-proof', requestId: 'current-request',
      createdAt: new Date(claimedAt.getTime() + 1000), result: { ...receipt.result,
        legacyClaim: { releaseId: 'private-lease', claimedAt: claimedAt.toISOString() } } });
    const view = await service.getBrowserReplyRecovery('org', 'member', 'reply');
    expect(view.canResolve).toBe(true);
    await service.resolveBrowserReplyRecovery('org', 'member', 'reply', {
      expectedOrganizationId: 'org', expectedUserId: 'member', requestId: 'recover-current',
      expectedRecoveryRevision: view.recoveryRevision,
    });
    expect(db.rows('post')[0].releaseId).toBe(null);
    expect(db.rows('sendExecution')).toEqual([]);
  });

  it('rejects owner review when the historical claim changed after the review snapshot', async () => {
    const { db, service } = setup();
    const receipt = db.rows('sendMutationReceipt')[0];
    receipt.userId = receipt.result.browserUserId = 'member';
    receipt.result.integrationId = 'browser:member:linkedin';
    db.rows('post')[0].claimedAt = null;
    const view = await service.getBrowserReplyRecovery('org', 'member', 'reply');
    expect(view.canReview).toBe(true);
    db.rows('post')[0].releaseId = 'new-lease';
    await expect(service.resolveBrowserReplyRecovery('org', 'member', 'reply', {
      expectedOrganizationId: 'org', expectedUserId: 'member', requestId: 'review-stale',
      expectedRecoveryRevision: view.recoveryRevision, reviewConfirmed: true,
    })).rejects.toThrow('LEGACY_REPLY_RECOVERY_CHANGED');
    expect(db.rows('post')[0].releaseId).toBe('new-lease');
    expect(db.rows('settings')[0].value.legacyDrain.eligiblePostIds).toContain('post');
    expect(db.rows('sendMutationReceipt').filter(row => row.operation === 'browser-reply-recovery')).toEqual([]);
  });

  it('does not let extra body fields override the route identity in its idempotency key', async () => {
    const { service } = setup();
    const body = { ...await confirmation(service), sentReplyId: 'body-must-not-override-route' };
    await service.resolveLegacyReplyRecovery('org', 'admin', 'reply', body);
    await expect(service.resolveLegacyReplyRecovery('org', 'admin', 'other-reply', body))
      .rejects.toThrow('REQUEST_ID_CONFLICT');
  });
  it('uses a stable recovery revision when receipt database order changes', async () => {
    const { db, service } = setup();
    const original = db.rows('sendMutationReceipt')[0];
    db.seed('sendMutationReceipt', { ...original, id: 'another-proof', requestId: 'another-request' });
    const first = await service.getLegacyReplyRecovery('org', 'admin', 'reply');
    db.rows('sendMutationReceipt').reverse();
    const next = await service.getLegacyReplyRecovery('org', 'admin', 'reply');
    expect(next.recoveryRevision).toBe(first.recoveryRevision);
  });
  it('rolls back ownership cleanup when its compare-and-set fails', async () => {
    const { db, service } = setup();
    const body = await confirmation(service);
    const delegate = db.post;
    db.post = delegate;
    vi.spyOn(delegate, 'updateMany').mockResolvedValueOnce({ count: 0 });
    await expect(service.resolveLegacyReplyRecovery('org', 'admin', 'reply', body))
      .rejects.toThrow('LEGACY_REPLY_RECOVERY_CHANGED');
    expect(db.rows('post')[0].releaseId).toBe('private-lease');
    expect(db.rows('settings')[0].value.legacyDrain.eligiblePostIds).toContain('post');
    expect(db.rows('sendMutationReceipt').filter(row => row.operation === 'legacy-reply-recovery')).toEqual([]);
  });

  it('diagnoses terminal receipts and missing lease binding without exposing secrets or mutating records', async () => {
    const { db, service } = setup();
    expect((await service.listAutonomousEffects('org', 'admin')).items).toEqual([]);
    const before = structuredClone(db.rows('post'));
    const view = await service.getLegacyReplyRecovery('org', 'admin', 'reply');
    expect(view).toMatchObject({ sentReplyId: 'reply', postId: 'post', canResolve: true,
      claimPresent: true, captured: true, opportunityStatus: 'AUTO_QUEUED',
      receipts: [{ id: 'old-proof', status: 'NOT_SUBMITTED', claimBinding: 'MISSING' }] });
    expect(view.recoveryRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(view)).not.toMatch(/private-lease|private-request-hash|saved reply/);
    expect(db.rows('post')).toEqual(before);
  });
  it('releases only the confirmed historical ownership and audits the original facts without fabricating receipt bindings', async () => {
    const { db, service } = setup();
    const previousReceipt = structuredClone(db.rows('sendMutationReceipt')[0]);
    const result = await service.resolveLegacyReplyRecovery('org', 'admin', 'reply', await confirmation(service));
    expect(result).toMatchObject({ resolved: true, sentReplyId: 'reply', postId: 'post' });
    expect(db.rows('post')[0]).toMatchObject({ releaseId: null, claimedAt, state: 'QUEUE', content: 'saved reply',
      error: 'Previous attempt failed before submission.', sendIntentId: null });
    expect(db.rows('engageOpportunityState')[0].status).toBe('AUTO_QUEUED');
    expect(db.rows('sendMutationReceipt')[0]).toEqual(previousReceipt);
    const setting = db.rows('settings').find(row => row.key === organizationSendModeKey('org')).value;
    expect(setting).toMatchObject({ mode: 'CONTROLLED', revision: 3, marker: 'preserve',
      legacyDrain: { eligiblePostIds: ['unrelated'], eligiblePostOccurrences: { unrelated: null },
        initialPendingCount: 2, effectReceiptIds: ['old-proof'] } });
    const audit = db.rows('sendMutationReceipt').find(row => row.operation === 'legacy-reply-recovery');
    expect(audit).toMatchObject({ userId: 'admin', result: { evidence: 'Old executors stopped; target checked and reply absent.',
      executorStopped: true, noPendingSubmit: true, replyAbsent: true, receiptIds: ['old-proof'] } });
    expect(await service.activeLegacyPostIdsIn(db, 'org')).not.toContain('post');
    expect(db.rows('sendIntent')).toEqual([]);
    expect(db.rows('sendExecution')).toEqual([]);
  });
  it('makes repeated identical confirmations idempotent and rejects changed evidence under the same request ID', async () => {
    const { db, service } = setup();
    const body = await confirmation(service);
    const result = await service.resolveLegacyReplyRecovery('org', 'admin', 'reply', body);
    expect(await service.resolveLegacyReplyRecovery('org', 'admin', 'reply', body)).toEqual(result);
    await expect(service.resolveLegacyReplyRecovery('org', 'admin', 'reply', { ...body, evidence: 'Different.' }))
      .rejects.toThrow('REQUEST_ID_CONFLICT');
    expect(db.rows('sendMutationReceipt').filter(row => row.operation === 'legacy-reply-recovery')).toHaveLength(1);
  });
  it.each(['releaseId', 'content', 'target', 'receipt', 'capture'])(
    'rejects a stale confirmation after %s changes', async field => {
      const { db, service } = setup();
      const body = await confirmation(service);
      if (field === 'releaseId') db.rows('post')[0].releaseId = 'new-lease';
      if (field === 'content') db.rows('post')[0].content = 'edited';
      if (field === 'target') db.rows('engageOpportunity')[0].externalPostUrl = 'https://linkedin.com/posts/other';
      if (field === 'receipt') db.rows('sendMutationReceipt')[0].result.revision++;
      if (field === 'capture') db.rows('settings')[0].value.legacyDrain.eligiblePostOccurrences.post = '2026-10-21T00:00:00.000Z';
      await expect(service.resolveLegacyReplyRecovery('org', 'admin', 'reply', body))
        .rejects.toThrow('LEGACY_REPLY_RECOVERY_CHANGED');
      expect(db.rows('post')[0].releaseId).toBe(field === 'releaseId' ? 'new-lease' : 'private-lease');
    });
  it.each(['AUTHORIZED', 'UNKNOWN', 'CONFIRMED'])(
    'preserves ownership when another receipt is %s, including confirmed receipts omitted by the pending API', async status => {
      const { db, service } = setup();
      const original = db.rows('sendMutationReceipt')[0];
      db.seed('sendMutationReceipt', { ...original, id: 'other', requestId: 'other', result: { ...original.result, status } });
      const body = await confirmation(service);
      expect((await service.getLegacyReplyRecovery('org', 'admin', 'reply')).canResolve).toBe(false);
      await expect(service.resolveLegacyReplyRecovery('org', 'admin', 'reply', body))
        .rejects.toThrow('LEGACY_REPLY_RECOVERY_UNSAFE');
      expect(db.rows('post')[0].releaseId).toBe('private-lease');
    });
  it.each(['none', 'wrong-platform', 'wrong-action', 'recurring', 'multi-post'])(
    'requires relevant single-reply browser non-submission proof: %s', async kind => {
      const { db, service } = setup();
      const receipt = db.rows('sendMutationReceipt')[0];
      if (kind === 'none') db.rows('sendMutationReceipt').length = 0;
      if (kind === 'wrong-platform') { receipt.result.platform = 'x'; receipt.result.integrationId = 'browser:browser-user:x'; }
      if (kind === 'wrong-action') receipt.result.action = 'POST';
      if (kind === 'recurring') receipt.result.recurring = true;
      if (kind === 'multi-post') receipt.result.postIds.push('unrelated');
      await expect(service.resolveLegacyReplyRecovery('org', 'admin', 'reply', await confirmation(service)))
        .rejects.toThrow('LEGACY_REPLY_RECOVERY_UNSAFE');
    });
  it.each(['PUBLISHED', 'ERROR', 'controlled', 'child', 'url', 'autonomous', 'scheduled', 'expired', 'removed'])(
    'does not reopen unsupported or closed content: %s', async kind => {
      const { db, service } = setup();
      const post = db.rows('post')[0];
      if (kind === 'PUBLISHED' || kind === 'ERROR') post.state = kind;
      if (kind === 'controlled') post.executionProtocol = 'ACCOUNT_BOUND_V1';
      if (kind === 'child') db.seed('post', { id: 'child', organizationId: 'org', parentPostId: 'post', deletedAt: new Date(), releaseId: 'child-lease' });
      if (kind === 'url') post.releaseURL = 'https://linkedin.com/comment/live';
      if (kind === 'autonomous') db.rows('settings')[0].value = { mode: 'AUTONOMOUS', revision: 4 };
      if (kind === 'scheduled') db.rows('engageOpportunityState')[0].status = 'SCHEDULED';
      if (kind === 'expired') db.rows('engageOpportunityState')[0].status = 'EXPIRED';
      if (kind === 'removed') db.rows('engageSentReply')[0].removedAt = new Date();
      await expect(service.resolveLegacyReplyRecovery('org', 'admin', 'reply', await confirmation(service)))
        .rejects.toThrow('LEGACY_REPLY_RECOVERY_UNSAFE');
      expect(post.releaseId).toBe('private-lease');
    });
  it('requires administrator authorization for diagnosis, mutation, and idempotent replay', async () => {
    const { db, service } = setup();
    await expect(service.getLegacyReplyRecovery('org', 'member', 'reply')).rejects.toThrow('ORGANIZATION_ADMIN_REQUIRED');
    const body = await confirmation(service);
    await expect(service.resolveLegacyReplyRecovery('org', 'member', 'reply', { ...body, expectedUserId: 'member' }))
      .rejects.toThrow('ORGANIZATION_ADMIN_REQUIRED');
    await service.resolveLegacyReplyRecovery('org', 'admin', 'reply', body);
    db.rows('userOrganization').find(row => row.userId === 'admin').role = 'USER';
    await expect(service.resolveLegacyReplyRecovery('org', 'admin', 'reply', body)).rejects.toThrow('ORGANIZATION_ADMIN_REQUIRED');
  });
  it.each(['executorStopped', 'noPendingSubmit', 'replyAbsent', 'evidence', 'expectedUserId'])(
    'requires explicit valid confirmation: %s', async field => {
      const { service } = setup();
      const body: any = await confirmation(service);
      body[field] = field === 'evidence' ? ' ' : field === 'expectedUserId' ? 'other' : false;
      await expect(service.resolveLegacyReplyRecovery('org', 'admin', 'reply', body)).rejects.toThrow();
    });
  it('does not expose another organization\'s reply', async () => {
    const { db, service } = setup();
    db.seed('userOrganization', { organizationId: 'other', userId: 'admin', role: 'ADMIN', disabled: false });
    await expect(service.getLegacyReplyRecovery('other', 'admin', 'reply')).rejects.toThrow('LEGACY_REPLY_NOT_FOUND');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSend, sendNow } from './support/send-fixture';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(sendNow); vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function unknownPost() {
  const context = setupSend();
  await context.create();
  const execution = await context.service.reserveApi('org', 'root', 'workflow', sendNow);
  await context.service.authorizeApiSegment('org', execution.id, 0, { id: '123', idNamespace: 'x.rest_id' }, sendNow);
  await context.service.apiOutcome('org', execution.id, 0, { eventId: 'lost', status: 'unknown' }, sendNow);
  Object.assign(context.db.rows('sendExecution')[0], { kind: 'EXTENSION', extensionNodeId: 'node' });
  context.db.seed('extensionNode', { id: 'node', organizationId: 'org', registeredByUserId: 'user' });
  vi.setSystemTime(new Date(sendNow.getTime() + 180000));
  return { ...context, execution };
}
const review = () => ({ eventId: 'review-one', expectedResolutionRevision: 0, reviewedNotSent: true as const, draftsClosed: true as const });

describe('attended review of an original unsent post', () => {
  it('returns only the original review identity and target without execution secrets', async () => {
    const { service, execution, projects } = await unknownPost();
    expect(await service.postReview('org', 'user', execution.id, 'root')).toEqual({ canReviewNotSent: true, expectedResolutionRevision: 0, targetAccount: { id: '123', idNamespace: 'x.rest_id', handle: 'alice' } });
    expect(projects.assertProjectAccess).toHaveBeenCalledWith('org', 'project');
  });
  it('settles non-submission once, releases held quota, and permits a separate original-intent retry', async () => {
    const { service, execution, db } = await unknownPost();
    expect(await service.reviewPostNotSent('org', 'user', execution.id, 'root', review())).toEqual({ status: 'retryable' });
    expect(db.rows('sendIntent')[0]).toMatchObject({ status: 'FAILED_FINAL', activeExecutionId: null });
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({ heldUnits: 0, confirmedUnits: 0 });
    expect(db.rows('post')[0]).toMatchObject({ state: 'ERROR' });
    await service.reviewPostNotSent('org', 'user', execution.id, 'root', review());
    expect(db.rows('sendExecution')[0].resolutionRevision).toBe(1);
    await service.retry('org', 'root', 'user');
    expect(db.rows('sendIntent')[0].status).toBe('QUEUED');
    await expect(service.reviewPostNotSent('org', 'user', execution.id, 'root', review())).rejects.toThrow('SEND_POST_REVIEW_NOT_SETTLED');
    expect(db.rows('sendIntent')[0].status).toBe('QUEUED');
  });
  it.each(['reviewedNotSent', 'draftsClosed'])('requires explicit %s acknowledgment', async key => {
    const { service, execution } = await unknownPost();
    await expect(service.reviewPostNotSent('org', 'user', execution.id, 'root', { ...review(), [key]: false } as any)).rejects.toThrow('SEND_POST_ABSENCE_REVIEW_REQUIRED');
  });
  it('requires the same resolution revision', async () => {
    const { service, execution } = await unknownPost();
    await expect(service.reviewPostNotSent('org', 'user', execution.id, 'root', { ...review(), expectedResolutionRevision: 1 })).rejects.toThrow('SEND_RESOLUTION_REVISION_CONFLICT');
  });
  it.each(['tenant', 'member', 'owner'])('rejects a wrong %s', async kind => {
    const { service, execution, db } = await unknownPost();
    if (kind === 'member') db.rows('userOrganization')[0].disabled = true;
    if (kind === 'owner') { db.rows('sendIntent')[0].policySnapshot.policyOwnerUserId = 'other'; db.rows('extensionNode')[0].registeredByUserId = 'other'; }
    await expect(service.postReview(kind === 'tenant' ? 'other' : 'org', 'user', execution.id, 'root')).rejects.toThrow();
  });
  it('accepts the original policy owner even when a different member owns the executor node', async () => {
    const { service, execution, db } = await unknownPost();
    db.rows('extensionNode')[0].registeredByUserId = 'other';
    expect(await service.postReview('org', 'user', execution.id, 'root')).toMatchObject({ canReviewNotSent: true });
  });
  it('accepts the original node owner when a different member originally scheduled the post', async () => {
    const { service, execution, db } = await unknownPost();
    db.rows('sendIntent')[0].policySnapshot.policyOwnerUserId = 'other';
    expect(await service.postReview('org', 'user', execution.id, 'root')).toMatchObject({ canReviewNotSent: true });
  });
  it('rejects confirmation recorded after the review was opened', async () => {
    const { service, execution, db } = await unknownPost();
    await service.postReview('org', 'user', execution.id, 'root');
    db.rows('sendSegment')[0].status = 'CONFIRMED';
    await expect(service.reviewPostNotSent('org', 'user', execution.id, 'root', review())).rejects.toThrow('SEND_POST_REVIEW_NOT_SETTLED');
    expect(db.rows('sendIntent')[0].status).toBe('RECONCILING');
  });
  it('rejects a confirmed segment in an earlier execution even when the intent flag is stale', async () => {
    const { service, execution, db } = await unknownPost();
    db.seed('sendExecution', { id: 'previous', sendIntentId: db.rows('sendIntent')[0].id, organizationId: 'org' });
    db.seed('sendSegment', { executionId: 'previous', organizationId: 'org', segmentIndex: 0, status: 'CONFIRMED' });
    await expect(service.reviewPostNotSent('org', 'user', execution.id, 'root', review())).rejects.toThrow('SEND_POST_REVIEW_NOT_SETTLED');
  });
  it.each(['permit', 'lease', 'newer', 'confirmed', 'thread', 'revision', 'root', 'account-writer', 'integration', 'provider'])('refuses unsafe %s state', async kind => {
    const { service, execution, db } = await unknownPost();
    const later = new Date(Date.now() + 30000);
    if (kind === 'permit') db.rows('sendSegment')[0].submitBefore = later;
    if (kind === 'lease') db.rows('sendExecution')[0].leaseExpiresAt = later;
    if (kind === 'newer') db.rows('sendIntent')[0].activeExecutionId = 'newer';
    if (kind === 'confirmed') db.rows('sendIntent')[0].hasConfirmedSegments = true;
    if (kind === 'thread') db.seed('sendSegment', { executionId: execution.id, organizationId: 'org', segmentIndex: 1, postId: 'child' });
    if (kind === 'revision') db.rows('sendIntent')[0].fencingVersion += 1;
    if (kind === 'root') db.rows('post')[0].sendIntentId = 'other';
    if (kind === 'integration') db.rows('post')[0].integrationId = 'other';
    if (kind === 'provider') db.rows('post')[0].providerIdentifier = 'reddit';
    if (kind === 'account-writer') db.rows('accountWriteState')[0].activeExecutionId = 'other';
    await expect(service.postReview('org', 'user', execution.id, 'root')).rejects.toThrow('SEND_POST_REVIEW_NOT_SETTLED');
  });
});

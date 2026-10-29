import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSend, sendNow } from './support/send-fixture';
const target = 'https://medium.com/p/96a513786bbd';
const url = 'https://medium.com/@alice/a-response-5cddb05e18b0';
const body = { expectedResolutionRevision: 0, status: 'confirmed' as const,
  eventId: 'verified', evidence: 'Exact full published response and author verified on the target story.',
  text: 'A full response.', targetUrl: target, url };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(sendNow); vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function setup(stopped = false) {
  const fixture = setupSend();
  await fixture.create();
  const e = await fixture.service.reserveApi('org', 'root', 'workflow', sendNow);
  await fixture.service.authorizeApiSegment('org', e.id, 0, { id: '123', idNamespace: 'x.rest_id' }, sendNow);
  await fixture.service.apiOutcome('org', e.id, 0, { status: 'unknown', eventId: 'uncertain' }, sendNow);
  vi.setSystemTime(new Date(sendNow.getTime() + 120_000));
  const execution = fixture.db.rows('sendExecution')[0];
  Object.assign(execution, { platform: 'medium', action: 'REPLY', target: { id: 'alice', idNamespace: 'medium.handle' },
    payload: [{ id: 'root', text: body.text, settings: JSON.stringify({ replyUrl: target }) }] });
  Object.assign(fixture.db.rows('sendIntent')[0], { action: 'REPLY', platform: 'medium' });
  fixture.db.seed('engageSentReply', { id: 'reply', organizationId: 'org', projectId: 'project', postId: 'root', opportunityId: 'opportunity' });
  if (stopped) await fixture.service.apiOutcome('org', e.id, 0, {
    status: 'definitely_not_submitted', eventId: 'stopped', stopped: true, evidence: 'Executor stopped without submitting.',
  }, new Date());
  return { ...fixture, execution };
}
describe('attended Medium reply verification', () => {
  it.each([false, true])('confirms the original reply and settles quota once, including a mistaken not-submitted receipt: %s', async stopped => {
    const { service, db, execution } = await setup(stopped);
    expect(await service.verifySavedReply('org', 'user', execution.id, 'reply', body)).toMatchObject({ status: 'confirmed', url });
    expect(await service.verifySavedReply('org', 'user', execution.id, 'reply', body)).toMatchObject({ status: 'confirmed', url });
    expect(db.rows('post')[0]).toMatchObject({ state: 'PUBLISHED', releaseURL: url, error: null });
    expect(db.rows('sendIntent')[0]).toMatchObject({ status: 'SUCCEEDED', activeExecutionId: null });
    expect(db.rows('sendExecution')[0]).toMatchObject({ status: 'SUCCEEDED', resolutionRevision: 1 });
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({ heldUnits: 0, confirmedUnits: 1 });
    expect(db.rows('accountWriteState')[0].rolloutReady).toBe(true);
  });
  it('restores retry only after an explicit absence review and an expired submission permit', async () => {
    const { service, db, execution } = await setup();
    const absent = { ...body, eventId: 'absent', status: 'definitely_not_submitted' as const, url: undefined, stopped: true };
    await expect(service.verifySavedReply('org', 'user', execution.id, 'reply', absent)).rejects.toThrow('REPLY_ABSENCE_REVIEW_REQUIRED');
    expect(await service.verifySavedReply('org', 'user', execution.id, 'reply', { ...absent, reviewedNotSent: true })).toEqual({ status: 'retryable' });
    expect(db.rows('sendIntent')[0]).toMatchObject({ status: 'FAILED_FINAL', activeExecutionId: null });
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({ heldUnits: 0, confirmedUnits: 0 });
  });
  it('matches the canonical story ID across custom-domain and /p/ target URLs', async () => {
    const { service, execution } = await setup();
    expect(await service.verifySavedReply('org', 'user', execution.id, 'reply', {
      ...body, targetUrl: 'https://web4.medium.com/linkspreed-releases-uiid-v2-13-96a513786bbd',
    })).toMatchObject({ status: 'confirmed' });
  });
  it('does not replay a retryable verdict after the original task has already been queued again', async () => {
    const { service, db, execution } = await setup();
    const absent = { ...body, eventId: 'absent', status: 'definitely_not_submitted' as const,
      url: undefined, stopped: true, reviewedNotSent: true };
    await service.verifySavedReply('org', 'user', execution.id, 'reply', absent);
    db.rows('sendIntent')[0].status = 'QUEUED';
    await expect(service.verifySavedReply('org', 'user', execution.id, 'reply', absent)).rejects.toThrow('SEND_RETRY_UNSAFE');
  });
  it('does not resolve an unknown send while its submission permit is still valid', async () => {
    const { service, db, execution } = await setup();
    db.rows('sendSegment')[0].submitBefore = new Date(Date.now() + 30_000);
    await expect(service.verifySavedReply('org', 'user', execution.id, 'reply', body)).rejects.toThrow('NOT_SETTLED');
  });
  it.each(['member', 'revision', 'target', 'text', 'author', 'newer', 'pending'])('refuses a mismatched or still-active verification: %s', async fault => {
    const { service, db, execution } = await setup();
    let user = 'user';
    const input = { ...body };
    if (fault === 'member') user = 'other';
    if (fault === 'revision') input.expectedResolutionRevision = 99;
    if (fault === 'target') input.targetUrl = 'https://medium.com/p/aaaaaaaaaaaa';
    if (fault === 'text') input.text = 'Another reply';
    if (fault === 'author') input.url = 'https://medium.com/@bob/a-response-5cddb05e18b0';
    if (fault === 'newer') db.rows('sendIntent')[0].fencingVersion++;
    if (fault === 'pending') execution.status = 'SENDING';
    await expect(service.verifySavedReply('org', user, execution.id, 'reply', input)).rejects.toThrow();
    expect(db.rows('post')[0].state).not.toBe('PUBLISHED');
  });
});

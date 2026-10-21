import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendModeService } from '../send-mode.service';
import { memorySendDatabase } from './support/memory-send-database';

const owner = { expectedOrganizationId: 'org', expectedUserId: 'user' };
const request = {
  ...owner,
  requestId: 'first',
  platform: 'x',
  contentHash: 'a'.repeat(64),
  postId: 'post',
};
function setup() {
  const db = memorySendDatabase();
  db.seed('userOrganization', {
    organizationId: 'org',
    userId: 'user',
    role: 'ADMIN',
    disabled: false,
  });
  db.seed('post', {
    id: 'post',
    organizationId: 'org',
    state: 'DRAFT',
    providerIdentifier: 'x',
    publishDate: new Date(),
  });
  return { db, service: new SendModeService(db) };
}
beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());
describe('saved browser write retries after definite non-submission', () => {
  it('admits a fresh request for saved content after definite non-submission while denying the old request a grant', async () => {
    const { service } = setup();
    const first = await service.beginBrowserWrite('org', 'user', request);
    await service.settleBrowserWrite('org', 'user', first.id, {
      ...owner,
      status: 'NOT_SUBMITTED',
    });
    expect(
      await service.beginBrowserWrite('org', 'user', request)
    ).toMatchObject({ id: first.id, admitted: false, status: 'NOT_SUBMITTED' });
    expect(
      await service.beginBrowserWrite('org', 'user', {
        ...request,
        requestId: 'retry',
      })
    ).toMatchObject({ admitted: true, status: 'AUTHORIZED' });
  });
  it('serializes concurrent fresh retries so saved content receives only one grant', async () => {
    const { service } = setup();
    const first = await service.beginBrowserWrite('org', 'user', request);
    await service.settleBrowserWrite('org', 'user', first.id, {
      ...owner,
      status: 'NOT_SUBMITTED',
    });
    const outcomes = await Promise.allSettled(
      ['retry-a', 'retry-b'].map((requestId) =>
        service.beginBrowserWrite('org', 'user', { ...request, requestId })
      )
    );
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled')
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected')
    ).toHaveLength(1);
  });
  it.each(['AUTHORIZED', 'UNKNOWN', 'CONFIRMED'] as const)(
    'never retries saved content while its original receipt is %s',
    async (status) => {
      const { service } = setup();
      const first = await service.beginBrowserWrite('org', 'user', request);
      if (status !== 'AUTHORIZED')
        await service.settleBrowserWrite('org', 'user', first.id, {
          ...owner,
          status,
        });
      await expect(
        service.beginBrowserWrite('org', 'user', {
          ...request,
          requestId: 'retry',
        })
      ).rejects.toThrow(
        status === 'CONFIRMED'
          ? 'AUTONOMOUS_EFFECT_CONTENT_ALREADY_ADMITTED'
          : 'AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED'
      );
    }
  );
  it('admits an explicit retry after a proven unsent queue failure was backfilled as ERROR', async () => {
    const { db, service } = setup();
    const first = await service.beginBrowserWrite('org', 'user', request);
    await service.settleBrowserWrite('org', 'user', first.id, { ...owner, status: 'NOT_SUBMITTED' });
    // The publish queue reports its failed attempt before the person clicks Retry.
    db.rows('post')[0].state = 'ERROR';
    expect(await service.beginBrowserWrite('org', 'user', { ...request, requestId: 'retry' }))
      .toMatchObject({ admitted: true, status: 'AUTHORIZED' });
    expect(await service.beginBrowserWrite('org', 'user', request))
      .toMatchObject({ id: first.id, admitted: false, status: 'NOT_SUBMITTED' });
  });
  it.each(['UNTRACKED', 'AUTHORIZED', 'UNKNOWN', 'CONFIRMED'] as const)(
    'does not use an ERROR row with %s evidence as retry authorization', async status => {
      const { db, service } = setup();
      if (status !== 'UNTRACKED') {
        const first = await service.beginBrowserWrite('org', 'user', request);
        if (status !== 'AUTHORIZED') await service.settleBrowserWrite('org', 'user', first.id, { ...owner, status });
      }
      db.rows('post')[0].state = 'ERROR';
      await expect(service.beginBrowserWrite('org', 'user', { ...request, requestId: 'retry' }))
        .rejects.toThrow('BROWSER_WRITE_CONTENT_REQUIRED');
    }
  );
  it.each(['PENDING', 'CONTROLLED'] as const)(
    'does not reopen proven unsent ERROR content when the organization is %s', async mode => {
      const { db, service } = setup();
      const first = await service.beginBrowserWrite('org', 'user', request);
      await service.settleBrowserWrite('org', 'user', first.id, { ...owner, status: 'NOT_SUBMITTED' });
      db.rows('post')[0].state = 'ERROR';
      if (mode === 'PENDING') db.seed('post', { id: 'draining', organizationId: 'org', state: 'QUEUE', releaseId: 'lease', claimedAt: new Date(), publishDate: new Date() });
      await service.save('org', 'user', { ...owner, mode: 'CONTROLLED', expectedRevision: 0, requestId: 'switch' });
      await expect(service.beginBrowserWrite('org', 'user', { ...request, requestId: 'retry' }))
        .rejects.toThrow('SEND_MODE_AUTONOMOUS_REQUIRED');
    }
  );
  it('requires the same saved content fingerprint for an ERROR retry', async () => {
    const { db, service } = setup();
    const first = await service.beginBrowserWrite('org', 'user', request);
    await service.settleBrowserWrite('org', 'user', first.id, { ...owner, status: 'NOT_SUBMITTED' });
    db.rows('post')[0].state = 'ERROR';
    await expect(service.beginBrowserWrite('org', 'user', { ...request, requestId: 'retry', contentHash: 'b'.repeat(64) }))
      .rejects.toThrow('BROWSER_WRITE_CONTENT_REQUIRED');
  });

  it('serializes fresh retries after the failed queue row becomes ERROR', async () => {
    const { db, service } = setup();
    const first = await service.beginBrowserWrite('org', 'user', request);
    await service.settleBrowserWrite('org', 'user', first.id, { ...owner, status: 'NOT_SUBMITTED' });
    db.rows('post')[0].state = 'ERROR';
    const retries = await Promise.allSettled(['retry-a', 'retry-b'].map(requestId =>
      service.beginBrowserWrite('org', 'user', { ...request, requestId })));
    expect(retries.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(retries.filter(result => result.status === 'rejected')).toHaveLength(1);
  });
  it('does not let older non-submission proof override a newer uncertain attempt', async () => {
    const { db, service } = setup();
    const first = await service.beginBrowserWrite('org', 'user', request);
    await service.settleBrowserWrite('org', 'user', first.id, { ...owner, status: 'NOT_SUBMITTED' });
    db.rows('post')[0].state = 'ERROR';
    const retry = await service.beginBrowserWrite('org', 'user', { ...request, requestId: 'retry' });
    await service.settleBrowserWrite('org', 'user', retry.id, { ...owner, status: 'UNKNOWN' });
    await expect(service.beginBrowserWrite('org', 'user', { ...request, requestId: 'again' }))
      .rejects.toThrow('AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
  });
  it('does not retry an ERROR row that already carries a platform permalink', async () => {
    const { db, service } = setup();
    const first = await service.beginBrowserWrite('org', 'user', request);
    await service.settleBrowserWrite('org', 'user', first.id, { ...owner, status: 'NOT_SUBMITTED' });
    Object.assign(db.rows('post')[0], { state: 'ERROR', releaseURL: 'https://x.com/u/status/live' });
    await expect(service.beginBrowserWrite('org', 'user', { ...request, requestId: 'retry' }))
      .rejects.toThrow('BROWSER_WRITE_CONTENT_REQUIRED');
  });

});

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
});

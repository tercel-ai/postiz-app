import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendModeService } from '../send-mode.service';
import { memorySendDatabase } from './support/memory-send-database';
const owner = { expectedOrganizationId: 'org', expectedUserId: 'user' };
const begin = {
  ...owner,
  requestId: 'write',
  platform: 'x',
  contentHash: 'a'.repeat(64),
};
const change = {
  mode: 'CONTROLLED' as const,
  expectedRevision: 0,
  requestId: 'switch',
  expectedOrganizationId: 'org',
  expectedUserId: 'user',
};
function setup() {
  const db = memorySendDatabase();
  db.seed('userOrganization', {
    organizationId: 'org',
    userId: 'user',
    role: 'ADMIN',
    disabled: false,
  });
  db.seed('userOrganization', {
    organizationId: 'org',
    userId: 'other',
    role: 'ADMIN',
    disabled: false,
  });
  return { db, service: new SendModeService(db) };
}
beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());
describe('durable browser write admission', () => {
  it('accepts delayed browser proof after operator confirmation and protects the enriched conclusion', async () => {
    const { db, service } = setup();
    const permit = await service.beginBrowserWrite('org', 'user', begin);
    await service.resolveAutonomousEffect('org', 'user', permit.id, {
      ...owner, requestId: 'resolve', expectedRevision: 1, decision: 'CONFIRMED',
      executorStopped: true, noPendingSubmit: true, evidence: 'Worker stopped; remote post verified.',
    });
    const outcome = { ...owner, status: 'CONFIRMED' as const, platformPostId: 'remote' };
    await expect(service.settleBrowserWrite('org', 'user', permit.id, outcome))
      .resolves.toMatchObject({ status: 'CONFIRMED' });
    const receipt = db.rows('sendMutationReceipt').find(row => row.id === permit.id);
    expect(receipt.result).toMatchObject({
      status: 'CONFIRMED', hasResult: true, result: { postId: 'remote' },
      evidence: 'Worker stopped; remote post verified.', resolvedByUserId: 'user',
    });
    await expect(service.settleBrowserWrite('org', 'user', permit.id, outcome))
      .resolves.toMatchObject({ status: 'CONFIRMED' });
    await expect(service.settleBrowserWrite('org', 'user', permit.id, {
      ...outcome, platformPostId: 'different',
    })).rejects.toThrow('BROWSER_WRITE_OUTCOME_CONFLICT');
  });
  it('does not invent platform proof or reopen an operator NOT_SUBMITTED conclusion', async () => {
    const { db, service } = setup();
    const permit = await service.beginBrowserWrite('org', 'user', begin);
    await service.resolveAutonomousEffect('org', 'user', permit.id, {
      ...owner, requestId: 'resolve', expectedRevision: 1, decision: 'CONFIRMED',
      executorStopped: true, noPendingSubmit: true, evidence: 'Worker stopped; remote post verified.',
    });
    await expect(service.settleBrowserWrite('org', 'user', permit.id, {
      ...owner, status: 'CONFIRMED',
    })).resolves.toMatchObject({ status: 'CONFIRMED' });
    const receipt = db.rows('sendMutationReceipt').find(row => row.id === permit.id);
    expect(receipt.result.hasResult).not.toBe(true);
    await service.settleBrowserWrite('org', 'user', permit.id, {
      ...owner, status: 'CONFIRMED', platformPostId: 'remote',
    });
    const other = await service.beginBrowserWrite('org', 'user', { ...begin, requestId: 'not-submitted' });
    await service.resolveAutonomousEffect('org', 'user', other.id, {
      ...owner, requestId: 'resolve-not-submitted', expectedRevision: 1, decision: 'NOT_SUBMITTED',
      executorStopped: true, noPendingSubmit: true, evidence: 'Worker stopped before dispatch.',
    });
    await expect(service.settleBrowserWrite('org', 'user', other.id, {
      ...owner, status: 'CONFIRMED', platformPostId: 'unexpected',
    })).rejects.toThrow('BROWSER_WRITE_OUTCOME_CONFLICT');
  });
  it('tracks an unsaved manual write before switching and never grants a replay', async () => {
    const { service } = setup();
    const permit = await service.beginBrowserWrite('org', 'user', begin);
    expect(permit).toMatchObject({
      admitted: true,
      status: 'AUTHORIZED',
      organizationId: 'org',
      userId: 'user',
    });
    expect(await service.beginBrowserWrite('org', 'user', begin)).toMatchObject(
      { id: permit.id, admitted: false }
    );
    expect(await service.save('org', 'user', change)).toMatchObject({
      mode: 'AUTONOMOUS',
      transition: { remainingCount: 1 },
    });
    await service.reconcilePendingTransitions();
    expect((await service.get('org', 'user')).mode).toBe('AUTONOMOUS');
    await service.settleBrowserWrite('org', 'user', permit.id, {
      ...owner,
      status: 'CONFIRMED',
      platformPostId: 'remote',
      url: 'https://x.com/user/status/remote',
    });
    await service.reconcilePendingTransitions();
    expect((await service.get('org', 'user')).mode).toBe('CONTROLLED');
    expect(await service.beginBrowserWrite('org', 'user', begin)).toMatchObject(
      { admitted: false, status: 'CONFIRMED' }
    );
  });
  it('allows captured saved content but rejects unsaved or foreign content during a switch', async () => {
    const { db, service } = setup();
    db.seed('post', {
      id: 'queued',
      organizationId: 'org',
      state: 'QUEUE',
      releaseId: 'lease',
      claimedAt: new Date(),
      providerIdentifier: 'x',
      publishDate: new Date(),
    });
    db.seed('post', {
      id: 'foreign',
      organizationId: 'foreign',
      state: 'QUEUE',
      providerIdentifier: 'x',
      publishDate: new Date(),
    });
    await service.save('org', 'user', change);
    await expect(
      service.beginBrowserWrite('org', 'user', begin)
    ).rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
    await expect(
      service.beginBrowserWrite('org', 'user', { ...begin, postId: 'foreign' })
    ).rejects.toThrow('BROWSER_WRITE_CONTENT_REQUIRED');
    expect(
      await service.beginBrowserWrite('org', 'user', {
        ...begin,
        postId: 'queued',
      })
    ).toMatchObject({ admitted: true });
  });
  it('resolves a saved engage reply through organization-scoped records and compares platform', async () => {
    const { db, service } = setup();
    db.seed('post', {
      id: 'reply-post',
      organizationId: 'org',
      state: 'DRAFT',
      source: 'engage',
    });
    db.seed('engageSentReply', {
      id: 'reply',
      organizationId: 'org',
      postId: 'reply-post',
      opportunityId: 'opportunity',
    });
    db.seed('engageOpportunity', { id: 'opportunity', platform: 'reddit' });
    await expect(
      service.beginBrowserWrite('org', 'user', {
        ...begin,
        sentReplyId: 'reply',
      })
    ).rejects.toThrow('BROWSER_WRITE_PLATFORM_CHANGED');
    const result = await service.beginBrowserWrite('org', 'user', {
      ...begin,
      platform: 'reddit',
      sentReplyId: 'reply',
    });
    expect(result.admitted).toBe(true);
    expect(db.rows('sendMutationReceipt')[0].result).toMatchObject({
      action: 'COMMENT',
      source: 'BROWSER',
      postIds: ['reply-post'],
      integrationId: 'browser:user:reddit',
    });
  });
  it('denies another unresolved admission on the same browser actor and changed idempotent payload', async () => {
    const { service } = setup();
    await service.beginBrowserWrite('org', 'user', begin);
    await expect(
      service.beginBrowserWrite('org', 'user', {
        ...begin,
        requestId: 'second',
      })
    ).rejects.toThrow('AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
    await expect(
      service.beginBrowserWrite('org', 'user', {
        ...begin,
        contentHash: 'b'.repeat(64),
      })
    ).rejects.toThrow('AUTONOMOUS_EFFECT_REQUEST_CONFLICT');
  });
  it('keeps unknown writes blocking until confirmed and protects owner and organization on callbacks', async () => {
    const { service } = setup();
    const permit = await service.beginBrowserWrite('org', 'user', begin);
    await expect(
      service.settleBrowserWrite('org', 'other', permit.id, {
        ...owner,
        expectedUserId: 'other',
        status: 'CONFIRMED',
      })
    ).rejects.toThrow('BROWSER_WRITE_OWNER_REQUIRED');
    await expect(
      service.settleBrowserWrite('foreign', 'user', permit.id, {
        ...owner,
        status: 'CONFIRMED',
      })
    ).rejects.toThrow();
    await service.settleBrowserWrite('org', 'user', permit.id, {
      ...owner,
      status: 'UNKNOWN',
    });
    expect(await service.save('org', 'user', change)).toMatchObject({
      transition: { status: 'NEEDS_ATTENTION' },
    });
    await service.settleBrowserWrite('org', 'user', permit.id, {
      ...owner,
      status: 'CONFIRMED',
      platformPostId: 'remote',
    });
    await service.reconcilePendingTransitions();
    expect((await service.get('org', 'user')).mode).toBe('CONTROLLED');
    await service.settleBrowserWrite('org', 'user', permit.id, {
      ...owner,
      status: 'CONFIRMED',
      platformPostId: 'remote',
    });
    await expect(
      service.settleBrowserWrite('org', 'user', permit.id, {
        ...owner,
        status: 'NOT_SUBMITTED',
      })
    ).rejects.toThrow('BROWSER_WRITE_OUTCOME_CONFLICT');
  });
  it('never grants a captured saved occurrence after its scheduled identity changes', async () => {
    const { db, service } = setup();
    db.seed('post', {
      id: 'queued',
      organizationId: 'org',
      state: 'QUEUE',
      releaseId: 'lease',
      claimedAt: new Date(),
      providerIdentifier: 'x',
      publishDate: new Date('2026-10-20'),
    });
    await service.save('org', 'user', change);
    db.rows('post')[0].publishDate = new Date('2026-10-21');
    await expect(
      service.beginBrowserWrite('org', 'user', { ...begin, postId: 'queued' })
    ).rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
    expect(await service.get('org', 'user')).toMatchObject({
      transition: {
        status: 'NEEDS_ATTENTION',
        waitReason: 'RECONCILIATION_REQUIRED',
      },
    });
  });
  it.each([false, true])(
    'serializes begin racing a zero-backlog switch (switchFirst=%s)',
    async (switchFirst) => {
      const { service } = setup();
      const writes = [
        () => service.beginBrowserWrite('org', 'user', begin),
        () => service.save('org', 'user', change),
      ];
      if (switchFirst) writes.reverse();
      await Promise.allSettled(writes.map((work) => work()));
      const state = await service.get('org', 'user');
      expect(
        state.mode === 'CONTROLLED'
          ? state.blockers.autonomousEffects
          : state.transition?.remainingCount
      ).toBe(state.mode === 'CONTROLLED' ? 0 : 1);
    }
  );
  it('binds both admissions and callbacks to the displayed owner before any receipt mutation', async () => {
    const { db, service } = setup();
    await expect(
      service.beginBrowserWrite('org', 'user', {
        ...begin,
        expectedOrganizationId: 'other',
      })
    ).rejects.toThrow('SEND_OWNER_CHANGED');
    expect(db.rows('sendMutationReceipt')).toHaveLength(0);
    const permit = await service.beginBrowserWrite('org', 'user', begin);
    await expect(
      service.settleBrowserWrite('org', 'user', permit.id, {
        ...owner,
        expectedUserId: 'other',
        status: 'CONFIRMED',
      })
    ).rejects.toThrow('SEND_OWNER_CHANGED');
    expect(db.rows('sendMutationReceipt')[0].result.status).toBe('AUTHORIZED');
  });
  it('allows safe NOT_SUBMITTED settlement once but never changes terminal conclusions', async () => {
    const { service } = setup();
    const permit = await service.beginBrowserWrite('org', 'user', begin);
    await service.settleBrowserWrite('org', 'user', permit.id, {
      ...owner,
      status: 'NOT_SUBMITTED',
    });
    await service.settleBrowserWrite('org', 'user', permit.id, {
      ...owner,
      status: 'NOT_SUBMITTED',
    });
    await expect(
      service.settleBrowserWrite('org', 'user', permit.id, {
        ...owner,
        status: 'CONFIRMED',
      })
    ).rejects.toThrow('BROWSER_WRITE_OUTCOME_CONFLICT');
    expect(await service.beginBrowserWrite('org', 'user', begin)).toMatchObject(
      { admitted: false, status: 'NOT_SUBMITTED' }
    );
  });
});

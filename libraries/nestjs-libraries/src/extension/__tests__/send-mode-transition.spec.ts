import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendModeService, organizationSendModeKey } from '../send-mode.service';
import { memorySendDatabase } from './support/memory-send-database';

const change = (revision = 0, requestId = 'request') => ({
  mode: 'CONTROLLED' as const,
  expectedRevision: revision,
  requestId,
  expectedOrganizationId: 'org',
  expectedUserId: 'admin',
});
function setup() {
  const db = memorySendDatabase();
  db.seed('userOrganization', {
    organizationId: 'org',
    userId: 'admin',
    role: 'ADMIN',
    disabled: false,
  });
  const service = new SendModeService(db);
  const post = (id: string, extra = {}) =>
    db.seed('post', {
      id,
      organizationId: 'org',
      state: 'QUEUE',
      executionProtocol: null,
      publishDate: new Date('2026-10-20T10:00:00Z'),
      ...extra,
    });
  return { db, service, post };
}
beforeEach(() => {
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T09:00:00Z'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('durable sending mode transitions', () => {
  it('snapshots overlapping queued and claimed work once and preserves unsent drafts', async () => {
    const { db, service, post } = setup();
    post('queued', { releaseId: 'lease', claimedAt: new Date() });
    post('draft', { state: 'DRAFT', source: 'engage' });
    const first = await service.save('org', 'admin', change());
    expect(first).toMatchObject({
      mode: 'AUTONOMOUS',
      autonomousAllowed: true,
      revision: 1,
      transition: {
        targetMode: 'CONTROLLED',
        status: 'DRAINING',
        initialPendingCount: 1,
        remainingCount: 1,
        completedCount: 0,
        scheduledNotBefore: '2026-10-20T10:00:00.000Z',
        estimatedCompletionAt: null,
      },
    });
    expect(await service.save('org', 'admin', change())).toEqual(first);
    expect(db.rows('post').find((p: any) => p.id === 'draft').state).toBe(
      'DRAFT'
    );
    await expect(service.assertAutonomousIn(db, 'org')).rejects.toThrow(
      'SEND_MODE_TRANSITION_PENDING'
    );
    await expect(
      service.assertAutonomousIn(db, 'org', ['queued'])
    ).resolves.toBeDefined();
    await expect(
      service.assertAutonomousIn(db, 'org', ['queued', 'new'])
    ).rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
    expect(await service.autonomousDrainPostIdsIn(db, 'org')).toEqual([
      'queued',
    ]);
  });
  it('completes in the reconciler after the captured work settles without a GET completing it', async () => {
    const { db, service, post } = setup();
    post('queued');
    await service.save('org', 'admin', change());
    db.rows('post')[0].state = 'PUBLISHED';
    expect(await service.get('org', 'admin')).toMatchObject({
      mode: 'AUTONOMOUS',
      transition: { remainingCount: 0 },
    });
    await service.reconcilePendingTransitions();
    expect(await service.get('org', 'admin')).toMatchObject({
      mode: 'CONTROLLED',
      revision: 2,
      transition: null,
    });
    await service.reconcilePendingTransitions();
    expect((await service.get('org', 'admin')).revision).toBe(2);
  });
  it('does not block on an unclaimed engage draft', async () => {
    const { service, post } = setup();
    post('draft', { state: 'DRAFT', source: 'engage' });
    expect(await service.save('org', 'admin', change())).toMatchObject({
      mode: 'CONTROLLED',
      transition: null,
    });
  });
  it('shows uncertain sends as requiring attention and completes only after settlement', async () => {
    const { db, service, post } = setup();
    post('queued');
    db.seed('sendMutationReceipt', {
      organizationId: 'org',
      userId: 'admin',
      operation: 'autonomous-side-effect',
      requestId: 'effect',
      requestHash: 'hash',
      result: {
        status: 'UNKNOWN',
        revision: 2,
        action: 'POST',
        integrationId: 'account',
        postIds: ['queued'],
        occurrenceKey: 'single',
        recurring: false,
      },
    });
    expect(await service.save('org', 'admin', change())).toMatchObject({
      transition: {
        status: 'NEEDS_ATTENTION',
        waitReason: 'RECONCILIATION_REQUIRED',
        initialPendingCount: 1,
        remainingCount: 1,
      },
    });
    db.rows('post')[0].state = 'PUBLISHED';
    await service.reconcilePendingTransitions();
    expect((await service.get('org', 'admin')).mode).toBe('AUTONOMOUS');
    db
      .rows('sendMutationReceipt')
      .find(
        (r: any) => r.operation === 'autonomous-side-effect'
      ).result.status = 'CONFIRMED';
    await service.reconcilePendingTransitions();
    expect((await service.get('org', 'admin')).mode).toBe('CONTROLLED');
  });
  it('retains the transition when capability is disabled or its requester loses management access', async () => {
    const { db, service, post } = setup();
    post('queued');
    await service.save('org', 'admin', change());
    db.rows('post')[0].state = 'PUBLISHED';
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
    await service.reconcilePendingTransitions();
    expect(await service.get('org', 'admin')).toMatchObject({
      transition: { status: 'NEEDS_ATTENTION', waitReason: 'SYSTEM_DISABLED' },
    });
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
    db.rows('userOrganization')[0].role = 'USER';
    await service.reconcilePendingTransitions();
    expect((await service.get('org', 'admin')).mode).toBe('AUTONOMOUS');
  });
  it('cancels with owner, role, revision and idempotency protections', async () => {
    const { db, service, post } = setup();
    post('queued');
    await service.save('org', 'admin', change());
    const { mode, ...body } = change(1, 'cancel');
    const tasksBefore = structuredClone(db.rows('post'));
    const result = await service.cancelTransition('org', 'admin', body);
    expect(result).toMatchObject({
      mode: 'AUTONOMOUS',
      revision: 2,
      transition: null,
    });
    expect(db.rows('post')).toEqual(tasksBefore);
    expect(await service.cancelTransition('org', 'admin', body)).toEqual(
      result
    );
    await expect(
      service.cancelTransition('org', 'admin', { ...body, requestId: 'stale' })
    ).rejects.toThrow('SEND_MODE_REVISION_CONFLICT');
    await expect(service.assertAutonomousIn(db, 'org')).resolves.toBeDefined();
  });
  it.each(['organization', 'user', 'role', 'disabled', 'membership'] as const)(
    'rejects cancellation after %s changes without mutating tasks or the pending request',
    async (changed) => {
      const { db, service, post } = setup();
      post('queued', { releaseId: 'lease', claimedAt: new Date() });
      await service.save('org', 'admin', change());
      const { mode, ...body } = change(1, 'cancel');
      if (changed === 'organization') body.expectedOrganizationId = 'other';
      if (changed === 'user') body.expectedUserId = 'other';
      if (changed === 'role') db.rows('userOrganization')[0].role = 'USER';
      if (changed === 'disabled') db.rows('userOrganization')[0].disabled = true;
      if (changed === 'membership') db.rows('userOrganization').splice(0);
      const before = structuredClone({
        posts: db.rows('post'),
        settings: db.rows('settings'),
        receipts: db.rows('sendMutationReceipt'),
      });
      await expect(service.cancelTransition('org', 'admin', body)).rejects.toMatchObject({
        status: 403,
      });
      expect({
        posts: db.rows('post'),
        settings: db.rows('settings'),
        receipts: db.rows('sendMutationReceipt'),
      }).toEqual(before);
    }
  );
  it('fails closed on malformed pending configuration', async () => {
    const { db, service } = setup();
    db.seed('settings', {
      key: organizationSendModeKey('org'),
      value: {
        mode: 'AUTONOMOUS',
        revision: 1,
        transition: { targetMode: 'CONTROLLED' },
      },
    });
    await expect(service.get('org', 'admin')).rejects.toThrow(
      'SEND_MODE_CONFIGURATION_INVALID'
    );
  });
  it('keeps scheduled recurring templates intact and explicitly requests user action', async () => {
    const { db, service, post } = setup();
    post('recurring', { intervalInDays: 2 });
    const before = structuredClone(db.rows('post'));
    expect(await service.save('org', 'admin', change())).toMatchObject({
      transition: {
        status: 'NEEDS_ATTENTION',
        waitReason: 'RECURRING_SCHEDULE',
        remainingCount: 1,
        estimatedCompletionAt: null,
      },
    });
    expect(db.rows('post')).toEqual(before);
    await service.reconcilePendingTransitions();
    expect((await service.get('org', 'admin')).mode).toBe('AUTONOMOUS');
  });
  it('fences fresh effects, permits only captured post occurrences, and replays a settled receipt after automatic switching', async () => {
    const { db, service, post } = setup();
    post('queued');
    db.seed('integration', {
      id: 'account',
      organizationId: 'org',
      disabled: false,
    });
    await service.save('org', 'admin', change());
    const work = vi.fn().mockResolvedValue([{ postId: 'remote' }]);
    const request = {
      integrationId: 'account',
      action: 'POST' as const,
      postIds: ['queued'],
      occurrenceKey: 'single',
    };
    await expect(
      service.autonomousEffect(
        'org',
        'new-plug',
        { integrationId: 'account', action: 'PLUG' },
        work
      )
    ).rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
    await expect(
      service.autonomousEffect(
        'org',
        'new-post',
        { ...request, postIds: ['new'] },
        work
      )
    ).rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
    db.rows('post')[0].publishDate = new Date('2026-10-21T10:00:00Z');
    await expect(
      service.autonomousEffect('org', 'changed-date', request, work)
    ).rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
    db.rows('post')[0].publishDate = new Date('2026-10-20T10:00:00Z');
    await service.autonomousEffect('org', 'captured', request, work);
    await service.reconcilePendingTransitions();
    expect((await service.get('org', 'admin')).mode).toBe('AUTONOMOUS');
    db.rows('post')[0].state = 'PUBLISHED';
    await service.reconcilePendingTransitions();
    expect((await service.get('org', 'admin')).mode).toBe('CONTROLLED');
    expect(
      await service.autonomousEffect('org', 'captured', request, work)
    ).toEqual([{ postId: 'remote' }]);
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('never completes when an uncaptured queue admission is detected', async () => {
    const { db, service, post } = setup();
    post('captured');
    await service.save('org', 'admin', change());
    db.rows('post')[0].state = 'PUBLISHED';
    post('unexpected');
    expect(await service.get('org', 'admin')).toMatchObject({
      transition: { status: 'NEEDS_ATTENTION', remainingCount: 1 },
    });
    await expect(
      service.assertAutonomousIn(db, 'org', ['unexpected'])
    ).rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
    await service.reconcilePendingTransitions();
    expect((await service.get('org', 'admin')).mode).toBe('AUTONOMOUS');
  });
  it('serializes a final reconciliation racing a new autonomous admission', async () => {
    const { db, service, post } = setup();
    post('captured');
    await service.save('org', 'admin', change());
    db.rows('post')[0].state = 'PUBLISHED';
    const outcomes = await Promise.allSettled([
      service.reconcilePendingTransitions(),
      db.$transaction(async (tx: any) => {
        await service.assertAutonomousIn(tx, 'org');
        await tx.post.create({
          data: { id: 'new', organizationId: 'org', state: 'QUEUE' },
        });
      }),
    ]);
    expect(outcomes[0].status).toBe('fulfilled');
    expect(outcomes[1].status).toBe('rejected');
    expect(db.rows('post').some((p: any) => p.id === 'new')).toBe(false);
    expect((await service.get('org', 'admin')).mode).toBe('CONTROLLED');
  });
  it('deduplicates multiple uncertain effects sharing a captured post and counts standalone effects once', async () => {
    const { db, service, post } = setup();
    post('queued');
    for (const id of ['one', 'two'])
      db.seed('sendMutationReceipt', {
        organizationId: 'org',
        operation: 'autonomous-side-effect',
        requestId: id,
        result: {
          status: 'UNKNOWN',
          revision: 1,
          action: 'POST',
          integrationId: 'account',
          postIds: ['queued'],
          occurrenceKey: 'single',
          recurring: false,
        },
      });
    db.seed('sendMutationReceipt', {
      organizationId: 'org',
      operation: 'autonomous-side-effect',
      requestId: 'standalone',
      result: {
        status: 'UNKNOWN',
        revision: 1,
        action: 'PLUG',
        integrationId: 'account',
      },
    });
    expect(await service.save('org', 'admin', change())).toMatchObject({
      transition: { initialPendingCount: 2, remainingCount: 2 },
    });
  });

  it('isolates corrupt pending configuration so another organization can still complete', async () => {
    const { db, service, post } = setup();
    db.seed('settings', {
      key: organizationSendModeKey('broken'),
      value: { mode: 'AUTONOMOUS', revision: 1, transition: { version: 1 } },
    });
    post('queued');
    await service.save('org', 'admin', change());
    db.rows('post')[0].state = 'PUBLISHED';
    await service.reconcilePendingTransitions();
    expect((await service.get('org', 'admin')).mode).toBe('CONTROLLED');
  });
});

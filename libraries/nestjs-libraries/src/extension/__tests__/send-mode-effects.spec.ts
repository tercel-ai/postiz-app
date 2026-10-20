import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendModeService } from '../send-mode.service';
import { memorySendDatabase } from './support/memory-send-database';
import { sendHash } from '../send-coordination.utils';

function setup() {
  const db = memorySendDatabase();
  db.seed('userOrganization', {
    organizationId: 'org',
    userId: 'admin',
    role: 'ADMIN',
    disabled: false,
  });
  db.seed('integration', {
    id: 'account',
    organizationId: 'org',
    disabled: false,
    deletedAt: null,
  });
  return { db, service: new SendModeService(db) };
}
const change = (mode: 'CONTROLLED' | 'AUTONOMOUS', expectedRevision = 0) => ({
  mode,
  expectedRevision,
  requestId: 'mode',
  expectedOrganizationId: 'org',
  expectedUserId: 'admin',
});
const request = {
  integrationId: 'account',
  action: 'PLUG' as const,
  postId: 'post',
};
beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());

describe('durable autonomous side effects', () => {
  it.each([false, true])('follows the stored parent chain past unrelated same-group roots (recurring=%s)', async (recurring) => {
    const { db, service } = setup();
    const date = '2026-10-20T00:00:00.000Z';
    const base = {
      organizationId: 'org', state: 'QUEUE', executionProtocol: null,
      sendIntentId: null, group: 'chain', publishDate: new Date(date),
    };
    // Cycle clones intentionally have neither a parent nor sourcePostId.
    db.seed('post', { ...base, id: 'unrelated-root', parentPostId: null, intervalInDays: null });
    db.seed('post', { ...base, id: 'root', parentPostId: null, intervalInDays: recurring ? 1 : null });
    db.seed('post', { ...base, id: 'child', parentPostId: 'root' });
    db.seed('post', { ...base, id: 'grandchild', parentPostId: 'child' });
    await service.autonomousEffect('org', 'root-post', {
      integrationId: 'account', action: 'POST', postIds: ['root'],
      occurrenceKey: recurring ? date : 'single',
    }, async () => [{ postId: 'remote-root' }]);
    const work = vi.fn().mockResolvedValue([{ postId: 'remote-grandchild' }]);
    expect(await service.autonomousEffect('org', 'grandchild-comment', {
      integrationId: 'account', action: 'COMMENT', postIds: ['grandchild'],
      parentPostId: 'remote-root', occurrenceKey: 'remote-root',
    }, work)).toEqual([{ postId: 'remote-grandchild' }]);
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('records actual confirmation time and trusted quota metadata for an autonomous write', async () => {
    const { db, service } = setup();
    const before = Date.now();
    await service.autonomousEffect('org', 'known-reply', {
      ...request, quotaWriteKind: 'REPLY', quotaUnits: 1,
    }, async () => true);
    const result = db.rows('sendMutationReceipt')[0].result;
    expect(result).toMatchObject({ status: 'CONFIRMED', quotaWriteKind: 'REPLY', quotaUnits: 1 });
    expect(new Date(result.confirmedAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(result.confirmedAt).getTime()).toBeLessThanOrEqual(Date.now());
  });
  it('records a false plug result as zero writes and infers a thread finisher as one reply', async () => {
    const { db, service } = setup();
    await service.autonomousEffect('org', 'no-plug-action', {
      ...request, quotaWriteKind: 'REPLY', quotaUnits: 1,
    }, async () => false);
    expect(db.rows('sendMutationReceipt')[0].result).toMatchObject({ quotaWriteKind: 'REPLY', quotaUnits: 0 });
    await service.autonomousEffect('org', 'finisher', {
      integrationId: 'account', action: 'THREAD_FINISHER', mainPostId: 'remote-root',
    }, async () => undefined);
    expect(db.rows('sendMutationReceipt')[1].result).toMatchObject({ status: 'CONFIRMED', quotaWriteKind: 'REPLY', quotaUnits: 1 });
  });
  it('does not infer zero writes from a false generic plug result without a trusted quota contract', async () => {
    const { db, service } = setup();
    await service.autonomousEffect('org', 'generic-plug', request, async () => false);
    const result = db.rows('sendMutationReceipt')[0].result;
    expect(result).toMatchObject({ status: 'CONFIRMED', result: false });
    expect(result).not.toHaveProperty('quotaUnits');
    expect(result).not.toHaveProperty('quotaWriteKind');
  });
  it('preserves quota provenance and records operator confirmation time for an unknown effect', async () => {
    const { db, service } = setup();
    await expect(service.autonomousEffect('org', 'uncertain-reply', {
      ...request, quotaWriteKind: 'REPLY', quotaUnits: 1,
    }, async () => { throw new Error('lost'); })).rejects.toThrow();
    const [pending] = (await service.listAutonomousEffects('org', 'admin')).items;
    const before = Date.now();
    await service.resolveAutonomousEffect('org', 'admin', pending.id, {
      decision: 'CONFIRMED', expectedRevision: 2, requestId: 'quota-resolution',
      executorStopped: true, noPendingSubmit: true, evidence: 'Stopped executor and verified remote reply.',
      expectedOrganizationId: 'org', expectedUserId: 'admin',
    });
    const result = db.rows('sendMutationReceipt')[0].result;
    expect(result).toMatchObject({ status: 'CONFIRMED', quotaWriteKind: 'REPLY', quotaUnits: 1 });
    expect(new Date(result.confirmedAt).getTime()).toBeGreaterThanOrEqual(before);
  });
  it('rejects malformed quota metadata before invoking a remote action', async () => {
    const { service } = setup();
    const work = vi.fn();
    await expect(service.autonomousEffect('org', 'bad-units', {
      ...request, quotaWriteKind: 'REPLY', quotaUnits: -1,
    }, work)).rejects.toThrow('INVALID_AUTONOMOUS_EFFECT');
    expect(work).not.toHaveBeenCalled();
  });
  it('rejects a parent result belonging to another root with the same group', async () => {
    const { db, service } = setup();
    const base = {
      organizationId: 'org', state: 'QUEUE', executionProtocol: null,
      sendIntentId: null, group: 'chain', parentPostId: null,
    };
    db.seed('post', { ...base, id: 'unrelated-root' });
    db.seed('post', { ...base, id: 'actual-root' });
    db.seed('post', { ...base, id: 'child', parentPostId: 'actual-root' });
    await service.autonomousEffect('org', 'unrelated-post', {
      integrationId: 'account', action: 'POST', postIds: ['unrelated-root'],
    }, async () => [{ postId: 'remote-unrelated' }]);
    const work = vi.fn();
    await expect(service.autonomousEffect('org', 'child-comment', {
      integrationId: 'account', action: 'COMMENT', postIds: ['child'],
      parentPostId: 'remote-unrelated', occurrenceKey: 'remote-unrelated',
    }, work)).rejects.toThrow('AUTONOMOUS_EFFECT_CONTENT_CHANGED');
    expect(work).not.toHaveBeenCalled();
  });
  it('never treats a stopped NOT_SUBMITTED occurrence as a fresh recurring grant', async () => {
    const { db, service } = setup();
    const firstDate = '2026-10-20T00:00:00.000Z',
      secondDate = '2026-10-21T00:00:00.000Z';
    db.seed('post', {
      id: 'root',
      organizationId: 'org',
      state: 'QUEUE',
      executionProtocol: null,
      sendIntentId: null,
      intervalInDays: 1,
      publishDate: new Date(firstDate),
      parentPostId: null,
      group: 'chain',
    });
    const first = {
      integrationId: 'account',
      action: 'POST' as const,
      postIds: ['root'],
      occurrenceKey: firstDate,
    };
    await expect(
      service.autonomousEffect('org', 'cycle:failed', first, async () => {
        throw new Error('lost');
      })
    ).rejects.toThrow();
    const [pending] = (await service.listAutonomousEffects('org', 'admin'))
      .items;
    await service.resolveAutonomousEffect('org', 'admin', pending.id, {
      decision: 'NOT_SUBMITTED',
      expectedRevision: 2,
      requestId: 'stop',
      executorStopped: true,
      noPendingSubmit: true,
      evidence: 'Executor stopped and platform checked.',
      expectedOrganizationId: 'org',
      expectedUserId: 'admin',
    });
    db.rows('post')[0].publishDate = new Date(secondDate);
    const retry = vi.fn();
    await expect(
      service.autonomousEffect(
        'org',
        'cycle:new',
        { ...first, occurrenceKey: secondDate },
        retry
      )
    ).rejects.toThrow('AUTONOMOUS_EFFECT_CONTENT_ALREADY_ADMITTED');
    expect(retry).not.toHaveBeenCalled();
  });
  it('never overwrites operator resolution when an original callback completes late', async () => {
    const { db, service } = setup();
    let ready!: () => void, complete!: (value: boolean) => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const network = new Promise<boolean>((resolve) => {
      complete = resolve;
    });
    const running = service.autonomousEffect(
      'org',
      'late',
      { ...request, quotaWriteKind: 'REPLY', quotaUnits: 1 },
      async () => {
        ready();
        return network;
      }
    );
    await started;
    const [pending] = (await service.listAutonomousEffects('org', 'admin'))
      .items;
    await service.resolveAutonomousEffect('org', 'admin', pending.id, {
      decision: 'NOT_SUBMITTED',
      expectedRevision: 1,
      requestId: 'stop',
      executorStopped: true,
      noPendingSubmit: true,
      evidence: 'Operator stopped executor and checked platform.',
      expectedOrganizationId: 'org',
      expectedUserId: 'admin',
    });
    complete(true);
    await expect(running).rejects.toThrow(
      'AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED'
    );
    expect(db.rows('sendMutationReceipt')[0].result).toMatchObject({
      status: 'NOT_SUBMITTED',
      revision: 2,
      quotaWriteKind: 'REPLY',
      quotaUnits: 1,
    });
    expect(db.rows('sendMutationReceipt')[0].result).not.toHaveProperty('confirmedAt');
  });
  it('rejects action relabeling between stored thread roots and comments', async () => {
    const { db, service } = setup();
    const date = '2026-10-20T00:00:00.000Z';
    db.seed('post', {
      id: 'root',
      organizationId: 'org',
      state: 'QUEUE',
      executionProtocol: null,
      sendIntentId: null,
      intervalInDays: 1,
      publishDate: new Date(date),
      parentPostId: null,
      group: 'chain',
    });
    db.seed('post', {
      id: 'child',
      organizationId: 'org',
      state: 'QUEUE',
      executionProtocol: null,
      sendIntentId: null,
      parentPostId: 'root',
      group: 'chain',
    });
    await service.autonomousEffect(
      'org',
      'root-post',
      {
        integrationId: 'account',
        action: 'POST',
        postIds: ['root'],
        occurrenceKey: date,
      },
      async () => [{ postId: 'main' }]
    );
    const work = vi.fn();
    await expect(
      service.autonomousEffect(
        'org',
        'root-as-comment',
        {
          integrationId: 'account',
          action: 'COMMENT',
          postIds: ['root'],
          parentPostId: 'main',
          occurrenceKey: 'main',
        },
        work
      )
    ).rejects.toThrow('AUTONOMOUS_EFFECT_CONTENT_CHANGED');
    await expect(
      service.autonomousEffect(
        'org',
        'child-as-post',
        {
          integrationId: 'account',
          action: 'POST',
          postIds: ['child'],
          occurrenceKey: date,
        },
        work
      )
    ).rejects.toThrow('AUTONOMOUS_EFFECT_CONTENT_CHANGED');
    expect(work).not.toHaveBeenCalled();
  });
  it('blocks controlled enrollment while a platform callback is pending and invokes it only once', async () => {
    const { db, service } = setup();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let complete!: (value: boolean) => void;
    const result = new Promise<boolean>((resolve) => {
      complete = resolve;
    });
    const work = vi.fn(async () => {
      started();
      return result;
    });
    const running = service.autonomousEffect(
      'org',
      'plug:post:1',
      request,
      work
    );
    await ready;
    expect((await service.stateIn(db, 'org')).mode).toBe('AUTONOMOUS');
    await expect(
      service.save('org', 'admin', change('CONTROLLED'))
    ).rejects.toMatchObject({
      response: {
        code: 'SEND_MODE_SWITCH_UNSAFE',
        blockers: { autonomousEffects: 1 },
      },
    });
    await expect(
      service.autonomousEffect('org', 'plug:post:1', request, work)
    ).rejects.toThrow('AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
    complete(true);
    expect(await running).toBe(true);
    expect(
      await service.autonomousEffect('org', 'plug:post:1', request, work)
    ).toBe(true);
    expect(work).toHaveBeenCalledTimes(1);
    expect(
      await service.save('org', 'admin', change('CONTROLLED'))
    ).toMatchObject({ mode: 'CONTROLLED' });
  });
  it('retains an unknown obligation after platform errors and refuses automatic retry', async () => {
    const { db, service } = setup();
    const work = vi.fn().mockRejectedValue(new Error('raw-secret-message'));
    await expect(
      service.autonomousEffect('org', 'plug:post:1', request, work)
    ).rejects.toThrow('AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
    expect(db.rows('sendMutationReceipt')[0].result).toMatchObject({
      status: 'UNKNOWN',
      revision: 2,
    });
    expect(JSON.stringify(db.rows('sendMutationReceipt'))).not.toContain(
      'raw-secret-message'
    );
    await expect(
      service.autonomousEffect('org', 'plug:post:1', request, work)
    ).rejects.toThrow('AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
    expect(work).toHaveBeenCalledTimes(1);
    await expect(
      service.save('org', 'admin', change('CONTROLLED'))
    ).rejects.toThrow('SEND_MODE_SWITCH_UNSAFE');
  });
  it('finds immutable effect receipts across membership changes, rejects changed input, and strips provider secrets', async () => {
    const { db, service } = setup();
    const work = vi.fn().mockResolvedValue([
      {
        id: 'remote',
        postId: 'post',
        releaseURL: 'https://example.com/post',
        token: 'secret',
      },
    ]);
    expect(
      await service.autonomousEffect('org', 'post:1', request, work)
    ).toEqual([
      { id: 'remote', postId: 'post', releaseURL: 'https://example.com/post' },
    ]);
    db.rows('userOrganization')[0].disabled = true;
    db.seed('userOrganization', {
      organizationId: 'org',
      userId: 'new',
      role: 'ADMIN',
      disabled: false,
    });
    expect(
      await service.autonomousEffect('org', 'post:1', request, work)
    ).toEqual([
      { id: 'remote', postId: 'post', releaseURL: 'https://example.com/post' },
    ]);
    await expect(
      service.autonomousEffect(
        'org',
        'post:1',
        { ...request, postId: 'other' },
        work
      )
    ).rejects.toThrow('AUTONOMOUS_EFFECT_REQUEST_CONFLICT');
    expect(work).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(db.rows('sendMutationReceipt'))).not.toContain(
      'secret'
    );
  });
  it('refuses admission for a foreign or disabled social integration before any network call', async () => {
    const { db, service } = setup();
    const work = vi.fn();
    db.rows('integration')[0].organizationId = 'other';
    await expect(
      service.autonomousEffect('org', 'plug', request, work)
    ).rejects.toThrow('AUTONOMOUS_EFFECT_ACCOUNT_REQUIRED');
    expect(work).not.toHaveBeenCalled();
    expect(db.rows('sendMutationReceipt')).toHaveLength(0);
  });
  it('requires scoped administrator evidence to resolve pending work without authorizing a resend', async () => {
    const { db, service } = setup();
    const work = vi.fn().mockRejectedValue(new Error('network'));
    await expect(
      service.autonomousEffect('org', 'plug', request, work)
    ).rejects.toThrow();
    const pending = await service.listAutonomousEffects('org', 'admin');
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]).not.toHaveProperty('result');
    expect(pending.items[0]).not.toHaveProperty('requestHash');
    const id = pending.items[0].id;
    const body = {
      decision: 'NOT_SUBMITTED' as const,
      expectedRevision: 2,
      requestId: 'resolve',
      executorStopped: true as const,
      noPendingSubmit: true as const,
      evidence: 'Executor stopped and platform checked.',
      expectedOrganizationId: 'org',
      expectedUserId: 'admin',
    };
    await expect(
      service.resolveAutonomousEffect('org', 'admin', id, {
        ...body,
        executorStopped: false,
      } as any)
    ).rejects.toThrow('INVALID_AUTONOMOUS_EFFECT_RESOLUTION');
    await expect(
      service.resolveAutonomousEffect('org', 'admin', id, {
        ...body,
        expectedUserId: 'other',
      })
    ).rejects.toThrow('SEND_OWNER_CHANGED');
    const result = await service.resolveAutonomousEffect(
      'org',
      'admin',
      id,
      body
    );
    expect(result).toMatchObject({ id, status: 'NOT_SUBMITTED', revision: 3 });
    expect(
      await service.resolveAutonomousEffect('org', 'admin', id, body)
    ).toEqual(result);
    await expect(
      service.resolveAutonomousEffect('org', 'admin', id, {
        ...body,
        evidence: 'different',
      })
    ).rejects.toThrow('REQUEST_ID_CONFLICT');
    await expect(
      service.autonomousEffect('org', 'plug', request, work)
    ).rejects.toThrow('AUTONOMOUS_EFFECT_NOT_SUBMITTED');
    expect(work).toHaveBeenCalledTimes(1);
    expect((await service.listAutonomousEffects('org', 'admin')).items).toEqual(
      []
    );
    expect(
      await service.save('org', 'admin', change('CONTROLLED'))
    ).toMatchObject({ mode: 'CONTROLLED' });
  });
  it('fails closed on malformed autonomous receipt status instead of skipping missing JSON paths', async () => {
    const { db, service } = setup();
    db.seed('sendMutationReceipt', {
      organizationId: 'org',
      userId: 'admin',
      operation: 'autonomous-side-effect',
      result: { revision: 1, action: 'PLUG', integrationId: 'account' },
    });
    await expect(service.stateIn(db, 'org')).rejects.toThrow(
      'AUTONOMOUS_EFFECT_RECORD_INVALID'
    );
    await expect(
      service.save('org', 'admin', change('CONTROLLED'))
    ).rejects.toThrow('AUTONOMOUS_EFFECT_RECORD_INVALID');
  });
  it('refuses stale autonomous Post snapshots after a controlled root was settled and safely downgraded', async () => {
    const { db, service } = setup();
    const work = vi.fn().mockResolvedValue([]);
    db.seed('settings', {
      key: 'sending.organization_mode:org',
      value: { mode: 'AUTONOMOUS', revision: 1 },
    });
    db.seed('post', {
      id: 'post',
      organizationId: 'org',
      state: 'PUBLISHED',
      executionProtocol: 'ACCOUNT_BOUND_V1',
      sendIntentId: 'intent',
    });
    await expect(
      service.autonomousEffect(
        'org',
        'post:stale',
        { integrationId: 'account', action: 'POST', postIds: ['post'] },
        work
      )
    ).rejects.toThrow('AUTONOMOUS_EFFECT_CONTENT_CHANGED');
    expect(work).not.toHaveBeenCalled();
    db.rows('post')[0].executionProtocol = null;
    db.rows('post')[0].sendIntentId = null;
    await expect(
      service.autonomousEffect(
        'org',
        'post:stale',
        { integrationId: 'account', action: 'POST', postIds: ['post'] },
        work
      )
    ).rejects.toThrow('AUTONOMOUS_EFFECT_CONTENT_CHANGED');
    expect(work).not.toHaveBeenCalled();
  });
  it('validates stored Post provenance at first admission but replays the confirmed result after publication', async () => {
    const { db, service } = setup();
    const work = vi.fn().mockResolvedValue([{ id: 'remote' }]);
    db.seed('post', {
      id: 'post',
      organizationId: 'org',
      state: 'QUEUE',
      executionProtocol: null,
      sendIntentId: null,
    });
    const input = {
      integrationId: 'account',
      action: 'POST' as const,
      postIds: ['post'],
    };
    expect(
      await service.autonomousEffect('org', 'post:stable', input, work)
    ).toEqual([{ id: 'remote' }]);
    db.rows('post')[0].state = 'PUBLISHED';
    expect(
      await service.autonomousEffect('org', 'post:stable', input, work)
    ).toEqual([{ id: 'remote' }]);
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('refuses a thread finisher belonging to an already controlled original platform post', async () => {
    const { db, service } = setup();
    const work = vi.fn();
    db.seed('settings', {
      key: 'sending.organization_mode:org',
      value: { mode: 'AUTONOMOUS', revision: 1 },
    });
    db.seed('post', {
      id: 'root',
      organizationId: 'org',
      integrationId: 'account',
      releaseId: 'remote',
      executionProtocol: 'ACCOUNT_BOUND_V1',
      sendIntentId: 'intent',
    });
    await expect(
      service.autonomousEffect(
        'org',
        'finisher:remote',
        {
          integrationId: 'account',
          action: 'THREAD_FINISHER',
          mainPostId: 'remote',
        },
        work
      )
    ).rejects.toThrow('AUTONOMOUS_EFFECT_CONTENT_CHANGED');
    expect(work).not.toHaveBeenCalled();
  });
  it('retries only database admission after serialization failure and still calls the platform exactly once', async () => {
    const { db, service } = setup();
    const original = db.$transaction;
    let retry = true;
    db.$transaction = (work: Function, options: unknown) =>
      original(async (tx: any) => {
        const result = await work(tx);
        if (retry) {
          retry = false;
          throw Object.assign(new Error('serialization'), { code: 'P2034' });
        }
        return result;
      }, options);
    const work = vi.fn().mockResolvedValue(true);
    expect(
      await service.autonomousEffect('org', 'retry-admission', request, work)
    ).toBe(true);
    expect(work).toHaveBeenCalledTimes(1);
    expect(db.rows('sendMutationReceipt')).toHaveLength(1);
  });
  it('retains durable uncertainty when storing a successful remote result fails and never repeats that remote call', async () => {
    const { db, service } = setup();
    const receipts = db.sendMutationReceipt;
    db.sendMutationReceipt = {
      ...receipts,
      updateMany: async (args: any) => {
        if (args.data.result.status === 'CONFIRMED')
          throw new Error('storage failure');
        return receipts.updateMany(args);
      },
    };
    const work = vi.fn().mockResolvedValue(true);
    await expect(
      service.autonomousEffect('org', 'settlement-failure', request, work)
    ).rejects.toThrow('AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
    expect(db.rows('sendMutationReceipt')[0].result.status).toBe('UNKNOWN');
    await expect(
      service.autonomousEffect('org', 'settlement-failure', request, work)
    ).rejects.toThrow('AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('never converts manual confirmation without a cached result into permission to call the platform again', async () => {
    const { db, service } = setup();
    const work = vi.fn().mockRejectedValue(new Error('network'));
    await expect(
      service.autonomousEffect('org', 'operator-confirmed', request, work)
    ).rejects.toThrow();
    const [pending] = (await service.listAutonomousEffects('org', 'admin'))
      .items;
    await service.resolveAutonomousEffect('org', 'admin', pending.id, {
      decision: 'CONFIRMED',
      expectedRevision: 2,
      requestId: 'confirm',
      executorStopped: true,
      noPendingSubmit: true,
      evidence: 'Executor stopped; remote operation verified.',
      expectedOrganizationId: 'org',
      expectedUserId: 'admin',
    });
    await expect(
      service.autonomousEffect('org', 'operator-confirmed', request, work)
    ).rejects.toThrow('AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
    expect(work).toHaveBeenCalledTimes(1);
    expect((await service.listAutonomousEffects('org', 'admin')).items).toEqual(
      []
    );
    expect(db.rows('sendMutationReceipt')[0].result.status).toBe('CONFIRMED');
  });
  it('keeps already-controlled organizations paused if unresolved autonomous admissions are detected', async () => {
    const { db, service } = setup();
    db.seed('settings', {
      key: 'sending.organization_mode:org',
      value: { mode: 'CONTROLLED', revision: 1 },
    });
    db.seed('sendMutationReceipt', {
      organizationId: 'org',
      userId: 'admin',
      operation: 'autonomous-side-effect',
      requestId: 'id',
      result: {
        status: 'AUTHORIZED',
        revision: 1,
        action: 'PLUG',
        integrationId: 'account',
      },
    });
    expect(await service.stateIn(db, 'org')).toMatchObject({
      mode: 'PAUSED',
      blockers: { autonomousEffects: 1 },
    });
    await expect(
      service.save('org', 'admin', change('CONTROLLED', 1))
    ).rejects.toThrow('SEND_MODE_SWITCH_UNSAFE');
  });
  it('returns only safe business references for operator review and never raw request metadata', async () => {
    const { service } = setup();
    const work = vi.fn().mockRejectedValue(new Error('network'));
    await expect(
      service.autonomousEffect(
        'org',
        'safe-reference',
        {
          ...request,
          postIds: ['local-post'],
          token: 'secret',
          payload: { authorization: 'secret' },
        },
        work
      )
    ).rejects.toThrow();
    const list = await service.listAutonomousEffects('org', 'admin');
    expect(list.items[0]).toMatchObject({
      postIds: ['local-post'],
      targetPostId: 'post',
      action: 'PLUG',
      integrationId: 'account',
    });
    expect(JSON.stringify(list)).not.toContain('secret');
    expect(list.items[0]).not.toHaveProperty('payload');
  });
  it('refuses orphaned authorized receipts after a crash before callback invocation', async () => {
    const { db, service } = setup();
    const work = vi.fn();
    db.seed('sendMutationReceipt', {
      organizationId: 'org',
      userId: 'admin',
      operation: 'autonomous-side-effect',
      requestId: sendHash(['autonomous-effect-v1', 'crash']),
      requestHash: sendHash(request),
      result: {
        status: 'AUTHORIZED',
        revision: 1,
        action: 'PLUG',
        integrationId: 'account',
      },
    });
    await expect(
      service.autonomousEffect('org', 'crash', request, work)
    ).rejects.toThrow('AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
    expect(work).not.toHaveBeenCalled();
  });
  it('blocks a new operation key for the same stored root after an ambiguous prior send', async () => {
    const { db, service } = setup();
    db.seed('post', {
      id: 'root',
      organizationId: 'org',
      state: 'QUEUE',
      executionProtocol: null,
      sendIntentId: null,
    });
    const failed = vi.fn().mockRejectedValue(new Error('lost'));
    const input = {
      integrationId: 'account',
      action: 'POST' as const,
      postIds: ['root'],
    };
    await expect(
      service.autonomousEffect('org', 'post:root:old-date', input, failed)
    ).rejects.toThrow();
    const retry = vi.fn().mockResolvedValue([]);
    await expect(
      service.autonomousEffect('org', 'post:root:new-date', input, retry)
    ).rejects.toThrow('AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
    expect(retry).not.toHaveBeenCalled();
  });
  it('does not turn a terminal stored-root receipt into a second grant by changing the operation key', async () => {
    const { db, service } = setup();
    db.seed('post', {
      id: 'root',
      organizationId: 'org',
      state: 'QUEUE',
      executionProtocol: null,
      sendIntentId: null,
    });
    const input = {
      integrationId: 'account',
      action: 'POST' as const,
      postIds: ['root'],
    };
    const first = vi.fn().mockResolvedValue([{ id: 'remote' }]);
    await service.autonomousEffect('org', 'post:root:old-date', input, first);
    const retry = vi.fn().mockResolvedValue([]);
    await expect(
      service.autonomousEffect('org', 'post:root:new-date', input, retry)
    ).rejects.toThrow('AUTONOMOUS_EFFECT_CONTENT_ALREADY_ADMITTED');
    expect(retry).not.toHaveBeenCalled();
  });
  it('allows only distinct database-validated recurring occurrences after a confirmed cached result', async () => {
    const { db, service } = setup();
    const firstDate = '2026-10-20T00:00:00.000Z',
      secondDate = '2026-10-21T00:00:00.000Z';
    db.seed('post', {
      id: 'root',
      organizationId: 'org',
      state: 'QUEUE',
      executionProtocol: null,
      sendIntentId: null,
      intervalInDays: 1,
      publishDate: new Date(firstDate),
      parentPostId: null,
      group: 'chain',
    });
    const work = vi.fn().mockResolvedValue([{ postId: 'remote-1' }]);
    const first = {
      integrationId: 'account',
      action: 'POST' as const,
      postIds: ['root'],
      occurrenceKey: firstDate,
    };
    await service.autonomousEffect('org', 'cycle:1', first, work);
    const secondWork = vi.fn().mockResolvedValue([{ postId: 'remote-2' }]);
    await expect(
      service.autonomousEffect(
        'org',
        'cycle:2',
        { ...first, occurrenceKey: secondDate },
        secondWork
      )
    ).rejects.toThrow('AUTONOMOUS_EFFECT_CONTENT_CHANGED');
    db.rows('post')[0].publishDate = new Date(secondDate);
    expect(
      await service.autonomousEffect(
        'org',
        'cycle:2',
        { ...first, occurrenceKey: secondDate },
        secondWork
      )
    ).toEqual([{ postId: 'remote-2' }]);
    expect(secondWork).toHaveBeenCalledTimes(1);
  });
  it('requires a confirmed current parent result for recurring thread comments and permits distinct confirmed cycles', async () => {
    const { db, service } = setup();
    const firstDate = '2026-10-20T00:00:00.000Z',
      secondDate = '2026-10-21T00:00:00.000Z';
    db.seed('post', {
      id: 'root',
      organizationId: 'org',
      state: 'QUEUE',
      executionProtocol: null,
      sendIntentId: null,
      intervalInDays: 1,
      publishDate: new Date(firstDate),
      parentPostId: null,
      group: 'chain',
    });
    db.seed('post', {
      id: 'child',
      organizationId: 'org',
      state: 'QUEUE',
      executionProtocol: null,
      sendIntentId: null,
      intervalInDays: null,
      publishDate: new Date(firstDate),
      parentPostId: 'root',
      group: 'chain',
    });
    const post = (date: string, remote: string) =>
      service.autonomousEffect(
        'org',
        `post:${date}`,
        {
          integrationId: 'account',
          action: 'POST',
          postIds: ['root'],
          occurrenceKey: date,
        },
        async () => [{ postId: remote }]
      );
    const comment = (remote: string, work: () => Promise<any>) =>
      service.autonomousEffect(
        'org',
        `comment:${remote}`,
        {
          integrationId: 'account',
          action: 'COMMENT',
          postIds: ['child'],
          parentPostId: remote,
          occurrenceKey: remote,
        },
        work
      );
    const work = vi.fn().mockResolvedValue([{ postId: 'reply' }]);
    await expect(comment('fake', work)).rejects.toThrow(
      'AUTONOMOUS_EFFECT_CONTENT_CHANGED'
    );
    await post(firstDate, 'main-1');
    await comment('main-1', work);
    db.rows('post')[0].publishDate = new Date(secondDate);
    await post(secondDate, 'main-2');
    await comment('main-2', work);
    expect(work).toHaveBeenCalledTimes(2);
  });
});

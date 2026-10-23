import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
  vi.stubEnv(
    'SEND_EXECUTION_CREDENTIAL_KEY',
    'test-send-execution-key-with-at-least-32-characters'
  );
});
afterEach(() => vi.unstubAllEnvs());
import {
  sendNow as now,
  setupSend as setup,
  actor,
} from './support/send-fixture';

describe('shared content send coordination', () => {
  it('enables a newly enrolled account by default without any plugin readiness write', async () => {
    const f = setup();
    f.db.rows('accountWriteState').splice(0);
    await f.create();
    expect(f.db.rows('accountWriteState')).toEqual([expect.objectContaining({
      organizationId: 'org', integrationId: 'account', rolloutReady: true,
    })]);
  });
  it('preserves a disabled existing account when enqueuing another task', async () => {
    const f = setup();
    const state = f.db.rows('accountWriteState')[0];
    state.rolloutReady = false;
    const before = structuredClone(state);
    await f.create();
    expect(f.db.rows('accountWriteState')).toEqual([before]);
  });

  it('freezes one send intent and rejects a reconstructed root for the same content', async () => {
    const { create, db } = setup();
    const queued = await create();
    expect(queued).toMatchObject({
      state: 'QUEUE',
      integrationId: 'account',
      executionProtocol: 'ACCOUNT_BOUND_V1',
    });
    const intent = db.rows('sendIntent')[0];
    expect(intent.rootPostId).toBe('root');
    await expect(
      create('other-root', 'EXTENSION', intent.contentUnitId)
    ).rejects.toThrow('CONTENT_ROOT_CONFLICT');
    expect(db.rows('sendIntent')).toHaveLength(1);
  });
  it('only grants one execution when API and extension compete for the same content', async () => {
    const { create, service, db } = setup();
    await create();
    const results = await Promise.allSettled([
      service.reserveApi('org', 'root', 'workflow', now),
      service.reserveApi('org', 'root', 'another-workflow', now),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(db.rows('sendExecution')).toHaveLength(1);
    const execution = db.rows('sendExecution')[0];
    expect(db.rows('sendIntent')[0].activeExecutionId).toBe(execution.id);
  });
  it('does not replay a start permit, and preserves quota on an unknown outcome', async () => {
    const { create, service, db } = setup();
    await create();
    const execution = await service.reserveApi('org', 'root', 'workflow', now);
    const first = await service.authorizeApiSegment(
      'org',
      execution.id,
      0,
      { id: '123', idNamespace: 'x.rest_id' },
      now
    );
    expect(first.granted).toBe(true);
    expect(
      (
        await service.authorizeApiSegment(
          'org',
          execution.id,
          0,
          { id: '123', idNamespace: 'x.rest_id' },
          now
        )
      ).granted
    ).toBe(false);
    await service.apiOutcome(
      'org',
      execution.id,
      0,
      { status: 'unknown', eventId: 'unknown' },
      now
    );
    expect(db.rows('sendIntent')[0].status).toBe('RECONCILING');
    expect(db.rows('sendQuotaReservation')[0].state).toBe('HELD');
    expect(db.rows('accountWriteState')[0].activeExecutionId).toBe(
      execution.id
    );
    await expect(
      service.reserveApi(
        'org',
        'root',
        'retry',
        new Date('2026-10-16T12:00:00Z')
      )
    ).rejects.toThrow();
  });
  it('settles a late success exactly once and never downgrades it on late unknown', async () => {
    const { create, service, db } = setup();
    await create();
    const execution = await service.reserveApi('org', 'root', 'workflow', now);
    await service.authorizeApiSegment(
      'org',
      execution.id,
      0,
      { id: '123', idNamespace: 'x.rest_id' },
      now
    );
    const result = {
      status: 'confirmed' as const,
      eventId: 'success',
      platformId: 'tweet',
      url: 'https://x.com/alice/status/tweet',
    };
    await service.apiOutcome(
      'org',
      execution.id,
      0,
      { status: 'unknown', eventId: 'lost' },
      now
    );
    const late = new Date('2026-10-16T12:00:00Z');
    await service.apiOutcome('org', execution.id, 0, result, late);
    await service.apiOutcome('org', execution.id, 0, result, late);
    await service.apiOutcome(
      'org',
      execution.id,
      0,
      { status: 'unknown', eventId: 'late-unknown' },
      late
    );
    expect(db.rows('sendIntent')[0].status).toBe('SUCCEEDED');
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({
      heldUnits: 0,
      confirmedUnits: 1,
    });
    expect(db.rows('post')[0]).toMatchObject({
      state: 'PUBLISHED',
      releaseId: 'tweet',
    });
    expect(db.rows('accountWriteState')[0].nextWriteNotBefore).toEqual(
      new Date(late.getTime() + 60_000)
    );
  });
  it('reserves the final shared budget unit for only one of two different accounts', async () => {
    const { create, service, db, bindings } = setup();
    await create();
    db.seed('accountWriteState', {
      id: 'other-key',
      organizationId: 'org',
      canonicalAccountKey: 'other-key',
      integrationId: 'other-account',
      rolloutReady: true,
      revision: 0,
      activeExecutionId: null,
    });
    db.seed('integration', {
      ...actor,
      id: 'other-account',
      internalId: '456',
    });
    db.seed('integrationProject', {
      id: 'rel2',
      organizationId: 'org',
      projectId: 'project',
      integrationId: 'other-account',
      disabled: false,
      engageEnabled: true,
    });
    bindings.resolveForEnqueueInTransaction.mockResolvedValue({
      integrationId: 'other-account',
      providerIdentifier: 'x',
      bindingSource: 'PROJECT',
      bindingRevision: 1,
      canonicalAccountKey: 'other-key',
      targetAccount: { id: '456', idNamespace: 'x.rest_id' },
    });
    await create('second');
    const e1 = await service.reserveApi('org', 'root', 'w1', now);
    const e2 = await service.reserveApi('org', 'second', 'w2', now);
    const results = await Promise.allSettled([
      service.authorizeApiSegment(
        'org',
        e1.id,
        0,
        { id: '123', idNamespace: 'x.rest_id' },
        now
      ),
      service.authorizeApiSegment(
        'org',
        e2.id,
        0,
        { id: '456', idNamespace: 'x.rest_id' },
        now
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({
      confirmedUnits: 0,
      heldUnits: 1,
    });
    expect(db.rows('sendQuotaReservation')).toHaveLength(1);
  });
  it('requires stopped-executor evidence to release a permit, preserving the intent for a safe retry', async () => {
    const { create, service, db } = setup();
    await create();
    const execution = await service.reserveApi('org', 'root', 'workflow', now);
    await service.authorizeApiSegment(
      'org',
      execution.id,
      0,
      { id: '123', idNamespace: 'x.rest_id' },
      now
    );
    await expect(
      service.apiOutcome(
        'org',
        execution.id,
        0,
        { status: 'definitely_not_submitted', eventId: 'unsafe' },
        now
      )
    ).rejects.toThrow('STOP_CONFIRMATION_REQUIRED');
    const afterExpiry = new Date(now.getTime() + 31_000);
    await service.apiOutcome(
      'org',
      execution.id,
      0,
      {
        status: 'definitely_not_submitted',
        eventId: 'stopped',
        stopped: true,
        evidence: 'adapter never invoked the platform request',
      },
      afterExpiry
    );
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({
      heldUnits: 0,
      confirmedUnits: 0,
    });
    const intentId = db.rows('sendIntent')[0].id;
    await service.retry('org', 'root', 'user', afterExpiry);
    await service.reserveApi('org', 'root', 'retry', afterExpiry);
    expect(db.rows('sendIntent')[0].id).toBe(intentId);
  });
  it('rejects mismatched actors before quota reservation and enforces account rollout readiness', async () => {
    const { create, service, db } = setup();
    await create();
    const execution = await service.reserveApi('org', 'root', 'workflow', now);
    await expect(
      service.authorizeApiSegment(
        'org',
        execution.id,
        0,
        { id: 'wrong', idNamespace: 'x.rest_id' },
        now
      )
    ).rejects.toThrow('ACCOUNT_MISMATCH');
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
    db.rows('accountWriteState')[0].rolloutReady = false;
    await expect(
      service.authorizeApiSegment(
        'org',
        execution.id,
        0,
        { id: '123', idNamespace: 'x.rest_id' },
        now
      )
    ).rejects.toThrow('ACCOUNT_COORDINATION_AUDIT_REQUIRED');
  });
  it('does not permit a legacy sender to bypass an enrolled account', async () => {
    const { service } = setup();
    await expect(service.assertLegacyAccount('org', 'account')).rejects.toThrow(
      'SEND_MODE_AUTONOMOUS_REQUIRED'
    );
    await expect(
      service.assertLegacyAccount('org', 'unrelated')
    ).rejects.toThrow('SEND_MODE_AUTONOMOUS_REQUIRED');
  });
});


describe('account writer lifetime independent of uncertain result lifetime', () => {
  async function uncertain(status: 'unknown' | 'authorized' = 'unknown') {
    const f = setup();
    f.quotas.resolve.mockResolvedValue({ gapMs: 60000, budgets: [{ key: 'shared-project', scope: 'PROJECT', dimension: 'ROOT_SENDS', limit: 10, units: 1,
      windowStart: new Date('2026-10-15T00:00:00Z'), windowEnd: new Date('2026-10-16T00:00:00Z'), timezone: 'UTC', policyVersion: 'test' }] });
    await f.create();
    const old = await f.service.reserveApi('org', 'root', 'old', now);
    await f.service.authorizeApiSegment('org', old.id, 0, { id: '123', idNamespace: 'x.rest_id' }, now);
    if (status === 'unknown') await f.service.apiOutcome('org', old.id, 0, { status: 'unknown', eventId: 'lost' }, now);
    await f.create('independent');
    return { ...f, old, later: new Date(now.getTime() + 31000) };
  }

  it('retains a live sending execution even when its existing authorization expired', async () => {
    const f = await uncertain('authorized');
    const next = await f.service.reserveApi('org', 'independent', 'new', f.later);
    await expect(f.service.authorizeApiSegment('org', next.id, 0, { id: '123', idNamespace: 'x.rest_id' }, f.later)).rejects.toThrow('ACCOUNT_WRITE_BUSY');
    expect(f.db.rows('sendExecution').find(row => row.id === f.old.id).status).toBe('SENDING');
    expect(f.db.rows('sendSegment').find(row => row.executionId === f.old.id).status).toBe('AUTHORIZED');
    expect(f.db.rows('accountWriteState')[0].activeExecutionId).toBe(f.old.id);
  });

  it('does not let a late old confirmation clear the newer writer or settle its quota', async () => {
    const f = await uncertain();
    const next = await f.service.reserveApi('org', 'independent', 'new', f.later);
    await f.service.authorizeApiSegment('org', next.id, 0, { id: '123', idNamespace: 'x.rest_id' }, f.later);
    await f.service.apiOutcome('org', f.old.id, 0, { status: 'confirmed', eventId: 'late', platformId: 'old-result' }, f.later);
    expect(f.db.rows('accountWriteState')[0].activeExecutionId).toBe(next.id);
    expect(f.db.rows('sendQuotaReservation').find(row => row.executionId === next.id).state).toBe('HELD');
    expect(f.db.rows('sendIntent').find(row => row.id === f.old.sendIntentId).status).toBe('SUCCEEDED');
  });

  it('keeps an uncertain writer locked without a persisted permit expiry', async () => {
    const f = await uncertain();
    f.db.rows('sendSegment')[0].submitBefore = null;
    const next = await f.service.reserveApi('org', 'independent', 'new', f.later);
    await expect(f.service.authorizeApiSegment('org', next.id, 0, { id: '123', idNamespace: 'x.rest_id' }, f.later)).rejects.toThrow('ACCOUNT_WRITE_BUSY');
    expect(f.db.rows('accountWriteState')[0].activeExecutionId).toBe(f.old.id);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSend, sendNow as now } from './support/send-fixture';
import { sendHash } from '../send-coordination.utils';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe('durable request identity and privileged reconciliation', () => {
  it('reuses a persisted create identity and rejects a different body with the same request', async () => {
    const { service, db } = setupSend();
    const id = await service.prepareCreation(
      'org',
      'user',
      'request',
      'item',
      sendHash('body')
    );
    expect(
      await service.prepareCreation(
        'org',
        'user',
        'request',
        'item',
        sendHash('body')
      )
    ).toBe(id);
    await expect(
      service.prepareCreation(
        'org',
        'user',
        'request',
        'item',
        sendHash('different')
      )
    ).rejects.toThrow('SEND_CREATE_REQUEST_CONFLICT');
    expect(db.rows('sendMutationReceipt')).toHaveLength(1);
    expect(
      await service.prepareCreation(
        'org',
        'user',
        'other',
        'item',
        sendHash('body'),
        'existing-root'
      )
    ).toBe('existing-root');
  });
  it('requires database-backed administrator permission and matching organization membership', async () => {
    const { service, create, db } = setupSend();
    await create();
    const e = await service.reserveApi('org', 'root', 'workflow', now);
    await expect(
      service.reconciliationView('org', 'user', e.id)
    ).rejects.toThrow('SEND_RECONCILIATION_PERMISSION_REQUIRED');
    db.seed('user', { id: 'admin', isSuperAdmin: true });
    await expect(
      service.reconciliationView('org', 'admin', e.id)
    ).rejects.toThrow('SEND_RECONCILIATION_PERMISSION_REQUIRED');
  });
  it('requires evidence and resolution revision, settles a late confirmation, and replays only the receipt', async () => {
    const { service, create, db } = setupSend();
    await create();
    db.seed('user', { id: 'admin', isSuperAdmin: true });
    db.seed('userOrganization', {
      userId: 'admin',
      organizationId: 'org',
      disabled: false,
    });
    const e = await service.reserveApi('org', 'root', 'workflow', now);
    await service.authorizeApiSegment(
      'org',
      e.id,
      0,
      { id: '123', idNamespace: 'x.rest_id' },
      now
    );
    await service.apiOutcome(
      'org',
      e.id,
      0,
      { status: 'unknown', eventId: 'lost' },
      now
    );
    const result = {
      status: 'confirmed' as const,
      eventId: 'verified',
      platformId: 'tweet',
      evidence:
        'Verified platform record, actor, and target match the original execution.',
    };
    await expect(
      service.reconcile('org', 'admin', e.id, 0, 1, result)
    ).rejects.toThrow('SEND_RESOLUTION_REVISION_CONFLICT');
    await expect(
      service.reconcile('org', 'admin', e.id, 0, 0, { ...result, evidence: '' })
    ).rejects.toThrow('SEND_RECONCILIATION_EVIDENCE_REQUIRED');
    await service.reconcile('org', 'admin', e.id, 0, 0, result);
    await service.reconcile('org', 'admin', e.id, 0, 0, result);
    const view = await service.reconciliationView('org', 'admin', e.id);
    expect(view).toMatchObject({ status: 'SUCCEEDED', resolutionRevision: 1 });
    expect(view).not.toHaveProperty('leaseTokenHash');
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({
      heldUnits: 0,
      confirmedUnits: 1,
    });
  });
  it('rechecks the policy owner membership before granting any send quota', async () => {
    const { service, create, db } = setupSend();
    await create();
    const e = await service.reserveApi('org', 'root', 'workflow', now);
    db.rows('userOrganization')[0].disabled = true;
    await expect(
      service.authorizeApiSegment(
        'org',
        e.id,
        0,
        { id: '123', idNamespace: 'x.rest_id' },
        now
      )
    ).rejects.toThrow('SEND_POLICY_OWNER_UNAVAILABLE');
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
  });
});

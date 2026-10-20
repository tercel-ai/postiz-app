import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSend, sendNow } from './support/send-fixture';
import { SendModeService } from '../send-mode.service';
import { SendExecutionService } from '../send-execution.service';
import { confirmSendPreflight } from '../send-preflight';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(sendNow);
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('mode switching across real coordinator boundaries', () => {
  it('rejects V1 claims and starts after Settings pause without granting quota or a permit', async () => {
    vi.stubEnv('SEND_EXECUTION_CREDENTIAL_KEY', 'review-mode-pause-key-at-least-thirty-two-characters');
    const { db, service, create } = setupSend();
    db.seed('user', { id: 'super', isSuperAdmin: true });
    db.seed('extensionNode', {
      id: 'node', nodeId: 'node', organizationId: 'org', status: 'ACTIVE', credentialVersion: 1,
      capabilities: { x: { post: true, reply: true, strictAccountVerification: true } },
    });
    db.seed('extensionNodeSession', {
      extensionNodeId: 'node', organizationId: 'org', platform: 'x', integrationId: 'account',
      verificationStatus: 'VERIFIED', verificationExpiresAt: new Date(sendNow.getTime() + 300_000),
      sessionRevision: 1, probeId: 'old', accountIdentity: { id: '123', namespace: 'x.rest_id' },
    });
    const executions = new SendExecutionService(db as any, {
      authenticateIn: vi.fn(async () => db.rows('extensionNode')[0]),
    } as any, service);
    const auth = { org: 'org', user: 'user', nodeId: 'node', token: 'token' };
    await create();
    const item = (await executions.claim(auth, { requestId: 'before-pause', action: 'POST' })).items[0];
    expect(item).toBeDefined();
    const challenge = await executions.preflight(auth, item.executionId, 0, item.leaseToken);
    const session = db.rows('extensionNodeSession')[0];
    session.probeId = 'fresh';
    await db.$transaction((tx: any) => confirmSendPreflight(tx, db.rows('extensionNode')[0], {
      platform: 'x', id: '123', identityNamespace: 'x.rest_id', loggedIn: true,
      evidenceKind: 'LIVE_COOKIE_ID', probeId: 'fresh', identityObservedAt: sendNow.toISOString(),
      preflightChallenge: challenge.challenge,
    }, session, 'old', sendNow));
    const before = structuredClone({
      executions: db.rows('sendExecution'), segments: db.rows('sendSegment'),
      reservations: db.rows('sendQuotaReservation'), buckets: db.rows('sendQuotaBucket'),
    });
    await new SendModeService(db as any).saveSystem('super', {
      enabled: false, expectedRevision: 0, requestId: 'pause-v1',
    });
    await expect(executions.claim(auth, { requestId: 'after-pause', action: 'POST' }))
      .rejects.toThrow('SEND_MODE_CONTROLLED_REQUIRED');
    await expect(executions.start(auth, item.executionId, 0, item.leaseToken))
      .rejects.toThrow('SEND_MODE_CONTROLLED_REQUIRED');
    expect({
      executions: db.rows('sendExecution'), segments: db.rows('sendSegment'),
      reservations: db.rows('sendQuotaReservation'), buckets: db.rows('sendQuotaBucket'),
    }).toEqual(before);
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
    expect(db.rows('sendSegment')[0].status).toBe('PENDING');
  });
  it('serializes an enqueue racing downgrade so both incompatible admissions cannot succeed', async () => {
    const { db, service, create } = setupSend();
    db.rows('userOrganization')[0].role = 'ADMIN';
    const modes = new SendModeService(db as any);
    const results = await Promise.allSettled([
      create(),
      modes.save('org', 'user', {
        mode: 'AUTONOMOUS',
        expectedRevision: 1,
        requestId: 'downgrade',
        expectedOrganizationId: 'org',
        expectedUserId: 'user',
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    const state = await modes.stateIn(db as any, 'org');
    if (state.mode === 'AUTONOMOUS') {
      expect(db.rows('sendIntent')).toHaveLength(0);
      await expect(
        service.enqueue('org', 'root', { userId: 'user', origin: 'MANUAL' })
      ).rejects.toThrow('SEND_MODE_CONTROLLED_REQUIRED');
    } else {
      expect(state.mode).toBe('CONTROLLED');
      expect(db.rows('sendIntent')).toHaveLength(1);
    }
  });

  it('keeps authorized late outcome settlement available after typed system disable and charges only once', async () => {
    const { db, service, create } = setupSend();
    db.seed('user', { id: 'super', isSuperAdmin: true });
    const modes = new SendModeService(db as any);
    await create();
    const execution = await service.reserveApi(
      'org',
      'root',
      'worker',
      sendNow
    );
    await service.authorizeApiSegment(
      'org',
      execution.id,
      0,
      { id: '123', idNamespace: 'x.rest_id' },
      sendNow
    );
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({
      heldUnits: 1,
      confirmedUnits: 0,
    });
    await modes.saveSystem('super', {
      enabled: false,
      expectedRevision: 0,
      requestId: 'pause',
    });
    expect((await modes.stateIn(db as any, 'org')).mode).toBe('PAUSED');
    await expect(
      service.authorizeApiSegment(
        'org',
        execution.id,
        0,
        { id: '123', idNamespace: 'x.rest_id' },
        sendNow
      )
    ).rejects.toThrow('SEND_MODE_CONTROLLED_REQUIRED');
    const outcome = {
      status: 'confirmed' as const,
      eventId: 'late',
      platformId: 'tweet',
      url: 'https://x.com/alice/status/1',
    };
    await service.apiOutcome('org', execution.id, 0, outcome, sendNow);
    await service.apiOutcome('org', execution.id, 0, outcome, sendNow);
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({
      heldUnits: 0,
      confirmedUnits: 1,
    });
    expect(db.rows('sendOutcomeEvent')).toHaveLength(1);
    expect(db.rows('accountWriteState')[0].activeExecutionId).toBeNull();
  });

  it('retains root protocol and rejects autonomous replay after successful controlled settlement and safe downgrade', async () => {
    const { db, service, create } = setupSend();
    db.rows('userOrganization')[0].role = 'ADMIN';
    const modes = new SendModeService(db as any);
    await create();
    const execution = await service.reserveApi(
      'org',
      'root',
      'worker',
      sendNow
    );
    await service.authorizeApiSegment(
      'org',
      execution.id,
      0,
      { id: '123', idNamespace: 'x.rest_id' },
      sendNow
    );
    await service.apiOutcome(
      'org',
      execution.id,
      0,
      { status: 'confirmed', eventId: 'confirmed', platformId: 'tweet' },
      sendNow
    );
    await modes.save('org', 'user', {
      mode: 'AUTONOMOUS',
      expectedRevision: 1,
      requestId: 'downgrade',
      expectedOrganizationId: 'org',
      expectedUserId: 'user',
    });
    const root = db.rows('post').find((post) => post.id === 'root');
    expect(root).toMatchObject({
      executionProtocol: 'ACCOUNT_BOUND_V1',
      state: 'PUBLISHED',
    });
    await expect(service.assertLegacyPosts('org', [root])).rejects.toThrow(
      'SEND_COORDINATOR_REQUIRED'
    );
    await expect(service.retry('org', 'root', 'user', sendNow)).rejects.toThrow(
      'SEND_MODE_CONTROLLED_REQUIRED'
    );
    expect(db.rows('sendExecution')).toHaveLength(1);
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({
      heldUnits: 0,
      confirmedUnits: 1,
    });
  });
});

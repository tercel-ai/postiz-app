import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SendModeService,
  SEND_MODE_SYSTEM_KEY,
  organizationSendModeKey,
} from '../send-mode.service';
import { memorySendDatabase } from './support/memory-send-database';

function setup() {
  const db = memorySendDatabase();
  db.seed('userOrganization', {
    organizationId: 'org',
    userId: 'admin',
    role: 'ADMIN',
    disabled: false,
  });
  db.seed('userOrganization', {
    organizationId: 'org',
    userId: 'member',
    role: 'USER',
    disabled: false,
  });
  db.seed('user', { id: 'super', isSuperAdmin: true });
  return { db, service: new SendModeService(db) };
}
const save = (
  mode: 'CONTROLLED' | 'AUTONOMOUS',
  expectedRevision = 0,
  requestId = 'change'
) => ({
  mode,
  expectedRevision,
  requestId,
  expectedOrganizationId: 'org',
  expectedUserId: 'admin',
});
afterEach(() => vi.unstubAllEnvs());

describe('organization sending mode', () => {
  it('binds authenticated mode forms to the displayed organization and user before any mutation', async () => {
    const { db, service } = setup();
    expect(await service.get('org', 'admin')).toMatchObject({
      organizationId: 'org',
      userId: 'admin',
    });
    await expect(
      service.save('org', 'admin', {
        ...save('AUTONOMOUS'),
        expectedOrganizationId: 'other',
        expectedUserId: 'admin',
      } as any)
    ).rejects.toThrow('SEND_OWNER_CHANGED');
    await expect(
      service.save('org', 'admin', {
        ...save('AUTONOMOUS'),
        expectedOrganizationId: 'org',
        expectedUserId: 'other',
      } as any)
    ).rejects.toThrow('SEND_OWNER_CHANGED');
    expect(db.rows('settings')).toHaveLength(0);
    expect(db.rows('sendMutationReceipt')).toHaveLength(0);
  });
  it('defaults an unenrolled organization to autonomous even when the system capability is enabled', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
    const { db, service } = setup();
    expect(await service.stateIn(db, 'org')).toMatchObject({
      mode: 'AUTONOMOUS',
      configuredMode: null,
      revision: 0,
      systemEnabled: true,
      autonomousAllowed: true,
    });
  });
  it('pauses missing organization configuration with controlled history instead of silently downgrading', async () => {
    const { db, service } = setup();
    db.seed('sendIntent', { organizationId: 'org', status: 'SUCCEEDED' });
    expect(await service.stateIn(db, 'org')).toMatchObject({
      mode: 'PAUSED',
      configuredMode: null,
      autonomousAllowed: false,
    });
  });
  it('enables capability from typed Settings when the environment is unset, but explicit false is an emergency stop', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', undefined);
    const { db, service } = setup();
    db.seed('settings', {
      key: SEND_MODE_SYSTEM_KEY,
      value: { enabled: true, revision: 1 },
    });
    db.seed('settings', {
      key: organizationSendModeKey('org'),
      value: { mode: 'CONTROLLED', revision: 1 },
    });
    expect(await service.stateIn(db, 'org')).toMatchObject({
      mode: 'CONTROLLED',
      systemEnabled: true,
    });
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
    expect(await service.stateIn(db, 'org')).toMatchObject({
      mode: 'PAUSED',
      systemEnabled: false,
    });
  });
  it('uses Settings false ahead of environment true and rejects malformed stored configuration', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
    const { db, service } = setup();
    db.seed('settings', {
      key: SEND_MODE_SYSTEM_KEY,
      value: { enabled: false, revision: 2 },
    });
    expect((await service.stateIn(db, 'org')).systemEnabled).toBe(false);
    db.rows('settings')[0].value = { enabled: 'true', revision: 2 };
    await expect(service.stateIn(db, 'org')).rejects.toThrow(
      'SEND_MODE_CONFIGURATION_INVALID'
    );
  });
  it.each([
    { mode: 'LEGACY', revision: 1 },
    { mode: 'AUTONOMOUS', revision: 0 },
    { mode: 'CONTROLLED', revision: '1' },
  ])('fails closed on malformed organization mode Settings: %j', async (value) => {
    const { db, service } = setup();
    db.seed('settings', { key: organizationSendModeKey('org'), value });
    await expect(service.get('org', 'admin')).rejects.toThrow('SEND_MODE_CONFIGURATION_INVALID');
    await expect(service.assertAutonomousIn(db, 'org')).rejects.toThrow('SEND_MODE_CONFIGURATION_INVALID');
    await expect(service.assertControlledIn(db, 'org')).rejects.toThrow('SEND_MODE_CONFIGURATION_INVALID');
    expect(db.rows('sendMutationReceipt')).toHaveLength(0);
  });
  it('requires active administrator membership and reports frontend management permission', async () => {
    const { db, service } = setup();
    expect((await service.get('org', 'member')).canManage).toBe(false);
    expect((await service.get('org', 'admin')).canManage).toBe(true);
    await expect(
      service.save('org', 'member', {
        ...save('AUTONOMOUS'),
        expectedUserId: 'member',
      })
    ).rejects.toThrow('ORGANIZATION_ADMIN_REQUIRED');
    db.rows('userOrganization')[0].disabled = true;
    await expect(
      service.save('org', 'admin', save('AUTONOMOUS'))
    ).rejects.toThrow('ORGANIZATION_MEMBERSHIP_REQUIRED');
    await expect(service.get('other', 'admin')).rejects.toThrow(
      'ORGANIZATION_MEMBERSHIP_REQUIRED'
    );
  });
  it('rejects controlled enrollment while capability is unavailable', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
    const { service } = setup();
    await expect(
      service.save('org', 'admin', save('CONTROLLED'))
    ).rejects.toThrow('ACCOUNT_BINDINGS_NOT_ENABLED');
  });
  it('atomically saves mode, rejects stale writes, and replays original receipts without undoing later changes', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
    const { db, service } = setup();
    const first = await service.save('org', 'admin', save('CONTROLLED'));
    expect(first).toMatchObject({ mode: 'CONTROLLED', revision: 1 });
    await expect(
      service.save('org', 'admin', save('AUTONOMOUS', 0, 'stale'))
    ).rejects.toThrow('SEND_MODE_REVISION_CONFLICT');
    expect(
      await service.save('org', 'admin', save('AUTONOMOUS', 1, 'second'))
    ).toMatchObject({ mode: 'AUTONOMOUS', revision: 2 });
    expect(await service.save('org', 'admin', save('CONTROLLED'))).toEqual(
      first
    );
    expect((await service.stateIn(db, 'org')).mode).toBe('AUTONOMOUS');
    await expect(
      service.save('org', 'admin', save('AUTONOMOUS'))
    ).rejects.toThrow('REQUEST_ID_CONFLICT');
  });
  it('serializes competing mode saves with a single winning expected revision', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
    const { service } = setup();
    const results = await Promise.allSettled([
      service.save('org', 'admin', save('CONTROLLED', 0, 'a')),
      service.save('org', 'admin', save('AUTONOMOUS', 0, 'b')),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected')
    ).toHaveLength(1);
  });
  it.each([
    [
      'post',
      { state: 'QUEUE', sendIntentId: null, executionProtocol: null },
      'legacyQueuedPosts',
    ],
    [
      'post',
      {
        state: 'DRAFT',
        source: 'engage',
        sendIntentId: null,
        executionProtocol: null,
      },
      'legacyReplyDrafts',
    ],
    [
      'post',
      {
        state: 'ERROR',
        sendIntentId: null,
        executionProtocol: null,
        releaseId: 'lease',
        claimedAt: new Date(),
      },
      'legacyClaims',
    ],
  ])(
    'drains active claims while preserving unstarted work in %s',
    async (table, fields, blocker) => {
      vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
      const { db, service } = setup();
      db.seed(table, { organizationId: 'org', ...fields });
      const result = await service.save('org', 'admin', save('CONTROLLED'));
      if (blocker === 'legacyClaims') {
        expect(result).toMatchObject({ mode: 'CONTROLLED', legacyDrain: { remainingCount: 1 } });
        expect(db.rows('post')[0]).toMatchObject({ state: 'ERROR', releaseId: 'lease' });
      } else {
        expect(result).toMatchObject({ mode: 'CONTROLLED', transition: null });
        if (blocker === 'legacyReplyDrafts') {
          expect(db.rows('post')[0].state).toBe('DRAFT');
          expect(result.reallocation).toBeNull();
        } else {
          expect(db.rows('post')[0]).toMatchObject({ state: 'QUEUE', deletedAt: null });
          expect(result.reallocation).toMatchObject({ remainingCount: 1, completedCount: 0 });
        }
      }
      expect(db.rows('sendMutationReceipt')).toHaveLength(1);
    }
  );
  it('allows inert calendar drafts and foreign organization work when enrolling', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
    const { db, service } = setup();
    db.seed('post', {
      organizationId: 'org',
      state: 'DRAFT',
      source: 'calendar',
    });
    db.seed('post', { organizationId: 'other', state: 'QUEUE' });
    expect(
      await service.save('org', 'admin', save('CONTROLLED'))
    ).toMatchObject({ mode: 'CONTROLLED' });
  });
  it.each([
    ['sendIntent', { status: 'QUEUED', rootPostId: 'root' }, 'nonterminalIntents'],
    ['sendExecution', { status: 'RESERVED' }, 'activeExecutions'],
    ['sendExecution', { status: 'SENDING' }, 'activeExecutions'],
    ['sendExecution', { status: 'RECONCILING' }, 'activeExecutions'],
    ['sendSegment', { status: 'AUTHORIZED' }, 'uncertainSegments'],
    ['sendSegment', { status: 'UNKNOWN' }, 'uncertainSegments'],
    ['sendQuotaReservation', { state: 'HELD' }, 'heldQuotaReservations'],
    ['accountWriteState', { activeExecutionId: 'execution' }, 'accountLocks'],
    [
      'post',
      {
        state: 'DRAFT',
        executionProtocol: 'ACCOUNT_BOUND_V1',
        sendIntentId: null,
      },
      'controlledPendingPosts',
    ],
    [
      'post',
      {
        state: 'QUEUE',
        executionProtocol: 'ACCOUNT_BOUND_V1',
        sendIntentId: null,
      },
      'controlledPendingPosts',
    ],
  ])(
    'switches immediately while preserving live %s obligation',
    async (table, fields, blocker) => {
      vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
      const { db, service } = setup();
      db.seed('settings', {
        key: organizationSendModeKey('org'),
        value: { mode: 'CONTROLLED', revision: 1 },
      });
      db.seed(table, { organizationId: 'org', ...fields });
      const result = await service.save('org', 'admin', save('AUTONOMOUS', 1));
      expect(result).toMatchObject({ mode: 'AUTONOMOUS', autonomousAllowed: true, revision: 2 });
      const inertDraft = table === 'post' && fields.state === 'DRAFT';
      if (!inertDraft) {
        expect(result.blockers[blocker]).toBe(1);
        expect(result.controlledDrain?.remainingCount).toBeGreaterThan(0);
      } else expect(db.rows('post')[0].executionProtocol).toBe('LEGACY');
      expect(db.rows(table)).toHaveLength(1);

    }
  );
  it('permits an explicit safe downgrade with terminal history and keeps history unchanged', async () => {
    const { db, service } = setup();
    db.seed('settings', {
      key: organizationSendModeKey('org'),
      value: { mode: 'CONTROLLED', revision: 1 },
    });
    db.seed('sendIntent', { organizationId: 'org', status: 'FAILED_FINAL' });
    db.seed('sendExecution', { organizationId: 'org', status: 'CONFIRMED' });
    db.seed('accountWriteState', {
      organizationId: 'org',
      activeExecutionId: null,
      rolloutReady: true,
    });
    expect(
      await service.save('org', 'admin', save('AUTONOMOUS', 1))
    ).toMatchObject({ mode: 'AUTONOMOUS', autonomousAllowed: true });
    expect(db.rows('sendExecution')[0].status).toBe('CONFIRMED');
  });
  it('fails closed if autonomous configuration has concurrent controlled obligations', async () => {
    const { db, service } = setup();
    db.seed('settings', {
      key: organizationSendModeKey('org'),
      value: { mode: 'AUTONOMOUS', revision: 1 },
    });
    db.seed('sendIntent', { organizationId: 'org', status: 'QUEUED' });
    expect(await service.stateIn(db, 'org')).toMatchObject({
      mode: 'PAUSED',
      autonomousAllowed: false,
    });
    await expect(service.assertAutonomousIn(db, 'org')).rejects.toThrow(
      'SEND_MODE_AUTONOMOUS_REQUIRED'
    );
  });
  it('locks both configuration rows without turning missing controlled history into implicit enrollment', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
    const { db, service } = setup();
    db.seed('sendIntent', { organizationId: 'org', status: 'SUCCEEDED' });
    expect(await service.lockIn(db, 'org')).toMatchObject({
      mode: 'PAUSED',
      revision: 0,
    });
    expect(db.rows('settings').map((row) => row.key)).toEqual([
      SEND_MODE_SYSTEM_KEY,
      organizationSendModeKey('org'),
    ]);
    await expect(service.assertControlledIn(db, 'org')).rejects.toThrow(
      'SEND_MODE_CONTROLLED_REQUIRED'
    );
  });
  it('rejects malformed mutations even without controller validation', async () => {
    const { service } = setup();
    for (const body of [
      null,
      { mode: 'LEGACY', expectedRevision: 0, requestId: 'a' },
      save('AUTONOMOUS', -1),
      save('AUTONOMOUS', 0, ' '),
    ])
      await expect(service.save('org', 'admin', body as any)).rejects.toThrow(
        'INVALID_SEND_MODE_MUTATION'
      );
  });
  it('restricts capability writes to platform superadmins and uses independent idempotency receipts', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', undefined);
    const { db, service } = setup();
    const body = { enabled: true, expectedRevision: 0, requestId: 'system' };
    await expect(service.saveSystem('admin', body)).rejects.toThrow(
      'PLATFORM_SUPERADMIN_REQUIRED'
    );
    const first = await service.saveSystem('super', body);
    expect(first).toMatchObject({
      value: { enabled: true, revision: 1 },
      effectiveEnabled: true,
    });
    await service.saveSystem('super', {
      enabled: false,
      expectedRevision: 1,
      requestId: 'disable',
    });
    expect(await service.saveSystem('super', body)).toEqual(first);
    expect(await service.getSystem()).toMatchObject({
      value: { enabled: false, revision: 2 },
      effectiveEnabled: false,
    });
    expect(db.rows('systemSendPolicyMutationReceipt')).toHaveLength(2);
    await expect(
      service.saveSystem('super', { ...body, enabled: false })
    ).rejects.toThrow('REQUEST_ID_CONFLICT');
  });
});

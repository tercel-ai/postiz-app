import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendModeService } from '../send-mode.service';
import { SendModeTransitionReconciliationService } from '@gitroom/backend/services/send-mode-transition-reconciliation.service';
import { memorySendDatabase } from './support/memory-send-database';

beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());

function setup() {
  const db = memorySendDatabase();
  db.seed('userOrganization', { organizationId: 'org', userId: 'admin', role: 'ADMIN', disabled: false });
  const metadata = {
    automationEnabled: true, autoReplyEnabled: true, publishingEnabled: true,
    replyPolicies: { x: { autoReplyEnabled: true, publishingEnabled: true, dailyReplyLimit: 4, windowStart: '08:00', windowEnd: '18:00' } },
  };
  db.seed('engageConfig', { organizationId: 'org', projectId: 'project', enabled: true, metadata });
  return { db, metadata, modes: new SendModeService(db) };
}
const switchMode = (modes: SendModeService, mode: 'CONTROLLED' | 'AUTONOMOUS', revision: number) =>
  modes.save('org', 'admin', { mode, expectedOrganizationId: 'org', expectedUserId: 'admin', expectedRevision: revision, requestId: `switch-${revision}` });

describe('automation continuity across sending modes', () => {
  it('initializes both policy owners in the mode transaction without altering configuration or dispatching', async () => {
    const { db, modes, metadata } = setup();
    const state = await switchMode(modes, 'CONTROLLED', 0);
    expect(state.mode).toBe('CONTROLLED');
    expect(db.rows('projectSendOwner')).toEqual(expect.arrayContaining([
      expect.objectContaining({ organizationId: 'org', projectId: 'project', action: 'REPLY', userId: 'admin' }),
      expect.objectContaining({ organizationId: 'org', projectId: 'project', action: 'POST', userId: 'admin' }),
    ]));
    expect(db.rows('engageConfig')[0].metadata).toEqual(metadata);
    expect(db.rows('post')).toEqual([]);
    expect(db.rows('sendExecution')).toEqual([]);
  });

  it('preserves existing owners and keeps initialization idempotent across round trips', async () => {
    const { db, modes } = setup();
    db.seed('projectSendOwner', { organizationId: 'org', projectId: 'project', action: 'REPLY', userId: 'original-owner', revision: 7 });
    await switchMode(modes, 'CONTROLLED', 0);
    await switchMode(modes, 'AUTONOMOUS', 1);
    await switchMode(modes, 'CONTROLLED', 2);
    await modes.reconcileAutomationOwners();
    expect(db.rows('projectSendOwner')).toHaveLength(2);
    expect(db.rows('projectSendOwner').find(row => row.action === 'REPLY')).toMatchObject({ userId: 'original-owner', revision: 7 });
  });

  it('initializes configured features even when the master switch is off without enabling them', async () => {
    const { db, modes } = setup();
    db.rows('engageConfig')[0].metadata.automationEnabled = false;
    db.seed('engageConfig', { organizationId: 'other', projectId: 'other-project', metadata: { autoReplyEnabled: true } });
    db.seed('engageConfig', { organizationId: 'org', projectId: null, metadata: { autoReplyEnabled: true } });
    db.seed('engageConfig', { organizationId: 'org', projectId: 'unconfigured', metadata: {} });
    await switchMode(modes, 'CONTROLLED', 0);
    expect(db.rows('projectSendOwner')).toHaveLength(2);
    expect(db.rows('projectSendOwner').every(row => row.organizationId === 'org' && row.projectId === 'project')).toBe(true);
    expect(db.rows('engageConfig')[0].metadata.automationEnabled).toBe(false);
  });

  it('rolls back the mode change when initialization fails', async () => {
    const { db, modes } = setup();
    const owners = db.projectSendOwner;
    Object.defineProperty(db, 'projectSendOwner', { value: { ...owners, upsert: vi.fn().mockRejectedValue(new Error('storage unavailable')) } });
    await expect(switchMode(modes, 'CONTROLLED', 0)).rejects.toThrow('storage unavailable');
    expect(db.rows('settings').find(row => row.key === 'sending.organization_mode:org')).toBeUndefined();
    expect(db.rows('projectSendOwner')).toEqual([]);
  });

  it('repairs an already controlled organization from its original reallocation administrator before the marker clears', async () => {
    const { db, modes, metadata } = setup();
    db.seed('settings', { key: 'sending.organization_mode:org', value: {
      mode: 'CONTROLLED', revision: 2, reallocation: { version: 1, requestedAt: '2026-10-21T02:57:41Z', requestedByUserId: 'admin', initialCount: 12, issues: [] },
    } });
    await modes.reconcileAutomationOwners();
    await modes.recordReallocationIssues('org', []);
    await modes.reconcileAutomationOwners();
    expect(db.rows('projectSendOwner')).toHaveLength(2);
    expect(db.rows('engageConfig')[0].metadata).toEqual(metadata);
    expect(db.rows('settings').find(row => row.key === 'sending.organization_mode:org').value.reallocation).toBeUndefined();
  });

  function settledLegacyCutover() {
    const fixture = setup();
    fixture.db.seed('settings', { key: 'sending.organization_mode:org', value: {
      mode: 'CONTROLLED', revision: 2, legacyDrain: {
        version: 2, targetMode: 'CONTROLLED', requestedAt: '2026-10-21T02:57:41Z', requestedByUserId: 'admin',
        eligiblePostIds: ['finished-post'], eligiblePostOccurrences: { 'finished-post': '2026-10-21T03:00:00.000Z' }, initialPendingCount: 1,
      },
    } });
    fixture.db.seed('post', { id: 'finished-post', organizationId: 'org', projectId: 'project', state: 'PUBLISHED',
      publishDate: new Date('2026-10-21T03:00:00Z'), source: 'calendar', executionProtocol: null, sendIntentId: null });
    fixture.db.seed('sendMutationReceipt', { organizationId: 'org', operation: 'organization-send-mode', userId: 'admin',
      result: { configuredMode: 'AUTONOMOUS', revision: 1 } });
    return fixture;
  }

  it.each(['ADMIN', 'SUPERADMIN'])('restores owners from a completed legacy drain before bootstrap cleanup for %s', async role => {
    const { db, modes, metadata } = settledLegacyCutover();
    db.rows('userOrganization')[0].role = role;
    const originalPost = structuredClone(db.rows('post')[0]);
    const coordinator = { reallocateUnsentLegacy: vi.fn() };
    let complete!: () => void;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    vi.spyOn(modes, 'pendingReallocations').mockImplementation(async () => { complete(); return []; });
    const reconciler = new SendModeTransitionReconciliationService(modes, coordinator as any);
    try {
      reconciler.onApplicationBootstrap();
      await completed;
    } finally {
      reconciler.onApplicationShutdown();
    }
    expect(db.rows('projectSendOwner')).toHaveLength(2);
    expect(db.rows('projectSendOwner').map(owner => [owner.action, owner.userId]).sort()).toEqual([['POST', 'admin'], ['REPLY', 'admin']]);
    expect(db.rows('settings').find(row => row.key === 'sending.organization_mode:org').value).toEqual({ mode: 'CONTROLLED', revision: 2 });
    expect(db.rows('post')[0]).toEqual(originalPost);
    expect(db.rows('engageConfig')[0].metadata).toEqual(metadata);
    expect(coordinator.reallocateUnsentLegacy).not.toHaveBeenCalled();
    expect(db.rows('sendExecution')).toEqual([]);
    await modes.reconcileAutomationOwners();
    expect(db.rows('projectSendOwner')).toHaveLength(2);
  });

  it('rolls back partial owner recovery and retains legacy provenance until a retry succeeds', async () => {
    const { db, modes } = settledLegacyCutover();
    const originalSetting = structuredClone(db.rows('settings')[0]);
    const owners = db.projectSendOwner;
    const upsert = vi.fn(async args => {
      if (args.create.action === 'POST') throw new Error('storage unavailable');
      return owners.upsert(args);
    });
    Object.defineProperty(db, 'projectSendOwner', { value: { ...owners, upsert } });
    await modes.reconcilePendingTransitions();
    expect(db.rows('settings')[0]).toEqual(originalSetting);
    expect(db.rows('projectSendOwner')).toEqual([]);
    upsert.mockImplementation(owners.upsert);
    await modes.reconcilePendingTransitions();
    expect(db.rows('projectSendOwner')).toHaveLength(2);
    expect(db.rows('settings')[0].value).toEqual({ mode: 'CONTROLLED', revision: 2 });
  });

  it('retains legacy provenance without granting authority to a revoked administrator', async () => {
    const { db, modes } = settledLegacyCutover();
    db.rows('userOrganization')[0].disabled = true;
    const originalSetting = structuredClone(db.rows('settings')[0]);
    await modes.reconcilePendingTransitions();
    expect(db.rows('settings')[0]).toEqual(originalSetting);
    expect(db.rows('projectSendOwner')).toEqual([]);
  });

  it('recovers configured owners while paused without enabling sending or losing the last requester', async () => {
    const { db, modes } = settledLegacyCutover();
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
    await modes.reconcilePendingTransitions();
    expect(db.rows('projectSendOwner')).toHaveLength(2);
    expect(await modes.stateIn(db, 'org')).toMatchObject({ mode: 'PAUSED', autonomousAllowed: false });
    expect(db.rows('sendExecution')).toEqual([]);
  });

  it('does not initialize controlled owners while cleaning up an autonomous legacy drain', async () => {
    const { db, modes } = settledLegacyCutover();
    db.rows('settings')[0].value.mode = 'AUTONOMOUS';
    await modes.reconcilePendingTransitions();
    expect(db.rows('projectSendOwner')).toEqual([]);
    expect(db.rows('settings')[0].value).toEqual({ mode: 'AUTONOMOUS', revision: 2 });
  });

  it('repairs from a matching controlled switch receipt when no drain marker remains', async () => {
    const { db, modes } = setup();
    db.seed('settings', { key: 'sending.organization_mode:org', value: { mode: 'CONTROLLED', revision: 3 } });
    db.seed('sendMutationReceipt', { organizationId: 'org', operation: 'organization-send-mode', userId: 'admin', result: { configuredMode: 'CONTROLLED', revision: 3 } });
    await modes.reconcileAutomationOwners();
    expect(db.rows('projectSendOwner')).toHaveLength(2);
  });

  it.each(['missing-provenance', 'revoked-admin', 'stale-receipt', 'autonomous'])('does not invent authorization for %s', async scenario => {
    const { db, modes } = setup();
    db.seed('settings', { key: 'sending.organization_mode:org', value: { mode: scenario === 'autonomous' ? 'AUTONOMOUS' : 'CONTROLLED', revision: 3 } });
    if (scenario !== 'missing-provenance') db.seed('sendMutationReceipt', {
      organizationId: 'org', operation: 'organization-send-mode', userId: 'admin', result: { configuredMode: 'CONTROLLED', revision: scenario === 'stale-receipt' ? 2 : 3 },
    });
    if (scenario === 'revoked-admin') db.rows('userOrganization')[0].disabled = true;
    await modes.reconcileAutomationOwners();
    expect(db.rows('projectSendOwner')).toEqual([]);
  });

  it('initializes owners when an older pending transition upgrades to controlled', async () => {
    const { db, modes } = setup();
    db.seed('settings', { key: 'sending.organization_mode:org', value: { mode: 'AUTONOMOUS', revision: 1, transition: {
      version: 2, targetMode: 'CONTROLLED', requestedAt: '2026-10-21T02:57:41Z', requestedByUserId: 'admin',
      eligiblePostIds: [], eligiblePostOccurrences: {}, initialPendingCount: 0,
    } } });
    await modes.reconcilePendingTransitions();
    expect(db.rows('projectSendOwner')).toHaveLength(2);
    expect((await modes.get('org', 'admin')).mode).toBe('CONTROLLED');
  });
});

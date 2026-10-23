import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendModeService } from '../send-mode.service';
import { setupSend, sendNow } from './support/send-fixture';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(sendNow); vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
const owner = { expectedOrganizationId: 'org', expectedUserId: 'user' };
function setup() {
  const fixture = setupSend();
  fixture.db.rows('userOrganization')[0].role = 'ADMIN';
  const modes = new SendModeService(fixture.db);
  const reverse = () =>
    modes.save('org', 'user', {
      ...owner,
      mode: 'AUTONOMOUS',
      expectedRevision: 1,
      requestId: 'reverse',
    });
  return { ...fixture, modes, reverse };
}
it('switches immediately and hands over an untouched queue without changing content, account or schedule', async () => {
  const { db, create, modes, reverse } = setup();
  await create();
  const before = structuredClone(db.rows('post')[0]);
  const result = await reverse();
  expect(result).toMatchObject({
    mode: 'AUTONOMOUS',
    autonomousAllowed: true,
    revision: 2,
    transition: null,
  });
  expect(db.rows('post')[0]).toMatchObject({
    id: before.id,
    content: before.content,
    projectId: before.projectId,
    integrationId: before.integrationId,
    publishDate: before.publishDate,
    state: 'QUEUE',
    sendIntentId: null,
    executionProtocol: 'LEGACY',
  });
  expect(db.rows('sendIntent')[0].status).toBe('HANDED_OVER');
  await expect(
    modes.assertAutonomousIn(db, 'org', ['root'])
  ).resolves.toBeDefined();
  expect(db.rows('sendExecution')).toHaveLength(0);
  expect(db.rows('sendQuotaReservation')).toHaveLength(0);
});
it('allows the original reserved execution to finish after switching while fencing new controlled enqueue', async () => {
  const { db, service, create, modes, reverse } = setup();
  await create();
  const execution = await service.reserveApi('org', 'root', 'worker', sendNow);
  expect(await reverse()).toMatchObject({
    mode: 'AUTONOMOUS',
    autonomousAllowed: true,
    controlledDrain: { targetMode: 'AUTONOMOUS', remainingCount: 1 },
  });
  expect(db.rows('post')[0]).toMatchObject({
    executionProtocol: 'ACCOUNT_BOUND_V1',
    sendIntentId: execution.sendIntentId,
  });
  await expect(create('new')).rejects.toThrow('SEND_MODE_CONTROLLED_REQUIRED');
  await expect(
    service.authorizeApiSegment(
      'org',
      execution.id,
      0,
      { id: '123', idNamespace: 'x.rest_id' },
      sendNow
    )
  ).resolves.toBeDefined();
  await service.apiOutcome(
    'org',
    execution.id,
    0,
    { eventId: 'confirmed', status: 'confirmed', platformId: 'remote' },
    sendNow
  );
  await modes.reconcilePendingTransitions();
  expect(await modes.get('org', 'user')).toMatchObject({
    mode: 'AUTONOMOUS',
    revision: 2,
    controlledDrain: null,
  });
});
it('keeps unknown outcomes and held quota protected without delaying the organization mode change', async () => {
  const { db, service, create, reverse, modes } = setup();
  await create();
  const execution = await service.reserveApi('org', 'root', 'worker', sendNow);
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
    { eventId: 'unknown', status: 'unknown' },
    sendNow
  );
  const before = structuredClone(db.rows('sendQuotaReservation'));
  expect(await reverse()).toMatchObject({
    mode: 'AUTONOMOUS',
    controlledDrain: { status: 'NEEDS_ATTENTION' },
  });
  expect(db.rows('sendQuotaReservation')).toEqual(before);
  await expect(
    modes.beginBrowserWrite('org', 'user', {
      ...owner,
      requestId: 'same-platform',
      platform: 'x',
      contentHash: 'a'.repeat(64),
    })
  ).rejects.toThrow('CONTROLLED_ACCOUNT_DRAIN_REQUIRED');
  await expect(
    modes.beginBrowserWrite('org', 'user', {
      ...owner,
      requestId: 'other-platform',
      platform: 'reddit',
      contentHash: 'b'.repeat(64),
    })
  ).resolves.toMatchObject({ admitted: true });
  await modes.reconcilePendingTransitions();
  expect(
    (await modes.get('org', 'user')).controlledDrain?.remainingCount
  ).toBeGreaterThan(0);
});
it('transfers account-bound drafts without an intent and does not invent a sending account', async () => {
  const { db, reverse } = setup();
  db.seed('post', {
    id: 'draft',
    organizationId: 'org',
    state: 'DRAFT',
    parentPostId: null,
    executionProtocol: 'ACCOUNT_BOUND_V1',
    integrationId: null,
  });
  expect(await reverse()).toMatchObject({
    mode: 'AUTONOMOUS',
    autonomousAllowed: true,
  });
  expect(db.rows('post')[0]).toMatchObject({
    state: 'DRAFT',
    executionProtocol: 'LEGACY',
    integrationId: null,
  });
});
it('keeps a queue with unresolved current-session identity in the controlled drain rather than substituting a browser account', async () => {
  const { db, create, reverse } = setup();
  await create();
  Object.assign(db.rows('sendIntent')[0], {
    integrationId: null,
    canonicalAccountKey: null,
    target: null,
  });
  Object.assign(db.rows('post')[0], {
    integrationId: null,
    accountSelectionMode: 'CURRENT_SESSION',
  });
  expect(await reverse()).toMatchObject({
    mode: 'AUTONOMOUS',
    controlledDrain: { remainingCount: 1, status: 'NEEDS_ATTENTION' },
  });
  expect(db.rows('post')[0].executionProtocol).toBe('ACCOUNT_BOUND_V1');
});
it('re-enrolls a handed-over untouched task through normal controlled validation after switching back', async () => {
  const { db, service, create, reverse, modes } = setup();
  await create();
  await reverse();
  await modes.save('org', 'user', {
    ...owner,
    mode: 'CONTROLLED',
    expectedRevision: 2,
    requestId: 'forward',
  });
  await service.reallocateUnsentLegacy('org', 'user');
  expect(db.rows('sendIntent')).toHaveLength(1);
  expect(db.rows('sendIntent')[0].status).toBe('QUEUED');
  expect(db.rows('post')[0]).toMatchObject({
    sendIntentId: db.rows('sendIntent')[0].id,
    executionProtocol: 'ACCOUNT_BOUND_V1',
  });
});
it('returns the original target for a handed-over browser task and retains original receipt idempotency', async () => {
  const { create, reverse, modes } = setup();
  await create();
  await reverse();
  const body = {
    ...owner,
    requestId: 'write',
    platform: 'x',
    postId: 'root',
    handoverAccountVerification: true,
    contentHash: 'a'.repeat(64),
  };
  expect(await modes.beginBrowserWrite('org', 'user', body)).toMatchObject({
    admitted: true,
    targetAccount: { id: '123', idNamespace: 'x.rest_id' },
  });
  expect(await modes.beginBrowserWrite('org', 'user', body)).toMatchObject({
    admitted: false,
  });
});

it('rejects a fresh autonomous API effect in controlled mode even without legacy drain work', async () => {
  const { modes } = setup();
  const work = vi.fn();
  await expect(
    modes.autonomousEffect(
      'org',
      'new-api-write',
      { integrationId: 'account', action: 'PLUG' },
      work
    )
  ).rejects.toThrow('SEND_MODE_AUTONOMOUS_REQUIRED');
  expect(work).not.toHaveBeenCalled();
});
it('requires a receipt-capable extension to verify a handed-over task account', async () => {
  const { create, reverse, modes } = setup();
  await create();
  await reverse();
  await expect(
    modes.beginBrowserWrite('org', 'user', {
      ...owner,
      requestId: 'old-extension',
      platform: 'x',
      postId: 'root',
      contentHash: 'a'.repeat(64),
    })
  ).rejects.toThrow('HANDOVER_EXTENSION_UPGRADE_REQUIRED');
});
it('does not release unknown segment protection just because its execution expired', async () => {
  const { db, service, create, reverse, modes } = setup();
  await create();
  const execution = await service.reserveApi('org', 'root', 'worker', sendNow);
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
    { eventId: 'unknown', status: 'unknown' },
    sendNow
  );
  db.rows('sendExecution')[0].status = 'EXPIRED';
  await reverse();
  await expect(
    modes.beginBrowserWrite('org', 'user', {
      ...owner,
      requestId: 'new-x',
      platform: 'x',
      contentHash: 'a'.repeat(64),
    })
  ).rejects.toThrow('CONTROLLED_ACCOUNT_DRAIN_REQUIRED');
});

it('shows original controlled executions as running while keeping new controlled actions unavailable', async () => {
  const { service, create, reverse } = setup();
  await create();
  await service.reserveApi('org', 'root', 'worker', sendNow);
  await reverse();
  const summary = await service.businessSummary('org', 'user', 'root');
  expect(summary.paused).toBe(false);
  expect(summary.allowedActions.enqueue.allowed).toBe(false);
  expect(summary.allowedActions.retry.allowed).toBe(false);
});

it('keeps an older autonomous API write protected across controlled then autonomous switches', async () => {
  const { db, modes } = setup();
  db.rows('settings')[0].value = { mode: 'AUTONOMOUS', revision: 1 };
  await expect(
    modes.autonomousEffect(
      'org',
      'old-api',
      { integrationId: 'account', action: 'PLUG' },
      async () => {
        throw new Error('Lost outcome');
      }
    )
  ).rejects.toThrow('AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
  await modes.save('org', 'user', {
    ...owner,
    mode: 'CONTROLLED',
    expectedRevision: 1,
    requestId: 'forward',
  });
  await modes.save('org', 'user', {
    ...owner,
    mode: 'AUTONOMOUS',
    expectedRevision: 2,
    requestId: 'reverse',
  });
  await expect(
    modes.beginBrowserWrite('org', 'user', {
      ...owner,
      requestId: 'new-browser',
      platform: 'x',
      contentHash: 'a'.repeat(64),
    })
  ).rejects.toThrow('LEGACY_ACCOUNT_DRAIN_REQUIRED');
  await expect(
    modes.beginBrowserWrite('org', 'user', {
      ...owner,
      requestId: 'other-browser',
      platform: 'reddit',
      contentHash: 'b'.repeat(64),
    })
  ).resolves.toMatchObject({ admitted: true });
});

it('preserves an explicitly selected account on a draft that has not acquired an intent yet', async () => {
  const { db, reverse, modes } = setup();
  db.seed('post', {
    id: 'draft',
    organizationId: 'org',
    state: 'DRAFT',
    parentPostId: null,
    executionProtocol: 'ACCOUNT_BOUND_V1',
    integrationId: 'account',
    providerIdentifier: 'x',
    sendTarget: null,
  });
  await reverse();
  expect(
    await modes.beginBrowserWrite('org', 'user', {
      ...owner,
      requestId: 'draft-write',
      platform: 'x',
      postId: 'draft',
      handoverAccountVerification: true,
      contentHash: 'a'.repeat(64),
    })
  ).toMatchObject({
    admitted: true,
    targetAccount: { id: '123', idNamespace: 'x.rest_id' },
  });
});

it('keeps conflicting new autonomous work out of the due queue until the original controlled account settles', async () => {
  const { service, create, reverse } = setup(); await create();
  await service.reserveApi('org', 'root', 'worker', sendNow); await reverse();
  const blocked = await service.legacyBlockedPlatforms('org');
  expect(blocked).toContain('x');
  expect(blocked).not.toContain('reddit');
});


describe('captured legacy API work after a mode roundtrip', () => {
  async function roundtrip() {
    const { db, modes } = setup();
    db.rows('settings')[0].value = { mode: 'AUTONOMOUS', revision: 1 };
    db.seed('post', {
      id: 'claimed', organizationId: 'org', projectId: 'project',
      parentPostId: null, state: 'QUEUE', providerIdentifier: 'x',
      integrationId: 'account', publishMethod: 'API', publishDate: sendNow,
      createdAt: sendNow, releaseId: 'original-lease', claimedAt: new Date(),
    });
    await modes.save('org', 'user', {
      ...owner, mode: 'CONTROLLED', expectedRevision: 1, requestId: 'forward',
    });
    await modes.save('org', 'user', {
      ...owner, mode: 'AUTONOMOUS', expectedRevision: 2, requestId: 'reverse',
    });
    return { db, modes };
  }

  it('allows the original captured API continuation to settle after returning to autonomous mode', async () => {
    const { db, modes } = await roundtrip();
    const work = vi.fn().mockResolvedValue([{ postId: 'remote' }]);
    await expect(modes.autonomousEffect('org', 'original-worker', {
      integrationId: 'account', action: 'POST', postIds: ['claimed'], occurrenceKey: 'single',
    }, work)).resolves.toEqual([{ postId: 'remote' }]);
    expect(work).toHaveBeenCalledTimes(1);
    expect(db.rows('sendMutationReceipt').some(receipt =>
      receipt.result.status === 'CONFIRMED' && receipt.result.postIds?.includes('claimed')
    )).toBe(true);
    Object.assign(db.rows('post')[0], { state: 'PUBLISHED', releaseId: 'remote' });
    await modes.reconcilePendingTransitions();
    expect((await modes.get('org', 'user')).legacyDrain).toBeNull();
  });

  it('still refuses new autonomous API work on the captured account', async () => {
    const { db, modes } = await roundtrip();
    db.seed('post', {
      id: 'new-post', organizationId: 'org', projectId: 'project', parentPostId: null,
      state: 'QUEUE', providerIdentifier: 'x', integrationId: 'account', publishMethod: 'API',
      publishDate: sendNow,
    });
    const work = vi.fn();
    await expect(modes.autonomousEffect('org', 'new-worker', {
      integrationId: 'account', action: 'POST', postIds: ['new-post'], occurrenceKey: 'single',
    }, work)).rejects.toThrow('LEGACY_ACCOUNT_DRAIN_REQUIRED');
    expect(work).not.toHaveBeenCalled();
  });

  it('refuses to continue a captured API task whose scheduled occurrence changed', async () => {
    const { db, modes } = await roundtrip();
    db.rows('post')[0].publishDate = new Date(sendNow.getTime() + 86400000);
    const work = vi.fn();
    await expect(modes.autonomousEffect('org', 'changed-occurrence', {
      integrationId: 'account', action: 'POST', postIds: ['claimed'], occurrenceKey: 'single',
    }, work)).rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
    expect(work).not.toHaveBeenCalled();
  });
});


describe('LinkedIn company autonomous handover compatibility', () => {
  async function queued(method: 'API' | 'EXTENSION', provider = 'linkedin-page', namespace = 'linkedin.organization_id') {
    const fixture = setup();
    await fixture.create();
    Object.assign(fixture.db.rows('integration')[0], {
      providerIdentifier: provider, internalId: '123', identityNamespace: namespace,
    });
    Object.assign(fixture.db.rows('post')[0], {
      providerIdentifier: provider, publishMethod: method,
      sendTarget: { id: '123', idNamespace: namespace },
    });
    Object.assign(fixture.db.rows('sendIntent')[0], {
      platform: provider === 'linkedin-page' ? 'linkedin' : provider,
      target: { id: '123', idNamespace: namespace },
    });
    return fixture;
  }

  it('retains an untouched company extension queue with its controlled intent and target', async () => {
    const { db, reverse, modes } = await queued('EXTENSION');
    const before = structuredClone(db.rows('post')[0]);
    const result = await reverse();
    expect(result).toMatchObject({
      mode: 'AUTONOMOUS', controlledDrain: { remainingCount: 1, status: 'NEEDS_ATTENTION',
        issues: [{ postId: 'root', code: 'HANDOVER_LINKEDIN_COMPANY_UNSUPPORTED' }] },
    });
    expect(db.rows('post')[0]).toEqual(before);
    expect(db.rows('sendIntent')[0].status).toBe('QUEUED');
    await modes.reconcilePendingTransitions();
    expect((await modes.get('org', 'user')).controlledDrain?.remainingCount).toBe(1);
  });

  it('retains a company extension draft without an intent and reports the unsupported handover', async () => {
    const { db, reverse, modes } = setup();
    Object.assign(db.rows('integration')[0], {
      providerIdentifier: 'linkedin-page', identityNamespace: 'linkedin.organization_id',
    });
    db.seed('post', {
      id: 'company-draft', organizationId: 'org', projectId: 'project', state: 'DRAFT',
      parentPostId: null, executionProtocol: 'ACCOUNT_BOUND_V1', integrationId: 'account',
      providerIdentifier: 'linkedin-page', publishMethod: 'EXTENSION', sendIntentId: null,
    });
    const before = structuredClone(db.rows('post')[0]);
    const result = await reverse();
    expect(result.controlledDrain).toMatchObject({ remainingCount: 1, status: 'NEEDS_ATTENTION',
      issues: [{ postId: 'company-draft', code: 'HANDOVER_LINKEDIN_COMPANY_UNSUPPORTED' }] });
    expect(db.rows('post')[0]).toEqual(before);
    expect(db.rows('sendIntent')).toHaveLength(0);
    await modes.reconcilePendingTransitions();
    expect((await modes.get('org', 'user')).controlledDrain?.remainingCount).toBe(1);
  });

  it.each([
    ['API company', 'API', 'linkedin-page', 'linkedin.organization_id'],
    ['personal LinkedIn', 'EXTENSION', 'linkedin', 'linkedin.member_urn'],
    ['ordinary X', 'EXTENSION', 'x', 'x.rest_id'],
  ] as const)('continues to transfer %s tasks', async (_name, method, provider, namespace) => {
    const { db, reverse } = await queued(method, provider, namespace);
    expect(await reverse()).toMatchObject({ mode: 'AUTONOMOUS' });
    expect(db.rows('post')[0]).toMatchObject({ executionProtocol: 'LEGACY', sendIntentId: null,
      providerIdentifier: provider, publishMethod: method,
      sendTarget: { id: '123', idNamespace: namespace, handoverMode: 'AUTONOMOUS' } });
    expect(db.rows('sendIntent')[0].status).toBe('HANDED_OVER');
  });
});


it('allows independent autonomous work after the original controlled permit expires while retaining reconciliation', async () => {
  const { db, service, create, reverse, modes } = setup(); await create();
  const old = await service.reserveApi('org', 'root', 'worker', sendNow);
  await service.authorizeApiSegment('org', old.id, 0, { id: '123', idNamespace: 'x.rest_id' }, sendNow);
  await service.apiOutcome('org', old.id, 0, { status: 'unknown', eventId: 'lost' }, sendNow);
  await reverse();
  vi.setSystemTime(new Date(sendNow.getTime() + 31000));
  expect(await modes.beginBrowserWrite('org', 'user', { ...owner, requestId: 'independent', platform: 'x', contentHash: 'a'.repeat(64) })).toMatchObject({ admitted: true });
  expect(db.rows('sendIntent')[0]).toMatchObject({ status: 'RECONCILING', activeExecutionId: old.id });
  expect(db.rows('sendQuotaReservation')[0].state).toBe('HELD');
  expect(db.rows('sendSegment')[0].status).toBe('UNKNOWN');
});

import { assertAutonomousAccountIn } from '../send-mode-handover';
import { readPublishNowRequestedAt, withPublishNowRequestedAt } from '../send-dispatch';
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
it('hands over an untouched browser queue with its current session while preserving content and schedule', async () => {
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
    integrationId: null,
    accountSelectionMode: 'CURRENT_SESSION',
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
it.each([false, true])('keeps the account cooldown across reverse handover (already swept: %s)', async swept => {
  const { service, create, reverse, modes } = setup();
  await create();
  const execution = await service.reserveApi('org', 'root', 'worker', sendNow);
  await service.authorizeApiSegment('org', execution.id, 0, { id: '123', idNamespace: 'x.rest_id' }, sendNow);
  await service.apiOutcome('org', execution.id, 0, { eventId: 'lost', status: 'unknown' }, sendNow);
  await reverse();
  vi.setSystemTime(new Date(sendNow.getTime() + 31_000));
  if (swept) await service.recoverExpiredAccountWriters();
  const begin = (platform: string, requestId: string) => modes.beginBrowserWrite('org', 'user', {
    ...owner, requestId, platform, contentHash: 'a'.repeat(64),
  });
  await expect(begin('x', 'cooling')).rejects.toMatchObject({response:{code:'ACCOUNT_WRITE_INTERVAL',serverNow:new Date().toISOString(),nextSendNotBefore:new Date(sendNow.getTime()+90_000).toISOString(),retryAfterMs:59_000}});
  expect(await service.legacyBlockedPlatforms('org')).toContain('x');
  await expect(begin('reddit', 'unrelated')).resolves.toMatchObject({ admitted: true });
  vi.setSystemTime(new Date(sendNow.getTime() + 90_000));
  expect(await service.legacyBlockedPlatforms('org')).not.toContain('x');
  await expect(begin('x', 'ready')).resolves.toMatchObject({ admitted: true });
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
it('hands over a safe browser queue with unresolved old identity to the current session', async () => {
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
    autonomousAllowed: true,
  });
  expect(db.rows('post')[0]).toMatchObject({ executionProtocol: 'LEGACY', integrationId: null, accountSelectionMode: 'CURRENT_SESSION' });
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
it('preserves API handover account binding and original receipt idempotency', async () => {
  const { db, create, reverse, modes } = setup();
  await create();
  db.rows('post')[0].publishMethod = 'API';
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
it('keeps the old verification contract for an API handover sent through the browser', async () => {
  const { db, create, reverse, modes } = setup();
  await create();
  db.rows('post')[0].publishMethod = 'API';
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

it('uses the current browser account for a handed-over draft without an intent', async () => {
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
    accountSelectionMode: 'CURRENT_SESSION',
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
      sendTarget: method === 'API' ? { id: '123', idNamespace: namespace, handoverMode: 'AUTONOMOUS' } : { handoverMode: 'AUTONOMOUS', accountSelectionMode: 'CURRENT_SESSION' } });
    expect(db.rows('sendIntent')[0].status).toBe('HANDED_OVER');
  });
});


it('allows independent autonomous work after the controlled account cooldown while retaining reconciliation', async () => {
  const { db, service, create, reverse, modes } = setup(); await create();
  const old = await service.reserveApi('org', 'root', 'worker', sendNow);
  await service.authorizeApiSegment('org', old.id, 0, { id: '123', idNamespace: 'x.rest_id' }, sendNow);
  await service.apiOutcome('org', old.id, 0, { status: 'unknown', eventId: 'lost' }, sendNow);
  await reverse();
  vi.setSystemTime(new Date(sendNow.getTime() + 90_000));
  expect(await modes.beginBrowserWrite('org', 'user', { ...owner, requestId: 'independent', platform: 'x', contentHash: 'a'.repeat(64) })).toMatchObject({ admitted: true });
  expect(db.rows('sendIntent')[0]).toMatchObject({ status: 'RECONCILING', activeExecutionId: old.id });
  expect(db.rows('sendQuotaReservation')[0].state).toBe('HELD');
  expect(db.rows('sendSegment')[0].status).toBe('UNKNOWN');
});


describe('current browser account handover', () => {
  it('clears browser thread routing while preserving the audit intent and API account', async () => {
    const { db, create, reverse } = setup();
    await create('browser', 'EXTENSION');
    await create('api', 'API');
    db.rows('post').find(row => row.id === 'api').publishMethod = 'API';
    const original = structuredClone(db.rows('sendIntent').find(row => row.rootPostId === 'browser'));
    await reverse();
    expect(db.rows('post').find(row => row.id === 'browser')).toMatchObject({
      integrationId: null, accountSelectionMode: 'CURRENT_SESSION', executionProtocol: 'LEGACY', sendIntentId: null,
      sendTarget: { handoverMode: 'AUTONOMOUS', accountSelectionMode: 'CURRENT_SESSION' },
    });
    expect(db.rows('sendIntent').find(row => row.id === original.id)).toMatchObject({
      integrationId: original.integrationId, target: original.target, status: 'HANDED_OVER',
    });
    expect(db.rows('post').find(row => row.id === 'api').integrationId).toBe('account');
  });
  it('lazily normalizes old handovers and attributes only the receipt post to the observed current actor', async () => {
    const { db, create, reverse, modes } = setup();
    await create('root', 'EXTENSION'); await reverse();
    Object.assign(db.rows('post')[0], { integrationId: 'account', accountSelectionMode: 'EXPLICIT',
      sendTarget: { id: '123', idNamespace: 'x.rest_id', handoverMode: 'AUTONOMOUS' } });
    db.seed('integration', { id: 'actual', organizationId: 'org', providerIdentifier: 'x', internalId: '456', identityNamespace: 'x.rest_id' });
    const grant = await modes.beginBrowserWrite('org', 'user', { ...owner, requestId: 'current', platform: 'x', postId: 'root', contentHash: 'a'.repeat(64) });
    expect(grant).toMatchObject({ admitted: true, accountSelectionMode: 'CURRENT_SESSION' });
    expect(grant).not.toHaveProperty('targetAccount');
    expect(db.rows('post')[0].integrationId).toBeNull();
    const actor = { id: '456', idNamespace: 'x.rest_id', handle: 'new-name' };
    await modes.settleBrowserWrite('org', 'user', grant.id, { ...owner, status: 'CONFIRMED', platformPostId: 'remote', actor } as any);
    expect(db.rows('post')[0].integrationId).toBe('actual');
    expect(db.rows('sendMutationReceipt').find(row => row.id === grant.id).result).toMatchObject({ actor, actualIntegrationId: 'actual' });
    expect(db.rows('sendIntent')[0].integrationId).toBe('account');
    await modes.settleBrowserWrite('org', 'user', grant.id, { ...owner, status: 'CONFIRMED', platformPostId: 'remote', actor } as any);
    await expect(modes.settleBrowserWrite('org', 'user', grant.id, { ...owner, status: 'CONFIRMED', platformPostId: 'remote', actor: { ...actor, id: '789' } } as any)).rejects.toThrow('BROWSER_WRITE_OUTCOME_CONFLICT');
  });
  it('keeps unknown receipts protected and does not attribute an unrecognized actor to the original account', async () => {
    const { db, create, reverse, modes } = setup(); await create('root', 'EXTENSION'); await reverse();
    const body = { ...owner, requestId: 'unknown-current', platform: 'x', postId: 'root', contentHash: 'a'.repeat(64) };
    const grant = await modes.beginBrowserWrite('org', 'user', body);
    await modes.settleBrowserWrite('org', 'user', grant.id, { ...owner, status: 'UNKNOWN', actor: { id: 'other', idNamespace: 'x.rest_id' } } as any);
    await expect(modes.beginBrowserWrite('org', 'user', { ...body, requestId: 'retry' })).rejects.toThrow('AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
    await modes.settleBrowserWrite('org', 'user', grant.id, { ...owner, status: 'CONFIRMED' });
    expect(db.rows('post')[0].integrationId).toBeNull();
    expect(db.rows('sendMutationReceipt').find(row => row.id === grant.id).result.actualIntegrationId).toBeNull();
  });
});

it('does not create a current-session browser grant in CONTROLLED mode', async () => {
  const { db, create, modes } = setup(); await create('root', 'EXTENSION');
  await expect(modes.beginBrowserWrite('org', 'user', { ...owner, requestId: 'controlled', platform: 'x', postId: 'root', contentHash: 'a'.repeat(64) })).rejects.toThrow('SEND_MODE_AUTONOMOUS_REQUIRED');
  expect(db.rows('sendMutationReceipt').filter(row => row.operation === 'autonomous-side-effect')).toHaveLength(0);
});
it('allows a new current-session grant only after an old browser grant is proven unsubmitted', async () => {
  const { db, create, modes, reverse } = setup(); await create('root', 'EXTENSION'); await reverse();
  // Simulate a grant issued before this change under the old target contract.
  Object.assign(db.rows('post')[0], { publishMethod: 'API', integrationId: 'account', sendTarget: { id: '123', idNamespace: 'x.rest_id', handoverMode: 'AUTONOMOUS' } });
  const body = { ...owner, requestId: 'prior', platform: 'x', postId: 'root', handoverAccountVerification: true, contentHash: 'a'.repeat(64) };
  const prior = await modes.beginBrowserWrite('org', 'user', body);
  expect(prior).toHaveProperty('targetAccount');
  db.rows('post')[0].publishMethod = 'EXTENSION';
  expect(await modes.beginBrowserWrite('org', 'user', body)).toMatchObject({ admitted: false });
  await expect(modes.beginBrowserWrite('org', 'user', { ...body, requestId: 'early' })).rejects.toThrow('AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
  expect(db.rows('post')[0].integrationId).toBe('account');
  await modes.settleBrowserWrite('org', 'user', prior.id, { ...owner, status: 'NOT_SUBMITTED' });
  expect(await modes.beginBrowserWrite('org', 'user', { ...body, requestId: 'fresh' })).toMatchObject({ admitted: true, accountSelectionMode: 'CURRENT_SESSION' });
  expect(db.rows('post')[0].integrationId).toBeNull();
});

it('retains API work with unresolved original identity instead of inventing an OAuth route', async () => {
  const { db, create, reverse } = setup(); await create();
  db.rows('post')[0].publishMethod = 'API';
  Object.assign(db.rows('sendIntent')[0], { integrationId: null, canonicalAccountKey: null, target: null });
  expect(await reverse()).toMatchObject({ controlledDrain: { remainingCount: 1, issues: [{ postId: 'root', code: 'ACCOUNT_IDENTITY_UNRESOLVED' }] } });
  expect(db.rows('post')[0].executionProtocol).toBe('ACCOUNT_BOUND_V1');
});
it('hands over an unbound browser queue draft with a persisted platform', async () => {
  const { db, reverse } = setup();
  db.seed('post', { id: 'unbound', organizationId: 'org', state: 'QUEUE', parentPostId: null,
    executionProtocol: 'ACCOUNT_BOUND_V1', publishMethod: 'EXTENSION', providerIdentifier: 'x', integrationId: null, sendTarget: null });
  await reverse();
  expect(db.rows('post')[0]).toMatchObject({ executionProtocol: 'LEGACY', accountSelectionMode: 'CURRENT_SESSION', integrationId: null });
});

it('transfers an untouched thread and attributes each segment only to its own receipt actor', async () => {
  const { db, create, modes, reverse } = setup(); await create('root', 'EXTENSION');
  db.seed('post', { ...structuredClone(db.rows('post')[0]), id: 'child', parentPostId: 'root', content: 'continuation' });
  db.seed('integration', { id: 'actual-child', organizationId: 'org', providerIdentifier: 'x', internalId: '456', identityNamespace: 'x.rest_id' });
  await reverse();
  expect(db.rows('post').map(post => post.integrationId)).toEqual([null, null]);
  expect(db.rows('post').every(post => post.accountSelectionMode === 'CURRENT_SESSION')).toBe(true);
  const grant = await modes.beginBrowserWrite('org', 'user', { ...owner, requestId: 'child-write', platform: 'x', postId: 'child', contentHash: 'b'.repeat(64) });
  await modes.settleBrowserWrite('org', 'user', grant.id, { ...owner, status: 'CONFIRMED', actor: { id: '456', idNamespace: 'x.rest_id' } });
  expect(db.rows('post').find(post => post.id === 'root').integrationId).toBeNull();
  expect(db.rows('post').find(post => post.id === 'child').integrationId).toBe('actual-child');
});
it('stores autonomous actor observations without changing ordinary legacy post associations', async () => {
  const { db, modes } = setup(); db.rows('settings')[0].value = { mode: 'AUTONOMOUS', revision: 1 };
  db.seed('post', { id: 'ordinary', organizationId: 'org', state: 'QUEUE', executionProtocol: 'LEGACY',
    providerIdentifier: 'x', integrationId: 'account', publishMethod: 'EXTENSION', sendTarget: null });
  const grant = await modes.beginBrowserWrite('org', 'user', { ...owner, requestId: 'ordinary', platform: 'x', postId: 'ordinary', contentHash: 'c'.repeat(64) });
  const actor = { id: 'unknown', idNamespace: 'x.rest_id' };
  await modes.settleBrowserWrite('org', 'user', grant.id, { ...owner, status: 'CONFIRMED', actor });
  expect(db.rows('post')[0].integrationId).toBe('account');
  expect(db.rows('sendMutationReceipt').find(row => row.id === grant.id).result.actor).toEqual(actor);
});
it.each([null, {}, { id: '', idNamespace: 'x.rest_id' }, { id: '123', idNamespace: '' }, { id: '123', idNamespace: 'x.rest_id', handle: 42 }])('rejects malformed actor observations (%j)', async actor => {
  const { db, modes } = setup(); db.rows('settings')[0].value = { mode: 'AUTONOMOUS', revision: 1 };
  const grant = await modes.beginBrowserWrite('org', 'user', { ...owner, requestId: 'invalid', platform: 'x', contentHash: 'd'.repeat(64) });
  await expect(modes.settleBrowserWrite('org', 'user', grant.id, { ...owner, status: 'CONFIRMED', actor } as any)).rejects.toThrow('INVALID_BROWSER_WRITE_OUTCOME');
});

it('admits a handed-over reply by sentReplyId using the current browser actor', async () => {
  const { db, create, modes, reverse } = setup(); await create('reply-post', 'EXTENSION');
  db.rows('post')[0].source = 'engage';
  db.seed('engageSentReply', { id: 'reply', organizationId: 'org', postId: 'reply-post', opportunityId: 'opportunity' });
  db.seed('engageOpportunity', { id: 'opportunity', platform: 'x' });
  db.seed('integration', { id: 'actual-replier', organizationId: 'org', providerIdentifier: 'x', internalId: '456', identityNamespace: 'x.rest_id' });
  await reverse();
  const grant = await modes.beginBrowserWrite('org', 'user', { ...owner, requestId: 'reply-current', platform: 'x', sentReplyId: 'reply', contentHash: 'e'.repeat(64) });
  expect(grant).toMatchObject({ admitted: true, accountSelectionMode: 'CURRENT_SESSION' });
  expect(grant).not.toHaveProperty('targetAccount');
  await modes.settleBrowserWrite('org', 'user', grant.id, { ...owner, status: 'CONFIRMED', actor: { id: '456', idNamespace: 'x.rest_id' } });
  expect(db.rows('post')[0].integrationId).toBe('actual-replier');
  expect(db.rows('sendMutationReceipt').find(row => row.id === grant.id).result).toMatchObject({ action: 'COMMENT', postIds: ['reply-post'], actualIntegrationId: 'actual-replier' });
});

it('accepts delayed actor proof after operator confirmation without rewriting the conclusion', async () => {
  const { db, create, reverse, modes } = setup(); await create('root', 'EXTENSION'); await reverse();
  db.seed('integration', { id: 'actual', organizationId: 'org', providerIdentifier: 'x', internalId: '456', identityNamespace: 'x.rest_id' });
  const grant = await modes.beginBrowserWrite('org', 'user', { ...owner, requestId: 'delayed', platform: 'x', postId: 'root', contentHash: 'f'.repeat(64) });
  await modes.resolveAutonomousEffect('org', 'user', grant.id, { ...owner, requestId: 'operator', expectedRevision: 1,
    decision: 'CONFIRMED', executorStopped: true, noPendingSubmit: true, evidence: 'Verified publication with original browser stopped.' });
  await expect(modes.beginBrowserWrite('org', 'user', { ...owner, requestId: 'never-resend', platform: 'x', postId: 'root', contentHash: 'f'.repeat(64) }))
    .rejects.toThrow('AUTONOMOUS_EFFECT_CONTENT_ALREADY_ADMITTED');
  const proof = { ...owner, status: 'CONFIRMED' as const, platformPostId: 'remote', actor: { id: '456', idNamespace: 'x.rest_id' } };
  await expect(modes.settleBrowserWrite('org', 'user', grant.id, proof)).resolves.toMatchObject({ status: 'CONFIRMED' });
  await expect(modes.settleBrowserWrite('org', 'user', grant.id, proof)).resolves.toMatchObject({ status: 'CONFIRMED' });
  expect(db.rows('post')[0].integrationId).toBe('actual');
  expect(db.rows('sendMutationReceipt').find(row => row.id === grant.id).result).toMatchObject({ actor: proof.actor, actualIntegrationId: 'actual', hasResult: true, result: { postId: 'remote' } });
});
it('attributes a known original browser actor when an operator confirms its UNKNOWN receipt', async () => {
  const { db, create, reverse, modes } = setup(); await create('root', 'EXTENSION'); await reverse();
  db.seed('integration', { id: 'actual', organizationId: 'org', providerIdentifier: 'x', internalId: '456', identityNamespace: 'x.rest_id' });
  const grant = await modes.beginBrowserWrite('org', 'user', { ...owner, requestId: 'operator-unknown', platform: 'x', postId: 'root', contentHash: 'f'.repeat(64) });
  await modes.settleBrowserWrite('org', 'user', grant.id, { ...owner, status: 'UNKNOWN', actor: { id: '456', idNamespace: 'x.rest_id' } });
  await modes.resolveAutonomousEffect('org', 'user', grant.id, { ...owner, requestId: 'operator', expectedRevision: 2,
    decision: 'CONFIRMED', executorStopped: true, noPendingSubmit: true, evidence: 'Verified original publication and stopped worker.' });
  expect(db.rows('post')[0].integrationId).toBe('actual');
  expect(db.rows('sendMutationReceipt').find(row => row.id === grant.id).result.actualIntegrationId).toBe('actual');
});

it('enriches an operator-confirmed actor-only receipt once while leaving platform proof absent', async () => {
  const { db, create, reverse, modes } = setup(); await create('root', 'EXTENSION'); await reverse();
  const grant = await modes.beginBrowserWrite('org', 'user', { ...owner, requestId: 'actor-only', platform: 'x', postId: 'root', contentHash: 'f'.repeat(64) });
  await modes.resolveAutonomousEffect('org', 'user', grant.id, { ...owner, requestId: 'operator', expectedRevision: 1,
    decision: 'CONFIRMED', executorStopped: true, noPendingSubmit: true, evidence: 'Verified publication.' });
  const proof = { ...owner, status: 'CONFIRMED' as const, actor: { id: '456', idNamespace: 'x.rest_id' } };
  await modes.settleBrowserWrite('org', 'user', grant.id, proof);
  const before = structuredClone(db.rows('sendMutationReceipt').find(row => row.id === grant.id).result);
  expect(before.hasResult).not.toBe(true);
  await modes.settleBrowserWrite('org', 'user', grant.id, proof);
  expect(db.rows('sendMutationReceipt').find(row => row.id === grant.id).result).toEqual(before);
});

it('preserves each root dispatch and child absence through CONTROLLED to AUTONOMOUS to CONTROLLED', async () => {
 const {db,create,service,modes,reverse}=setup();
 await create('first','EXTENSION'); await create('second','EXTENSION');
 const firstAt=new Date(sendNow.getTime()-1), secondAt=sendNow;
 db.rows('post')[0].sendTarget=withPublishNowRequestedAt(db.rows('post')[0].sendTarget,firstAt);
 db.rows('post')[1].sendTarget=withPublishNowRequestedAt(db.rows('post')[1].sendTarget,secondAt);
 db.seed('post',{...db.rows('post')[0],id:'child',parentPostId:'first',sendTarget:{id:'123',idNamespace:'x.rest_id'}});
 await reverse();
 expect(db.rows('post').map(p=>readPublishNowRequestedAt(p.sendTarget))).toEqual([firstAt,secondAt,null]);
 await modes.save('org','user',{...owner,mode:'CONTROLLED',expectedRevision:2,requestId:'back'});
 await service.reallocateUnsentLegacy('org','user');
 expect(db.rows('post').map(p=>readPublishNowRequestedAt(p.sendTarget))).toEqual([firstAt,secondAt,null]);
 expect(db.rows('sendIntent').filter(i=>i.status==='QUEUED').every(i=>i.context?.manualPostNow===true)).toBe(true);
 expect(db.rows('sendIntent').every(i=>!i.target?.dispatch)).toBe(true);
 expect(db.rows('sendExecution')).toHaveLength(0);
});

it('settles a LinkedIn current-session handover using its case-sensitive observed mini-profile identity', async () => {
 const {db,create,reverse,modes}=setup();
 await create('root','EXTENSION');
 db.rows('post')[0].providerIdentifier='linkedin';
 db.rows('sendIntent')[0].platform='linkedin';
 await reverse();
 db.seed('integration',{id:'linkedin-actual',organizationId:'org',providerIdentifier:'linkedin',internalId:'ACoAAAMember',identityNamespace:'linkedin.fs_miniProfile'});
 const grant=await modes.beginBrowserWrite('org','user',{...owner,requestId:'linkedin-current',platform:'linkedin',postId:'root',contentHash:'a'.repeat(64)});
 const actor={id:'ACoAAAMember',idNamespace:'linkedin.fs_miniProfile',handle:'alice'};
 await modes.settleBrowserWrite('org','user',grant.id,{...owner,status:'CONFIRMED',platformPostId:'urn:li:share:123',actor});
 expect(db.rows('post')[0].integrationId).toBe('linkedin-actual');
 expect(db.rows('sendMutationReceipt').find(row=>row.id===grant.id).result).toMatchObject({actor,actualIntegrationId:'linkedin-actual'});
});

it('returns the longest matching cooldown as a retryable wait across LinkedIn platform aliases', async () => {
 const {db}=setup();
 db.rows('integration')[0].providerIdentifier='linkedin';
 db.rows('accountWriteState')[0].nextWriteNotBefore=new Date(sendNow.getTime()+20_000);
 db.seed('integration',{id:'other-linkedin',organizationId:'org',providerIdentifier:'linkedin-page'});
 db.seed('accountWriteState',{organizationId:'org',integrationId:'other-linkedin',canonicalAccountKey:'other',nextWriteNotBefore:new Date(sendNow.getTime()+45_000)});
 await expect(assertAutonomousAccountIn(db,'org',{platform:'linkedin-page'})).rejects.toMatchObject({response:{code:'ACCOUNT_WRITE_INTERVAL',serverNow:sendNow.toISOString(),nextSendNotBefore:new Date(sendNow.getTime()+45_000).toISOString(),retryAfterMs:45_000}});
 await expect(assertAutonomousAccountIn(db,'org',{platform:'x'})).resolves.toBeUndefined();
});

import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setupSend } from './support/send-fixture';
import { SendQuotaService } from '../send-quota.service';

beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const setup = setupSend();
  const post = (id: string, extra: Record<string, unknown> = {}) =>
    setup.db.seed('post', {
      id,
      organizationId: 'org',
      projectId: 'project',
      parentPostId: null,
      group: id,
      providerIdentifier: 'x',
      integrationId: 'account',
      accountSelectionMode: null,
      routeRevision: 0,
      contentRevision: 1,
      state: 'QUEUE',
      content: 'preserved text',
      settings: '{}',
      image: '[]',
      publishDate: new Date('2026-12-15T10:00:00Z'),
      releaseId: null,
      releaseURL: null,
      deletedAt: null,
      publishMethod: 'API',
      source: 'calendar',
      executionProtocol: null,
      ...extra,
    });
  return { ...setup, post };
}
it('adopts future legacy work through the existing coordinator without changing content or schedule or dispatching', async () => {
  const { db, service, post, bindings } = fixture();
  post('future');
  expect(await service.reallocateUnsentLegacy('org', 'user')).toEqual([]);
  expect(db.rows('post')[0]).toMatchObject({
    id: 'future',
    state: 'QUEUE',
    content: 'preserved text',
    publishDate: new Date('2026-12-15T10:00:00Z'),
    integrationId: 'account',
    executionProtocol: 'ACCOUNT_BOUND_V1',
    publishMethod: 'EXTENSION',
    sendOrigin: 'MANUAL',
  });
  expect(bindings.resolveForEnqueueInTransaction.mock.calls[0][5]).toBe(
    'account'
  );
  expect(db.rows('sendIntent')).toHaveLength(1);
  expect(db.rows('sendExecution')).toHaveLength(0);
  expect(db.rows('sendQuotaReservation')).toHaveLength(0);
});
it('adopts a complete unpublished thread as one intent and retains its parent links and automatic origin', async () => {
  const { db, service, post } = fixture();
  post('root', { source: 'automation', operationPlanId: 'plan' });
  post('child', { parentPostId: 'root', group: 'root', content: 'second' });
  expect(await service.reallocateUnsentLegacy('org', 'user')).toEqual([]);
  const rows = db.rows('post');
  expect(rows[0].sendIntentId).toBeTruthy();
  expect(rows[1]).toMatchObject({
    parentPostId: 'root',
    content: 'second',
    sendIntentId: rows[0].sendIntentId,
  });
  expect(db.rows('sendIntent')).toHaveLength(1);
  expect(db.rows('sendIntent')[0].sendOrigin).toBe('AUTOMATION');
});
it('isolates missing projects, invalid bindings and unsupported recurring roots, preserving them for later recovery', async () => {
  const { db, service, post, bindings } = fixture();
  post('missing-project', { projectId: null });
  post('binding', { integrationId: 'unavailable' });
  post('recurring', { intervalInDays: 2 });
  post('good');
  const route = await bindings.resolveForEnqueueInTransaction();
  bindings.resolveForEnqueueInTransaction.mockImplementation(
    async (...args: unknown[]) => {
      if (args[5] === 'unavailable')
        throw new BadRequestException('SEND_BINDING_REQUIRED');
      return route;
    }
  );
  const before = structuredClone(
    db.rows('post').filter((row) => row.id !== 'good')
  );
  const issues = await service.reallocateUnsentLegacy('org', 'user');
  expect(issues).toEqual(
    expect.arrayContaining([
      { postId: 'missing-project', code: 'SEND_PROJECT_REQUIRED' },
      { postId: 'binding', code: 'SEND_BINDING_REQUIRED' },
      { postId: 'recurring', code: 'CONTROLLED_RECURRING_OCCURRENCE_REQUIRED' },
    ])
  );
  expect(db.rows('post').filter((row) => row.id !== 'good')).toEqual(before);
  expect(
    db.rows('post').find((row) => row.id === 'good').sendIntentId
  ).toBeTruthy();
  bindings.resolveForEnqueueInTransaction.mockResolvedValue(route);
  expect(
    await service.reallocateUnsentLegacy('org', 'user')
  ).not.toContainEqual({ postId: 'binding', code: 'SEND_BINDING_REQUIRED' });
  expect(
    db.rows('post').find((row) => row.id === 'binding').sendIntentId
  ).toBeTruthy();
});
it('does not convert claims, previously published content or partial threads', async () => {
  const { db, service, post } = fixture();
  post('claim', { releaseId: 'lease', claimedAt: new Date() });
  post('known', { releaseURL: 'https://x.com/u/status/1' });
  post('partial');
  post('published-child', {
    group: 'partial',
    parentPostId: 'partial',
    state: 'PUBLISHED',
  });
  const before = structuredClone(db.rows('post'));
  const issues = await service.reallocateUnsentLegacy('org', 'user');
  expect(issues).toEqual(
    expect.arrayContaining([
      { postId: 'partial', code: 'CONTENT_NOT_ENQUEUEABLE' },
    ])
  );
  expect(db.rows('post')).toEqual(before);
  expect(db.rows('sendIntent')).toHaveLength(0);
});
it('revalidates the organization mode before the adoption transaction commits', async () => {
  const { db, service, post, projects } = fixture();
  post('root');
  projects.assertProjectActive.mockImplementation(async () => {
    db.rows('settings')[0].value = { mode: 'AUTONOMOUS', revision: 2 };
  });
  expect(await service.reallocateUnsentLegacy('org', 'user')).toEqual([
    { postId: 'root', code: 'SEND_MODE_CONTROLLED_REQUIRED' },
  ]);
  expect(db.rows('post')[0].executionProtocol).toBeNull();
  expect(db.rows('sendIntent')).toHaveLength(0);
});
it('revalidates membership inside each adoption transaction', async () => {
  const { db, service, post, projects } = fixture();
  post('root');
  projects.assertProjectActive.mockImplementation(async () => {
    db.rows('userOrganization')[0].disabled = true;
  });
  expect(await service.reallocateUnsentLegacy('org', 'user')).toEqual([
    { postId: 'root', code: 'ORGANIZATION_MEMBERSHIP_REQUIRED' },
  ]);
  expect(db.rows('sendIntent')).toHaveLength(0);
});
it('keeps concurrent and repeated reconciliation idempotent without execution grants', async () => {
  const { db, service, post } = fixture();
  post('root');
  await Promise.all([
    service.reallocateUnsentLegacy('org', 'user'),
    service.reallocateUnsentLegacy('org', 'user'),
  ]);
  expect(await service.reallocateUnsentLegacy('org', 'user')).toEqual([]);
  expect(db.rows('sendIntent')).toHaveLength(1);
  expect(db.rows('sendExecution')).toHaveLength(0);
});
it('does not let a blocked prefix starve a later valid root', async () => {
  const { db, service, post } = fixture();
  for (let index = 0; index < 105; index++)
    post(`a-${index}`, { projectId: null });
  post('z-ready');
  expect(await service.reallocateUnsentLegacy('org', 'user')).toHaveLength(105);
  expect(
    db.rows('post').find((row) => row.id === 'z-ready').sendIntentId
  ).toBeTruthy();
});
it('rechecks a lease acquired between discovery and enqueue and preserves it', async () => {
  const { db, service, post, projects } = fixture();
  post('root');
  projects.assertProjectActive.mockImplementation(async () => {
    db.rows('post')[0].releaseId = 'racing-lease';
  });
  expect(await service.reallocateUnsentLegacy('org', 'user')).toEqual([
    { postId: 'root', code: 'LEGACY_CONTENT_DRAIN_REQUIRED' },
  ]);
  expect(db.rows('post')[0].releaseId).toBe('racing-lease');
  expect(db.rows('sendIntent')).toHaveLength(0);
});
it('retains a confirmed legacy receipt instead of reenqueuing a missing business callback', async () => {
  const { db, service, post } = fixture();
  post('root');
  db.seed('sendMutationReceipt', {
    organizationId: 'org',
    operation: 'autonomous-side-effect',
    result: {
      status: 'CONFIRMED',
      revision: 1,
      action: 'POST',
      integrationId: 'account',
      postIds: ['root'],
      recurring: false,
      occurrenceKey: 'single',
    },
  });
  expect(await service.reallocateUnsentLegacy('org', 'user')).toEqual([]);
  expect(db.rows('sendIntent')).toHaveLength(0);
});
it('keeps a root with an unresolved old effect out of controlled adoption', async () => {
  const { db, service, post } = fixture();
  post('root');
  db.seed('sendMutationReceipt', {
    organizationId: 'org',
    operation: 'autonomous-side-effect',
    result: {
      status: 'UNKNOWN',
      revision: 1,
      action: 'POST',
      integrationId: 'account',
      postIds: ['root'],
      recurring: false,
      occurrenceKey: 'single',
    },
  });
  expect(await service.reallocateUnsentLegacy('org', 'user')).toEqual([]);
  expect(db.rows('sendIntent')).toHaveLength(0);
});
it('keeps a valid account-optional root queued for verified current-actor selection', async () => {
  const { db, service, post, bindings, policies } = fixture();
  post('root', { integrationId: null });
  policies.snapshotInTransaction.mockResolvedValue({
    policyRevision: 0,
    requirePreselectedAccount: false,
    preferenceRevision: 0,
    policyOwnerUserId: 'user',
  });
  bindings.resolveForEnqueueInTransaction.mockResolvedValue(null);
  expect(await service.reallocateUnsentLegacy('org', 'user')).toEqual([]);
  expect(db.rows('post')[0]).toMatchObject({
    accountSelectionMode: 'CURRENT_SESSION',
    accountResolution: 'AWAITING_CURRENT_ACTOR',
    executionProtocol: 'ACCOUNT_BOUND_V1',
    integrationId: null,
  });
});
it('reports an oversized legacy backlog without partially converting the batch', async () => {
  const { db, service, post } = fixture();
  for (let index = 0; index < 5001; index++) post(String(index));
  expect(await service.reallocateUnsentLegacy('org', 'user')).toEqual([
    { postId: expect.any(String), code: 'SEND_MODE_REALLOCATION_TOO_LARGE' },
  ]);
  expect(db.rows('sendIntent')).toHaveLength(0);
});
it('does not reschedule content that a user saved as a draft after discovery', async () => {
  const { db, service, post, projects } = fixture();
  post('root');
  projects.assertProjectActive.mockImplementation(async () => {
    db.rows('post')[0].state = 'DRAFT';
  });
  expect(await service.reallocateUnsentLegacy('org', 'user')).toEqual([
    { postId: 'root', code: 'CONTENT_NOT_ENQUEUEABLE' },
  ]);
  expect(db.rows('post')[0].state).toBe('DRAFT');
  expect(db.rows('sendIntent')).toHaveLength(0);
});
it('does not replace a binding edited after discovery with the old account snapshot', async () => {
  const { db, service, post, projects } = fixture();
  post('root');
  projects.assertProjectActive.mockImplementation(async () => {
    db.rows('post')[0].integrationId = 'new-account';
  });
  expect(await service.reallocateUnsentLegacy('org', 'user')).toEqual([
    { postId: 'root', code: 'SEND_CONTENT_CHANGED' },
  ]);
  expect(db.rows('post')[0].integrationId).toBe('new-account');
  expect(db.rows('sendIntent')).toHaveLength(0);
});

function legacyReply(status: string, extra: Record<string, unknown> = {}) {
  const setup = fixture();
  setup.post('reply-root', { source: 'engage', sendOrigin: null, ...extra });
  setup.db.seed('engageSentReply', {
    id: 'reply', organizationId: 'org', projectId: 'project', postId: 'reply-root',
    opportunityId: 'opportunity',
    opportunity: { externalPostId: 'target', externalPostUrl: 'https://x.com/u/status/target' },
  });
  setup.db.seed('engageOpportunityState', {
    id: 'state', organizationId: 'org', projectId: 'project', opportunityId: 'opportunity',
    status, matchedKeywords: [],
  });
  return setup;
}
it('preserves a legacy manually scheduled reply as manual even with automation disabled', async () => {
  const { db, service } = legacyReply('SCHEDULED');
  const before = structuredClone(db.rows('post')[0]);
  expect(await service.reallocateUnsentLegacy('org', 'user')).toEqual([]);
  const intent = db.rows('sendIntent')[0];
  expect(intent).toMatchObject({ action: 'REPLY', sendOrigin: 'MANUAL', integrationId: 'account' });
  expect(db.rows('post')[0]).toMatchObject({ content: before.content, publishDate: before.publishDate,
    integrationId: before.integrationId, sendOrigin: 'MANUAL' });
  expect(db.rows('engageOpportunityState')[0].status).toBe('SCHEDULED');
  await expect(new SendQuotaService().resolve(db, intent, db.rows('accountWriteState')[0], 0,
    new Date('2026-12-15T10:00:00Z'))).resolves.toBeDefined();
  expect(db.rows('sendExecution')).toHaveLength(0);
});
it('keeps an automatically queued legacy reply subject to automation authorization', async () => {
  const { db, service } = legacyReply('AUTO_QUEUED', { publishMethod: null, integrationId: null });
  expect(await service.reallocateUnsentLegacy('org', 'user')).toEqual([]);
  const intent = db.rows('sendIntent')[0];
  expect(intent).toMatchObject({ action: 'REPLY', sendOrigin: 'AUTOMATION' });
  await expect(new SendQuotaService().resolve(db, intent, db.rows('accountWriteState')[0], 0,
    new Date('2026-12-15T10:00:00Z'))).rejects.toThrow('AUTOMATION_DISABLED');
});
it.each(['NEW', 'REPLIED', 'DISMISSED', 'EXPIRED'])(
  'preserves an ambiguous legacy reply in state %s without inventing manual authorization', async status => {
    const { db, service } = legacyReply(status);
    const before = structuredClone(db.rows('post'));
    expect(await service.reallocateUnsentLegacy('org', 'user')).toEqual([
      { postId: 'reply-root', code: 'SEND_ORIGIN_RECONFIRMATION_REQUIRED' },
    ]);
    expect(db.rows('post')).toEqual(before);
    expect(db.rows('sendIntent')).toHaveLength(0);
  }
);
it('does not mistake an old accountless automatic row for the manually scheduled reply sharing its opportunity', async () => {
  const { db, service } = legacyReply('SCHEDULED', { publishMethod: null, integrationId: null });
  const before = structuredClone(db.rows('post'));
  expect(await service.reallocateUnsentLegacy('org', 'user')).toEqual([
    { postId: 'reply-root', code: 'SEND_ORIGIN_RECONFIRMATION_REQUIRED' },
  ]);
  expect(db.rows('post')).toEqual(before);
  expect(db.rows('sendIntent')).toHaveLength(0);
});
it('retains explicit manual origin when adopting its existing scheduled opportunity claim', async () => {
  const { db, service } = legacyReply('SCHEDULED', { sendOrigin: 'MANUAL' });
  expect(await service.reallocateUnsentLegacy('org', 'user')).toEqual([]);
  expect(db.rows('sendIntent')[0].sendOrigin).toBe('MANUAL');
  expect(db.rows('engageOpportunityState')[0].status).toBe('SCHEDULED');
});
it('does not let an ordinary new manual enqueue reuse an already scheduled opportunity', async () => {
  const { db, service } = legacyReply('SCHEDULED', { sendOrigin: 'MANUAL' });
  await expect(service.enqueue('org', 'reply-root', { userId: 'user', origin: 'MANUAL',
    explicitIntegrationId: 'account' })).rejects.toThrow('REPLY_OPPORTUNITY_NOT_ACTIONABLE');
  expect(db.rows('sendIntent')).toHaveLength(0);
});

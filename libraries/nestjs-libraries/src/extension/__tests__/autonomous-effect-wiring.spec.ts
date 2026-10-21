import { SendModeService } from '../send-mode.service';
import { memorySendDatabase } from './support/memory-send-database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostActivity } from '../../../../../apps/orchestrator/src/activities/post.activity';
import { IntegrationService } from '../../database/prisma/integrations/integration.service';

beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());

const integration = { id: 'actor', organizationId: 'org', providerIdentifier: 'x', internalId: '123', token: 'private-token' };
const posts = [{ id: 'root', content: 'body', settings: '{}', image: '[]', executionProtocol: 'LEGACY', publishDate: new Date('2026-01-01') }];
const modes = () => ({ autonomousEffect: vi.fn().mockRejectedValue(new Error('SEND_MODE_AUTONOMOUS_REQUIRED')) });

describe('durable autonomous account-write admission', () => {
  it.each([false, true])('checks thread finisher account policy without inventing saved post IDs (blocked=%s)', async blocked => {
    const network = vi.fn().mockResolvedValue([]);
    const assertLegacyAccount = blocked
      ? vi.fn().mockRejectedValue(new Error('SEND_MODE_AUTONOMOUS_REQUIRED'))
      : vi.fn().mockResolvedValue(undefined);
    const activity = Object.assign(Object.create(PostActivity.prototype), {
      _sendCoordinator: { assertLegacyAccount },
      _integrationManager: { getSocialIntegration: () => ({ comment: network }) },
    });
    const work = activity.postThreadFinisher('remote-parent', 'remote-last', integration, 'text', 'https://x.com/u/status/remote-parent');
    if (blocked) await expect(work).rejects.toThrow('SEND_MODE_AUTONOMOUS_REQUIRED');
    else await expect(work).resolves.toBeUndefined();
    expect(assertLegacyAccount).toHaveBeenCalledExactlyOnceWith('org', 'actor');
    expect(network).toHaveBeenCalledTimes(blocked ? 0 : 1);
  });
  it.each(['postSocial', 'postComment', 'postThreadFinisher'] as const)('guards %s before calling the platform', async method => {
    const effects = modes();
    const network = vi.fn().mockResolvedValue([]);
    const activity = Object.assign(Object.create(PostActivity.prototype), {
      _sendModes: effects,
      _postService: { updateTags: vi.fn(async (_org, value) => value), updateMedia: vi.fn(async () => []) },
      _integrationManager: { getSocialIntegration: () => ({ post: network, comment: network }) },
    });
    const work = method === 'postSocial' ? () => activity.postSocial(integration, posts)
      : method === 'postComment' ? () => activity.postComment('parent', undefined, integration, posts)
      : () => activity.postThreadFinisher('parent', 'last', integration, 'text', 'https://x.com/u/status/parent');
    await expect(work()).rejects.toThrow('SEND_MODE_AUTONOMOUS_REQUIRED');
    expect(network).not.toHaveBeenCalled();
    expect(effects.autonomousEffect).toHaveBeenCalledOnce();
    expect(JSON.stringify(effects.autonomousEffect.mock.calls[0].slice(0, 3))).not.toContain('private-token');
  });
  it.each(['processInternalPlug', 'processPlugs'] as const)('guards %s before calling the platform', async method => {
    const effects = modes();
    const network = vi.fn().mockResolvedValue(true);
    const service = Object.assign(Object.create(IntegrationService.prototype), {
      _sendModes: effects,
      _integrationRepository: { getIntegrationById: vi.fn(async () => integration),
        getPlug: vi.fn(async () => ({ integration, plugFunction: 'repost', data: '[]' })) },
      _integrationManager: { getSocialIntegration: () => ({ repost: network }),
        getInternalPlugs: () => ({ internalPlugs: [{ identifier: 'repost', methodName: 'repost' }] }) },
    });
    const work = method === 'processInternalPlug'
      ? () => service.processInternalPlug({ post: 'platform-post', originalIntegration: 'origin', integration: 'actor', orgId: 'org', plugName: 'repost', delay: 0, information: {} })
      : () => service.processPlugs({ plugId: 'plug', postId: 'platform-post', delay: 0, totalRuns: 1, currentRun: 1 });
    await expect(work()).rejects.toThrow('SEND_MODE_AUTONOMOUS_REQUIRED');
    expect(network).not.toHaveBeenCalled();
    expect(effects.autonomousEffect).toHaveBeenCalledOnce();
    expect(JSON.stringify(effects.autonomousEffect.mock.calls[0].slice(0, 3))).not.toContain('private-token');
  });
});

function realPlug(network: ReturnType<typeof vi.fn>) {
  const db = memorySendDatabase();
  db.seed('integration', { ...integration, disabled: false, deletedAt: null });
  db.seed('userOrganization', { organizationId: 'org', userId: 'owner', role: 'ADMIN', disabled: false });
  const effects = new SendModeService(db as any);
  const service = Object.assign(Object.create(IntegrationService.prototype), {
    _sendModes: effects,
    _integrationRepository: { getPlug: vi.fn(async () => ({ integration, plugFunction: 'repost', data: '[]' })) },
    _integrationManager: { getSocialIntegration: () => ({ repost: network }) },
  });
  const data = { plugId: 'plug', postId: 'platform-post', delay: 0, totalRuns: 1, currentRun: 1 };
  return { db, effects, service, data };
}

describe('autonomous plug retries with durable receipts', () => {
  it('calls the platform once for concurrent and repeated attempts of the same scheduled run', async () => {
    const network = vi.fn().mockResolvedValue(true);
    const { service, data } = realPlug(network);
    const results = await Promise.allSettled([service.processPlugs(data), service.processPlugs(data)]);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    expect(await service.processPlugs(data)).toBe(true);
    expect(network).toHaveBeenCalledOnce();
  });
  it('retains an uncertain platform outcome and refuses Temporal retry while allowing immediate controlled mode', async () => {
    const network = vi.fn().mockRejectedValue(new Error('response lost'));
    const { service, effects, data, db } = realPlug(network);
    await expect(service.processPlugs(data)).rejects.toThrow('AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
    await expect(service.processPlugs(data)).rejects.toThrow('AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
    expect(network).toHaveBeenCalledOnce();
    expect((await effects.stateIn(db, 'org')).blockers.autonomousEffects).toBe(1);
    expect(await effects.save('org', 'owner', { mode: 'CONTROLLED', expectedRevision: 0,
      expectedOrganizationId: 'org', expectedUserId: 'owner', requestId: 'switch' }))
      .toMatchObject({ mode: 'CONTROLLED', legacyDrain: { status: 'NEEDS_ATTENTION', waitReason: 'RECONCILIATION_REQUIRED', remainingCount: 1 } });
    await effects.reconcilePendingTransitions();
    expect((await effects.stateIn(db, 'org')).mode).toBe('CONTROLLED');
  });
});

it('does not create another publish admission when an existing root is rerouted to another integration', async () => {
  const db = memorySendDatabase();
  db.seed('integration', { ...integration, disabled: false, deletedAt: null });
  db.seed('integration', { ...integration, id: 'other-actor', disabled: false, deletedAt: null });
  db.seed('userOrganization', { organizationId: 'org', userId: 'owner', role: 'ADMIN', disabled: false });
  db.seed('post', { ...posts[0], organizationId: 'org', state: 'QUEUE' });
  const effects = new SendModeService(db as any);
  const network = vi.fn().mockResolvedValue([{ id: 'root', postId: 'platform-post', releaseURL: 'https://x.com/u/status/platform-post', status: 'posted' }]);
  const activity = Object.assign(Object.create(PostActivity.prototype), {
    _sendModes: effects,
    _postService: { updateTags: vi.fn(async (_org, value) => value), updateMedia: vi.fn(async () => []) },
    _integrationManager: { getSocialIntegration: () => ({ post: network }) },
  });
  expect(await activity.postSocial(integration, posts)).toMatchObject([{ postId: 'platform-post' }]);
  await expect(activity.postSocial({ ...integration, id: 'other-actor' }, posts))
    .rejects.toThrow('AUTONOMOUS_EFFECT_REQUEST_CONFLICT');
  expect(network).toHaveBeenCalledOnce();
});

it('publishes separate recurring occurrences without replaying either root or thread comment', async () => {
  const db = memorySendDatabase();
  db.seed('integration', { ...integration, disabled: false, deletedAt: null });
  db.seed('userOrganization', { organizationId: 'org', userId: 'owner', role: 'ADMIN', disabled: false });
  const root = { ...posts[0], organizationId: 'org', integrationId: 'actor', providerIdentifier: 'x', state: 'QUEUE',
    group: 'thread', parentPostId: null, intervalInDays: 1 };
  const child = { ...root, id: 'child', parentPostId: 'root' };
  db.seed('post', root); db.seed('post', child);
  const publish = vi.fn().mockResolvedValueOnce([{ id: 'root', postId: 'cycle-one', releaseURL: 'https://x.com/u/status/cycle-one', status: 'posted' }])
    .mockResolvedValueOnce([{ id: 'root', postId: 'cycle-two', releaseURL: 'https://x.com/u/status/cycle-two', status: 'posted' }]);
  const comment = vi.fn().mockResolvedValueOnce([{ id: 'child', postId: 'comment-one', releaseURL: 'https://x.com/u/status/comment-one', status: 'posted' }])
    .mockResolvedValueOnce([{ id: 'child', postId: 'comment-two', releaseURL: 'https://x.com/u/status/comment-two', status: 'posted' }]);
  const activity = Object.assign(Object.create(PostActivity.prototype), {
    _sendModes: new SendModeService(db as any),
    _postService: { updateTags: vi.fn(async (_org, value) => value), updateMedia: vi.fn(async () => []) },
    _integrationManager: { getSocialIntegration: () => ({ post: publish, comment }) },
  });
  await activity.postSocial(integration, [root]);
  await activity.postComment('cycle-one', undefined, integration, [child]);
  root.publishDate = new Date('2026-01-02');
  await db.post.updateMany({ where: { id: 'root' }, data: { publishDate: root.publishDate } });
  await activity.postSocial(integration, [root]);
  await activity.postComment('cycle-two', undefined, integration, [child]);
  expect(publish).toHaveBeenCalledTimes(2);
  expect(comment).toHaveBeenCalledTimes(2);
  await activity.postSocial(integration, [root]);
  await activity.postComment('cycle-two', undefined, integration, [child]);
  expect(publish).toHaveBeenCalledTimes(2);
  expect(comment).toHaveBeenCalledTimes(2);
});


describe('autonomous plugin quota attribution', () => {
  it.each([
    ['x', 'autoPlugPost', 'REPLY'],
    ['x', 'autoRepostPost', 'WRITE'],
    ['linkedin-page', 'autoPlugPost', 'REPLY'],
    ['linkedin-page', 'autoRepostPost', 'WRITE'],
    ['threads', 'autoPlugPost', 'REPLY'],
    ['bluesky', 'autoPlugPost', undefined],
    ['bluesky', 'autoRepostPost', undefined],
    ['x', 'unknownFunction', undefined],
  ])('records only a verified %s/%s quota contract', async (platform, method, kind) => {
    const account = { ...integration, providerIdentifier: platform };
    const effect = vi.fn().mockResolvedValue(true);
    const service = Object.assign(Object.create(IntegrationService.prototype), {
      _sendModes: { autonomousEffect: effect },
      _integrationRepository: { getPlug: vi.fn(async () => ({ integration: account, plugFunction: method, data: '[]' })) },
      _integrationManager: { getSocialIntegration: () => ({ [method!]: vi.fn() }) },
    });
    await service.processPlugs({ plugId: 'plug', postId: 'platform-post', delay: 0, totalRuns: 1, currentRun: 1 });
    const request = effect.mock.calls[0][2];
    expect(request.quotaWriteKind).toBe(kind);
    expect(request.quotaUnits).toBe(kind ? 1 : undefined);
  });
  it.each([
    ['linkedin', 'addComment', 'REPLY'],
    ['linkedin-page', 'repostPostUsers', 'WRITE'],
    ['x', 'repostPostUsers', undefined],
  ])('does not claim an exact write count for ambiguous %s/%s internal plugins', async (platform, method, kind) => {
    const account = { ...integration, providerIdentifier: platform };
    const effect = vi.fn().mockResolvedValue(undefined);
    const service = Object.assign(Object.create(IntegrationService.prototype), {
      _sendModes: { autonomousEffect: effect },
      _integrationRepository: { getIntegrationById: vi.fn(async () => account) },
      _integrationManager: { getSocialIntegration: () => ({ [method!]: vi.fn() }),
        getInternalPlugs: () => ({ internalPlugs: [{ identifier: 'operation', methodName: method }] }) },
    });
    await service.processInternalPlug({ post: 'platform-post', originalIntegration: 'origin', integration: 'actor',
      orgId: 'org', plugName: 'operation', delay: 0, information: {} });
    const request = effect.mock.calls[0][2];
    expect(request.quotaWriteKind).toBe(kind);
    expect(request.quotaUnits).toBe(kind ? 1 : undefined);
  });
});

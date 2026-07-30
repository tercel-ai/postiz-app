import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostsService } from '../posts.service';

// schedulePosts is the single DRAFT->QUEUE entry point. The behavioural contract
// that matters most: the resolved send path is EXCLUSIVE — an EXTENSION post is
// never handed to Temporal, and an API post always is. That exclusivity is the
// structural double-publish guard.

function makeService(posts: any[]) {
  const getSchedulablePostsByIds = vi.fn().mockResolvedValue(posts);
  const schedulePostGroupToQueue = vi.fn().mockResolvedValue({ count: 1 });
  const repo = { getSchedulablePostsByIds, schedulePostGroupToQueue } as any;

  const service = new PostsService(
    repo,
    {} as any, // integrationManager (schedulePosts uses the standalone resolver)
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  // Stub the Temporal trigger so we can assert WHICH posts reach it.
  const startWorkflow = vi
    .spyOn(service as any, 'startWorkflow')
    .mockResolvedValue(undefined);

  return { service, getSchedulablePostsByIds, schedulePostGroupToQueue, startWorkflow };
}

// getPublishMethods answers the UI's "which send paths can I pick?" for EVERY
// registered platform in one org-scoped read (the client caches it, like
// GET /engage/config), mirroring exactly what resolvePublishMethod enforces at
// commit time.
function makeServiceWithIntegrations(integrations: any[]) {
  return new PostsService(
    {} as any,
    {
      getSocialProviderList: () => [
        { identifier: 'x', name: 'X' },
        { identifier: 'hackernews', name: 'Hacker News' },
        { identifier: 'mastodon', name: 'Mastodon' },
      ],
    } as any,
    { getIntegrationsList: vi.fn().mockResolvedValue(integrations) } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
}

const byPlatform = (rows: any[], platform: string) =>
  rows.find((r) => r.platform === platform);

describe('PostsService.getPublishMethods', () => {
  it('returns an entry for every registered platform (no request filter)', async () => {
    const service = makeServiceWithIntegrations([]);

    const rows = await service.getPublishMethods('org-1');

    expect(rows.map((r) => r.platform)).toEqual(['x', 'hackernews', 'mastodon']);
  });

  it('dual-capable platform with a bound account: both methods, defaults to extension', async () => {
    const service = makeServiceWithIntegrations([
      { providerIdentifier: 'x', disabled: false, deletedAt: null },
    ]);

    expect(byPlatform(await service.getPublishMethods('org-1'), 'x')).toEqual({
      platform: 'x',
      extensionCapable: true,
      apiCapable: true,
      hasBoundIntegration: true,
      methods: ['extension', 'api'],
      defaultMethod: 'extension',
    });
  });

  it('extension-only platform: extension only, even with a bound account', async () => {
    const service = makeServiceWithIntegrations([
      { providerIdentifier: 'hackernews', disabled: false, deletedAt: null },
    ]);

    const hn = byPlatform(await service.getPublishMethods('org-1'), 'hackernews');

    expect(hn.methods).toEqual(['extension']);
    expect(hn.apiCapable).toBe(false);
    expect(hn.defaultMethod).toBe('extension');
  });

  it('API-only platform without a bound account: no methods + ACCOUNT_BINDING_REQUIRED', async () => {
    const service = makeServiceWithIntegrations([]);

    const devto = byPlatform(await service.getPublishMethods('org-1'), 'mastodon');

    expect(devto.methods).toEqual([]);
    expect(devto.defaultMethod).toBeNull();
    expect(devto.reason).toBe('ACCOUNT_BINDING_REQUIRED');
  });

  it('ignores disabled integrations when deciding api capability', async () => {
    const service = makeServiceWithIntegrations([
      { providerIdentifier: 'mastodon', disabled: true, deletedAt: null },
    ]);

    const devto = byPlatform(await service.getPublishMethods('org-1'), 'mastodon');

    expect(devto.apiCapable).toBe(false);
    expect(devto.hasBoundIntegration).toBe(false);
  });
});

const draft = (over: Partial<any>) => ({
  id: 'p1',
  group: 'g1',
  state: 'DRAFT',
  integrationId: null,
  settings: '{}',
  operationPlanId: 'plan-1',
  integration: null,
  ...over,
});

describe('PostsService.schedulePosts', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('extension post: flips to QUEUE(EXTENSION) and does NOT start Temporal', async () => {
    const { service, schedulePostGroupToQueue, startWorkflow } = makeService([
      draft({
        id: 'x1',
        group: 'gx',
        integrationId: 'int-x',
        integration: { providerIdentifier: 'x', disabled: false },
        settings: JSON.stringify({ __type: 'x' }),
      }),
    ]);

    const res = await service.schedulePosts('org-1', [{ id: 'x1' }]);

    expect(res.scheduled).toEqual([{ id: 'x1', publishMethod: 'extension' }]);
    expect(res.failed).toEqual([]);
    expect(schedulePostGroupToQueue).toHaveBeenCalledWith('org-1', 'gx', 'EXTENSION', undefined);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('api post: flips to QUEUE(API) and starts Temporal exactly once', async () => {
    const { service, schedulePostGroupToQueue, startWorkflow } = makeService([
      draft({
        id: 'd1',
        group: 'gd',
        integrationId: 'int-d',
        integration: { providerIdentifier: 'mastodon', disabled: false },
        settings: JSON.stringify({ __type: 'mastodon' }),
      }),
    ]);

    const res = await service.schedulePosts('org-1', [{ id: 'd1', publishMethod: 'api' }]);

    expect(res.scheduled).toEqual([{ id: 'd1', publishMethod: 'api' }]);
    expect(schedulePostGroupToQueue).toHaveBeenCalledWith('org-1', 'gd', 'API', undefined);
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    // startWorkflow(taskQueue, postId, orgId)
    expect(startWorkflow.mock.calls[0][1]).toBe('d1');
    expect(startWorkflow.mock.calls[0][2]).toBe('org-1');
  });

  it('api chosen but no bound account: fails that post, no flip, no Temporal', async () => {
    const { service, schedulePostGroupToQueue, startWorkflow } = makeService([
      draft({
        id: 'x2',
        group: 'gx2',
        integrationId: null, // not bound
        integration: null,
        settings: JSON.stringify({ __type: 'x' }),
      }),
    ]);

    const res = await service.schedulePosts('org-1', [{ id: 'x2', publishMethod: 'api' }]);

    expect(res.scheduled).toEqual([]);
    expect(res.failed).toEqual([
      { id: 'x2', code: 'ACCOUNT_BINDING_REQUIRED', message: expect.any(String) },
    ]);
    expect(schedulePostGroupToQueue).not.toHaveBeenCalled();
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('mixed batch: schedules the good ones and isolates the failures', async () => {
    const { service, startWorkflow } = makeService([
      draft({ id: 'a', group: 'ga', settings: JSON.stringify({ __type: 'hackernews' }) }), // ext-only -> extension
      draft({
        id: 'b',
        group: 'gb',
        integrationId: 'int-b',
        integration: { providerIdentifier: 'mastodon', disabled: false },
        settings: JSON.stringify({ __type: 'mastodon' }),
      }), // api
      // 'c' is missing from the repo result -> NOT_FOUND
    ]);

    const res = await service.schedulePosts('org-1', [
      { id: 'a' },
      { id: 'b', publishMethod: 'api' },
      { id: 'c' },
    ]);

    expect(res.scheduled).toEqual([
      { id: 'a', publishMethod: 'extension' },
      { id: 'b', publishMethod: 'api' },
    ]);
    expect(res.failed).toEqual([{ id: 'c', code: 'NOT_FOUND', message: 'Post not found' }]);
    // Only the API post reached Temporal.
    expect(startWorkflow).toHaveBeenCalledTimes(1);
  });

  it('passes a per-item date through to the queue flip (override publishDate)', async () => {
    const { service, schedulePostGroupToQueue } = makeService([
      draft({
        id: 'x1',
        group: 'gx',
        integrationId: 'int-x',
        integration: { providerIdentifier: 'x', disabled: false },
        settings: JSON.stringify({ __type: 'x' }),
      }),
    ]);

    await service.schedulePosts('org-1', [
      { id: 'x1', date: '2026-08-01T09:00:00.000Z' },
    ]);

    // schedulePostGroupToQueue(orgId, group, method, publishDate)
    const call = schedulePostGroupToQueue.mock.calls[0];
    expect(call[0]).toBe('org-1');
    expect(call[1]).toBe('gx');
    expect(call[2]).toBe('EXTENSION');
    expect(call[3]).toEqual(new Date('2026-08-01T09:00:00.000Z'));
  });

  it('omits the date arg when the item carries no date (keep materialized publishDate)', async () => {
    const { service, schedulePostGroupToQueue } = makeService([
      draft({ id: 'a', group: 'ga', settings: JSON.stringify({ __type: 'hackernews' }) }),
    ]);

    await service.schedulePosts('org-1', [{ id: 'a' }]);

    expect(schedulePostGroupToQueue.mock.calls[0][3]).toBeUndefined();
  });

  it('already-QUEUE post is an idempotent success (no re-flip, no re-trigger)', async () => {
    const { service, schedulePostGroupToQueue, startWorkflow } = makeService([
      draft({ id: 'q1', state: 'QUEUE', publishMethod: 'EXTENSION' }),
    ]);

    const res = await service.schedulePosts('org-1', [{ id: 'q1' }]);

    expect(res.scheduled).toEqual([{ id: 'q1', publishMethod: 'extension' }]);
    expect(res.failed).toEqual([]);
    expect(schedulePostGroupToQueue).not.toHaveBeenCalled();
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('reports null (not a guessed "extension") for an already-QUEUE legacy null-method post', async () => {
    const { service } = makeService([
      draft({ id: 'q2', state: 'QUEUE', publishMethod: null }),
    ]);

    const res = await service.schedulePosts('org-1', [{ id: 'q2' }]);

    expect(res.scheduled).toEqual([{ id: 'q2', publishMethod: null }]);
  });
});

// A send path stamped on the post is an explicit user choice from the editor.
// Auto-resolve prefers `extension` for every extension-capable platform, so
// without a fallback to the stored value a batch schedule would quietly undo an
// "api" pick as soon as the client no longer remembered it (e.g. after reload).
describe('PostsService.schedulePosts — persisted publishMethod', () => {
  beforeEach(() => vi.restoreAllMocks());

  const apiPickOnExtensionCapablePlatform = (over?: Partial<any>) =>
    draft({
      id: 'p-api',
      group: 'g-api',
      integrationId: 'int-x',
      integration: { providerIdentifier: 'x', disabled: false },
      settings: JSON.stringify({ __type: 'x' }),
      publishMethod: 'API',
      ...over,
    });

  it('honours the stored API choice instead of auto-resolving to extension', async () => {
    const { service, schedulePostGroupToQueue, startWorkflow } = makeService([
      apiPickOnExtensionCapablePlatform(),
    ]);

    const res = await service.schedulePosts('org-1', [{ id: 'p-api' }]);

    expect(res.scheduled).toEqual([{ id: 'p-api', publishMethod: 'api' }]);
    expect(schedulePostGroupToQueue).toHaveBeenCalledWith('org-1', 'g-api', 'API', undefined);
    expect(startWorkflow).toHaveBeenCalledTimes(1);
  });

  it('lets this request override the stored choice', async () => {
    const { service, schedulePostGroupToQueue, startWorkflow } = makeService([
      apiPickOnExtensionCapablePlatform(),
    ]);

    const res = await service.schedulePosts('org-1', [
      { id: 'p-api', publishMethod: 'extension' },
    ]);

    expect(res.scheduled).toEqual([{ id: 'p-api', publishMethod: 'extension' }]);
    expect(schedulePostGroupToQueue).toHaveBeenCalledWith('org-1', 'g-api', 'EXTENSION', undefined);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('still rejects a stored API choice once the account is gone', async () => {
    const { service, schedulePostGroupToQueue } = makeService([
      apiPickOnExtensionCapablePlatform({ integrationId: null, integration: null }),
    ]);

    const res = await service.schedulePosts('org-1', [{ id: 'p-api' }]);

    expect(res.scheduled).toEqual([]);
    expect(res.failed).toEqual([
      { id: 'p-api', code: 'ACCOUNT_BINDING_REQUIRED', message: expect.any(String) },
    ]);
    expect(schedulePostGroupToQueue).not.toHaveBeenCalled();
  });

  it('auto-resolves when nothing is stored and nothing is requested', async () => {
    const { service, schedulePostGroupToQueue } = makeService([
      apiPickOnExtensionCapablePlatform({ publishMethod: null }),
    ]);

    const res = await service.schedulePosts('org-1', [{ id: 'p-api' }]);

    expect(res.scheduled).toEqual([{ id: 'p-api', publishMethod: 'extension' }]);
    expect(schedulePostGroupToQueue).toHaveBeenCalledWith('org-1', 'g-api', 'EXTENSION', undefined);
  });

  it('reports the persisted method for an already-scheduled post', async () => {
    const { service, schedulePostGroupToQueue } = makeService([
      apiPickOnExtensionCapablePlatform({ state: 'QUEUE' }),
    ]);

    const res = await service.schedulePosts('org-1', [{ id: 'p-api' }]);

    // Idempotent: reported, not re-flipped.
    expect(res.scheduled).toEqual([{ id: 'p-api', publishMethod: 'api' }]);
    expect(schedulePostGroupToQueue).not.toHaveBeenCalled();
  });
});

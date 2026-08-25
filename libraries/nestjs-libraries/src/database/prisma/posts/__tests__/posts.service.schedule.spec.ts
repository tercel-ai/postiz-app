import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostsService } from '../posts.service';

// schedulePosts is the single DRAFT->QUEUE entry point. The behavioural contract
// that matters most: the resolved send path is EXCLUSIVE — an EXTENSION post is
// never handed to Temporal, and an API post always is. That exclusivity is the
// structural double-publish guard.

function makeService(posts: any[], planRoots?: any[]) {
  // The plan-scoped entry point expands planId -> ids and then delegates to the
  // SAME id-based path, so both mocks feed one service: `planRoots` is what the
  // plan query returns, `posts` what the id query resolves them to.
  const getSchedulablePostsByIds = vi
    .fn()
    .mockImplementation((_org: string, ids: string[]) =>
      Promise.resolve(posts.filter((p) => ids.includes(p.id)))
    );
  const getSchedulablePostRootsByPlan = vi.fn().mockResolvedValue(planRoots ?? []);
  // The null-plan branch reads the project's live plan posts instead. Same
  // rows, different scope, so the harness feeds it the same fixture.
  const getPlanPostRootsForProject = vi.fn().mockResolvedValue(planRoots ?? []);
  const schedulePostGroupToQueue = vi.fn().mockResolvedValue({ count: 1 });
  const repo = {
    getSchedulablePostsByIds,
    getSchedulablePostRootsByPlan,
    getPlanPostRootsForProject,
    schedulePostGroupToQueue,
  } as any;

  // No configured window on any platform, by default — the pre-existing
  // behaviour (materialized publishDate always kept as-is).
  const getPublishTimeWindows = vi.fn().mockResolvedValue({});
  const extensionPublishConfigService = { getPublishTimeWindows } as any;

  // Only the project-scoped branch of schedulePlanPosts reaches this; the
  // org-scoped calls below never pass a projectId, so it stays untouched and
  // the pre-existing behaviour is exercised exactly as before.
  const assertPlanBelongsToProject = vi.fn().mockResolvedValue(undefined);
  const resolveProjectPublishing = vi.fn().mockResolvedValue({
    automationEnabled: true,
    publishingEnabled: true,
    publishingConfigured: false,
    enabledPlatforms: null,
    windows: {},
  });
  const projectPublishingService = {
    assertPlanBelongsToProject,
    resolve: resolveProjectPublishing,
  } as any;

  const service = new PostsService(
    repo,
    {} as any, // integrationManager (schedulePosts uses the standalone resolver)
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    extensionPublishConfigService,
    undefined, // projectValidation
    projectPublishingService
  );
  // Stub the Temporal trigger so we can assert WHICH posts reach it.
  const startWorkflow = vi
    .spyOn(service as any, 'startWorkflow')
    .mockResolvedValue(undefined);

  return {
    service,
    getSchedulablePostsByIds,
    getSchedulablePostRootsByPlan,
    getPlanPostRootsForProject,
    schedulePostGroupToQueue,
    startWorkflow,
    getPublishTimeWindows,
    assertPlanBelongsToProject,
    resolveProjectPublishing,
  };
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
  providerIdentifier: null,
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

  it('uses settings.__type to queue an accountless draft for extension publishing', async () => {
    const { service, schedulePostGroupToQueue, startWorkflow } = makeService([
      draft({
        id: 'x-accountless',
        group: 'gx-accountless',
        integrationId: null,
        integration: null,
        providerIdentifier: null,
        settings: JSON.stringify({ __type: 'x' }),
      }),
    ]);

    const res = await service.schedulePosts('org-1', [{ id: 'x-accountless' }]);

    expect(res.scheduled).toEqual([
      { id: 'x-accountless', publishMethod: 'extension' },
    ]);
    expect(res.failed).toEqual([]);
    expect(schedulePostGroupToQueue).toHaveBeenCalledWith(
      'org-1',
      'gx-accountless',
      'EXTENSION',
      undefined
    );
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
      draft({
        id: 'a',
        group: 'ga',
        providerIdentifier: 'hackernews',
        settings: JSON.stringify({ __type: 'hackernews' }),
      }), // ext-only -> extension
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
      draft({
        id: 'a',
        group: 'ga',
        providerIdentifier: 'hackernews',
        settings: JSON.stringify({ __type: 'hackernews' }),
      }),
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

// Plan-scoped commit: the "activate this plan" action, reached only through
// /projects/:projectId/automation. What matters is that it reduces to the
// id-based path (same send-path resolution, same double-publish guard) while
// only ever touching the plan's still-DRAFT roots.
//
// `projectId` is a REQUIRED parameter, so every call here passes one — there is
// no org-scoped plan commit left to test.
describe('PostsService.schedulePlanPosts', () => {
  beforeEach(() => vi.restoreAllMocks());

  const xDraft = (over: Partial<any>) =>
    draft({
      integrationId: 'int-x',
      integration: { providerIdentifier: 'x', disabled: false },
      settings: JSON.stringify({ __type: 'x' }),
      ...over,
    });

  it('commits every DRAFT root of the plan and leaves the rest alone', async () => {
    const { service, getSchedulablePostsByIds, schedulePostGroupToQueue } = makeService(
      [xDraft({ id: 'p1', group: 'g1' }), xDraft({ id: 'p2', group: 'g2' })],
      [
        { id: 'p1', state: 'DRAFT' },
        { id: 'p2', state: 'DRAFT' },
        { id: 'p3', state: 'PUBLISHED' },
      ]
    );

    const res = await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    // Only the drafts are handed down — a PUBLISHED root is never re-committed.
    expect(getSchedulablePostsByIds).toHaveBeenCalledWith('org-1', ['p1', 'p2']);
    expect(res.scheduled).toEqual([
      { id: 'p1', publishMethod: 'extension' },
      { id: 'p2', publishMethod: 'extension' },
    ]);
    expect(res.failed).toEqual([]);
    expect(res.total).toBe(3);
    expect(res.alreadyScheduled).toBe(1);
    expect(schedulePostGroupToQueue).toHaveBeenCalledTimes(2);
  });

  it('commits the PROJECT\'s live plan posts when handed a null plan id', async () => {
    const {
      service,
      getPlanPostRootsForProject,
      getSchedulablePostRootsByPlan,
      assertPlanBelongsToProject,
      getSchedulablePostsByIds,
    } = makeService(
      [xDraft({ id: 'p1', group: 'g1' })],
      [
        { id: 'p1', state: 'DRAFT' },
        { id: 'p2', state: 'QUEUE' },
      ]
    );

    const res = await service.schedulePlanPosts('org-1', null, 'proj-1');

    // The plan query is bypassed entirely: there is no plan to scope to. The
    // project query is scoped to `operationPlanId: { not: null }` and
    // `deletedAt: null`, so a hand-authored draft is never swept in and a
    // superseded plan's soft-deleted drafts are never resurrected.
    expect(getSchedulablePostRootsByPlan).not.toHaveBeenCalled();
    expect(getPlanPostRootsForProject).toHaveBeenCalledWith('org-1', 'proj-1', [
      'DRAFT',
      'QUEUE',
    ]);
    // Nothing to authorize — there is no plan id. The caller was already
    // authorized for the PROJECT, which is what the query is scoped to.
    expect(assertPlanBelongsToProject).not.toHaveBeenCalled();
    expect(getSchedulablePostsByIds).toHaveBeenCalledWith('org-1', ['p1']);
    expect(res.scheduled).toEqual([{ id: 'p1', publishMethod: 'extension' }]);
    expect(res.total).toBe(2);
    expect(res.alreadyScheduled).toBe(1);
  });

  it('still gates the null-plan branch on the publishing switch chain', async () => {
    const { service, getPlanPostRootsForProject, resolveProjectPublishing } =
      makeService([xDraft({ id: 'p1', group: 'g1' })], [{ id: 'p1', state: 'DRAFT' }]);
    resolveProjectPublishing.mockResolvedValue({
      automationEnabled: true,
      publishingEnabled: false,
      publishingConfigured: true,
      enabledPlatforms: ['x'],
      windows: {},
    });

    const res = await service.schedulePlanPosts('org-1', null, 'proj-1');

    // Widening the scope must not widen what the switches allow — a project
    // with publishing off queues nothing on either branch.
    expect(getPlanPostRootsForProject).not.toHaveBeenCalled();
    expect(res).toEqual({ scheduled: [], failed: [], total: 0, alreadyScheduled: 0 });
  });

  it('already-committed plan: no-op success that is distinguishable from an unknown plan', async () => {
    const { service, schedulePostGroupToQueue } = makeService(
      [],
      [{ id: 'p1', state: 'QUEUE' }]
    );

    const res = await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    expect(res.scheduled).toEqual([]);
    expect(res.failed).toEqual([]);
    // total > 0 is what separates "already done" from "nothing there".
    expect(res.total).toBe(1);
    expect(res.alreadyScheduled).toBe(1);
    expect(schedulePostGroupToQueue).not.toHaveBeenCalled();
  });

  it('unknown plan (or another org\'s): empty no-op, never an error', async () => {
    const { service, getSchedulablePostsByIds, schedulePostGroupToQueue } = makeService(
      [],
      []
    );

    const res = await service.schedulePlanPosts('org-1', 'nope', 'proj-1');

    expect(res).toEqual({ scheduled: [], failed: [], total: 0, alreadyScheduled: 0 });
    // Delegates with an empty id list; the repository short-circuits it, so no
    // empty IN () ever reaches the DB.
    expect(getSchedulablePostsByIds).toHaveBeenCalledWith('org-1', []);
    expect(schedulePostGroupToQueue).not.toHaveBeenCalled();
  });

  it('applies the body-level publishMethod to every post in the plan', async () => {
    const { service, schedulePostGroupToQueue, startWorkflow } = makeService(
      [xDraft({ id: 'p1', group: 'g1' }), xDraft({ id: 'p2', group: 'g2' })],
      [
        { id: 'p1', state: 'DRAFT' },
        { id: 'p2', state: 'DRAFT' },
      ]
    );

    const res = await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1', 'api');

    expect(res.scheduled).toEqual([
      { id: 'p1', publishMethod: 'api' },
      { id: 'p2', publishMethod: 'api' },
    ]);
    expect(schedulePostGroupToQueue).toHaveBeenCalledWith('org-1', 'g1', 'API', undefined);
    // API posts must still each reach Temporal — the plan path changes WHICH
    // posts are committed, never HOW one is committed.
    expect(startWorkflow).toHaveBeenCalledTimes(2);
  });

  it('one unschedulable post never blocks the rest of the plan', async () => {
    const { service, schedulePostGroupToQueue } = makeService(
      [
        xDraft({ id: 'ok', group: 'g-ok' }),
        // api-only platform with no bound account -> fails on its own
        draft({
          id: 'bad',
          group: 'g-bad',
          integrationId: null,
          integration: null,
          settings: JSON.stringify({ __type: 'mastodon' }),
          providerIdentifier: 'mastodon',
        }),
      ],
      [
        { id: 'ok', state: 'DRAFT' },
        { id: 'bad', state: 'DRAFT' },
      ]
    );

    const res = await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    expect(res.scheduled).toEqual([{ id: 'ok', publishMethod: 'extension' }]);
    expect(res.failed).toEqual([
      { id: 'bad', code: 'ACCOUNT_BINDING_REQUIRED', message: expect.any(String) },
    ]);
    expect(res.total).toBe(2);
    expect(schedulePostGroupToQueue).toHaveBeenCalledTimes(1);
  });
});

// `platforms` (Automation page's per-platform picker on "Confirm & schedule")
// narrows a plan-scoped commit to specific providerIdentifiers. What matters:
// every response number is scoped to the FILTERED set, not the whole plan —
// a caller that filtered to `['x']` must never see counts for reddit/linkedin
// posts it never asked to touch.
describe('PostsService.schedulePlanPosts — platform filter', () => {
  beforeEach(() => vi.restoreAllMocks());

  const xDraft = (over: Partial<any>) =>
    draft({
      integrationId: 'int-x',
      integration: { providerIdentifier: 'x', disabled: false },
      settings: JSON.stringify({ __type: 'x' }),
      ...over,
    });

  it('commits only the roots on the requested platforms', async () => {
    const { service, getSchedulablePostsByIds, schedulePostGroupToQueue } = makeService(
      [xDraft({ id: 'x1', group: 'gx' })],
      [
        { id: 'x1', state: 'DRAFT', providerIdentifier: 'x' },
        { id: 'r1', state: 'DRAFT', providerIdentifier: 'reddit' },
        { id: 'l1', state: 'DRAFT', providerIdentifier: 'linkedin' },
      ]
    );

    const res = await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1', undefined, ['x']);

    // Only the 'x' root is ever handed to the id-based path — reddit/linkedin
    // are excluded before schedulePosts is even called, not filtered after.
    expect(getSchedulablePostsByIds).toHaveBeenCalledWith('org-1', ['x1']);
    expect(res.scheduled).toEqual([{ id: 'x1', publishMethod: 'extension' }]);
    // Scoped to the filter: 1 (the 'x' root), not 3 (the whole plan).
    expect(res.total).toBe(1);
    expect(res.alreadyScheduled).toBe(0);
    expect(schedulePostGroupToQueue).toHaveBeenCalledTimes(1);
  });

  it('matches providerIdentifier case-insensitively', async () => {
    const { service, getSchedulablePostsByIds } = makeService(
      [xDraft({ id: 'x1', group: 'gx' })],
      [{ id: 'x1', state: 'DRAFT', providerIdentifier: 'X' }]
    );

    await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1', undefined, ['x']);

    expect(getSchedulablePostsByIds).toHaveBeenCalledWith('org-1', ['x1']);
  });

  it('an empty match is a no-op success, not an error', async () => {
    const { service, getSchedulablePostsByIds, schedulePostGroupToQueue } = makeService(
      [],
      [{ id: 'r1', state: 'DRAFT', providerIdentifier: 'reddit' }]
    );

    const res = await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1', undefined, ['linkedin']);

    expect(res).toEqual({ scheduled: [], failed: [], total: 0, alreadyScheduled: 0 });
    expect(getSchedulablePostsByIds).toHaveBeenCalledWith('org-1', []);
    expect(schedulePostGroupToQueue).not.toHaveBeenCalled();
  });

  it('an empty or absent platforms list activates every platform (unchanged behaviour)', async () => {
    const { service, getSchedulablePostsByIds } = makeService(
      [xDraft({ id: 'x1', group: 'gx' })],
      [
        { id: 'x1', state: 'DRAFT', providerIdentifier: 'x' },
        { id: 'r1', state: 'DRAFT', providerIdentifier: 'reddit' },
      ]
    );

    await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1', undefined, []);

    expect(getSchedulablePostsByIds).toHaveBeenCalledWith('org-1', ['x1', 'r1']);
  });
});

// A configured per-platform publish time window (extension_publish.time_window)
// re-picks an out-of-window materialized time at ACTIVATION, not generation —
// the window may have been configured/edited after the plan was generated.
// Re-picks (never clamps): the plan's time is just a default, so an out-of-
// window post should land at a random point inside the window, not its edge.
describe('PostsService.schedulePlanPosts — publish time window', () => {
  beforeEach(() => vi.restoreAllMocks());

  // These fixtures are dated 2026-08-01, and the commit pass refuses to move a
  // post BACKWARDS across the clock (a QUEUE post dated in the past publishes on
  // the spot). Freeze "now" before the fixtures so the window they are re-picked
  // into is still ahead of it — which is the real-world case being described.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  const xDraft = (over: Partial<any>) =>
    draft({
      integrationId: 'int-x',
      integration: { providerIdentifier: 'x', disabled: false },
      settings: JSON.stringify({ __type: 'x' }),
      ...over,
    });

  it('leaves publishDate untouched when the platform has no configured window', async () => {
    const { service, schedulePostGroupToQueue } = makeService(
      [xDraft({ id: 'x1', group: 'gx' })],
      [
        {
          id: 'x1',
          group: 'gx',
          state: 'DRAFT',
          providerIdentifier: 'x',
          publishDate: new Date('2026-08-01T03:00:00.000Z'),
        },
      ]
    );

    await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    expect(schedulePostGroupToQueue).toHaveBeenCalledWith(
      'org-1',
      'gx',
      'EXTENSION',
      undefined
    );
  });

  it('leaves publishDate untouched when it already falls inside the window', async () => {
    const { service, schedulePostGroupToQueue, resolveProjectPublishing } = makeService(
      [xDraft({ id: 'x1', group: 'gx' })],
      [
        {
          id: 'x1',
          group: 'gx',
          state: 'DRAFT',
          providerIdentifier: 'x',
          publishDate: new Date('2026-08-01T12:00:00.000Z'), // inside 09:00-17:00
        },
      ]
    );
    resolveProjectPublishing.mockResolvedValue({
      automationEnabled: true,
      publishingEnabled: true,
      publishingConfigured: true,
      enabledPlatforms: null,
      windows: {
        x: { windowStart: '09:00', windowEnd: '17:00' },
      },
    });

    await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    expect(schedulePostGroupToQueue).toHaveBeenCalledWith(
      'org-1',
      'gx',
      'EXTENSION',
      undefined
    );
  });

  it('re-picks a random time inside the window when the materialized time falls outside it', async () => {
    const { service, schedulePostGroupToQueue, resolveProjectPublishing } = makeService(
      [xDraft({ id: 'x1', group: 'gx' })],
      [
        {
          id: 'x1',
          group: 'gx',
          state: 'DRAFT',
          providerIdentifier: 'x',
          publishDate: new Date('2026-08-01T03:00:00.000Z'), // outside 09:00-17:00
        },
      ]
    );
    resolveProjectPublishing.mockResolvedValue({
      automationEnabled: true,
      publishingEnabled: true,
      publishingConfigured: true,
      enabledPlatforms: null,
      windows: {
        x: { windowStart: '09:00', windowEnd: '17:00' },
      },
    });
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // midpoint of the 8h span

    await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    expect(schedulePostGroupToQueue).toHaveBeenCalledWith(
      'org-1',
      'gx',
      'EXTENSION',
      new Date('2026-08-01T13:00:00.000Z')
    );
  });

  it('refuses to move a post BACKWARDS into a window that has already closed', async () => {
    // 19:00 now, the post is scheduled for 22:00 tonight, and the window closed
    // at 17:00. Re-picking would land this morning — and a QUEUE post dated in
    // the past publishes on the spot, which is the opposite of what a window is
    // for. Out-of-window is bad; published-right-now is worse.
    vi.setSystemTime(new Date('2026-08-01T19:00:00.000Z'));
    const { service, schedulePostGroupToQueue, resolveProjectPublishing } = makeService(
      [xDraft({ id: 'x1', group: 'gx' })],
      [
        {
          id: 'x1',
          group: 'gx',
          state: 'DRAFT',
          providerIdentifier: 'x',
          publishDate: new Date('2026-08-01T22:00:00.000Z'),
        },
      ]
    );
    resolveProjectPublishing.mockResolvedValue({
      automationEnabled: true,
      publishingEnabled: true,
      publishingConfigured: true,
      enabledPlatforms: null,
      windows: { x: { windowStart: '09:00', windowEnd: '17:00' } },
    });

    await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    // No date override — the post keeps its own 22:00.
    expect(schedulePostGroupToQueue).toHaveBeenCalledWith(
      'org-1',
      'gx',
      'EXTENSION',
      undefined
    );
  });

  it('honours the window timezone, not UTC clock time', async () => {
    const { service, schedulePostGroupToQueue, resolveProjectPublishing } = makeService(
      [xDraft({ id: 'x1', group: 'gx' })],
      [
        {
          id: 'x1',
          group: 'gx',
          state: 'DRAFT',
          // 2026-08-01T03:00Z is 12:00 in Asia/Tokyo (UTC+9) — inside 09:00-17:00
          // local, even though it is well outside that range in UTC.
          providerIdentifier: 'x',
          publishDate: new Date('2026-08-01T03:00:00.000Z'),
        },
      ]
    );
    resolveProjectPublishing.mockResolvedValue({
      automationEnabled: true,
      publishingEnabled: true,
      publishingConfigured: true,
      enabledPlatforms: null,
      windows: {
        x: { windowStart: '09:00', windowEnd: '17:00', timezone: 'Asia/Tokyo' },
      },
    });

    await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    expect(schedulePostGroupToQueue).toHaveBeenCalledWith(
      'org-1',
      'gx',
      'EXTENSION',
      undefined
    );
  });

  it('re-picks into the following local day for a window that wraps past midnight', async () => {
    const { service, schedulePostGroupToQueue, resolveProjectPublishing } = makeService(
      [xDraft({ id: 'x1', group: 'gx' })],
      [
        {
          id: 'x1',
          group: 'gx',
          state: 'DRAFT',
          providerIdentifier: 'x',
          publishDate: new Date('2026-08-01T10:00:00.000Z'), // outside 22:00-02:00
        },
      ]
    );
    resolveProjectPublishing.mockResolvedValue({
      automationEnabled: true,
      publishingEnabled: true,
      publishingConfigured: true,
      enabledPlatforms: null,
      windows: {
        x: { windowStart: '22:00', windowEnd: '02:00' },
      },
    });
    // span = 240min; floor(0.999 * 240) = 239 -> 22:00 + 239min = next-day 01:59
    vi.spyOn(Math, 'random').mockReturnValue(0.999);

    await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    expect(schedulePostGroupToQueue).toHaveBeenCalledWith(
      'org-1',
      'gx',
      'EXTENSION',
      new Date('2026-08-02T01:59:00.000Z')
    );
  });

  it('matches the window platform key case-insensitively', async () => {
    const { service, schedulePostGroupToQueue, resolveProjectPublishing } = makeService(
      [xDraft({ id: 'x1', group: 'gx' })],
      [
        {
          id: 'x1',
          group: 'gx',
          state: 'DRAFT',
          providerIdentifier: 'X', // stored uppercase
          publishDate: new Date('2026-08-01T03:00:00.000Z'),
        },
      ]
    );
    resolveProjectPublishing.mockResolvedValue({
      automationEnabled: true,
      publishingEnabled: true,
      publishingConfigured: true,
      enabledPlatforms: null,
      windows: {
        x: { windowStart: '09:00', windowEnd: '17:00' },
      },
    });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    expect(schedulePostGroupToQueue).toHaveBeenCalledWith(
      'org-1',
      'gx',
      'EXTENSION',
      new Date('2026-08-01T13:00:00.000Z')
    );
  });

  it('never reads the admin publish-window setting directly', async () => {
    // Windows reach this path ONLY through ProjectPublishingService.resolve(),
    // which has already layered the project's own window over the admin tiers.
    // Reading the admin setting here again would silently discard that layering.
    const { service, getPublishTimeWindows, resolveProjectPublishing } = makeService(
      [xDraft({ id: 'x1', group: 'gx' })],
      [
        {
          id: 'x1',
          group: 'gx',
          state: 'DRAFT',
          providerIdentifier: 'x',
          publishDate: new Date('2026-08-01T03:00:00.000Z'),
        },
      ]
    );

    await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    expect(resolveProjectPublishing).toHaveBeenCalled();
    expect(getPublishTimeWindows).not.toHaveBeenCalled();
  });
});

// The project-scoped branch — what a request coming through
// /projects/:projectId/automation (or POST /posts/schedule with a projectId)
// gets on top of the org-scoped behaviour above: an ownership assertion on the
// plan, and the PROJECT's own publishing settings applied.
describe('PostsService.schedulePlanPosts — project scoping', () => {
  beforeEach(() => vi.restoreAllMocks());

  // These fixtures are dated 2026-08-01, and the commit pass refuses to move a
  // post BACKWARDS across the clock (a QUEUE post dated in the past publishes on
  // the spot). Freeze "now" before the fixtures so the window they are re-picked
  // into is still ahead of it — which is the real-world case being described.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  const xDraft = (over: Partial<any>) =>
    draft({
      integrationId: 'int-x',
      integration: { providerIdentifier: 'x', disabled: false },
      settings: JSON.stringify({ __type: 'x' }),
      ...over,
    });

  const planRoot = (id: string, platform: string, group: string) => ({
    id,
    group,
    state: 'DRAFT',
    providerIdentifier: platform,
    publishDate: new Date('2026-08-01T12:00:00.000Z'),
  });

  it('asserts the plan belongs to the project BEFORE reading any of its posts', async () => {
    const {
      service,
      assertPlanBelongsToProject,
      getSchedulablePostRootsByPlan,
    } = makeService([], []);
    assertPlanBelongsToProject.mockRejectedValue(
      new Error('Operation plan not found')
    );

    await expect(
      service.schedulePlanPosts('org-1', 'plan-of-other-project', 'proj-1')
    ).rejects.toThrow('Operation plan not found');

    // The point of ordering it first: a plan from a sibling project must not
    // even leak how many posts it has.
    expect(getSchedulablePostRootsByPlan).not.toHaveBeenCalled();
  });

  it('always asserts ownership and always applies the project settings', async () => {
    const {
      service,
      assertPlanBelongsToProject,
      resolveProjectPublishing,
      getPublishTimeWindows,
    } = makeService([xDraft({ id: 'x1', group: 'gx' })], [planRoot('x1', 'x', 'gx')]);

    await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    expect(assertPlanBelongsToProject).toHaveBeenCalledWith(
      'org-1',
      'proj-1',
      'plan-1'
    );
    expect(resolveProjectPublishing).toHaveBeenCalledWith('org-1', 'proj-1');
    // The admin windows are read INSIDE resolve(), which layers the project's
    // own window over them — the schedule path must not read them a second time
    // and overwrite that result.
    expect(getPublishTimeWindows).not.toHaveBeenCalled();
  });

  it('refuses to commit a plan at all when the ownership dependency is missing', async () => {
    // A positional construction that omits ProjectPublishingService must fail
    // loudly rather than silently skip the assertion — that skip is exactly the
    // hole this path exists to close.
    const service = new PostsService(
      { getSchedulablePostRootsByPlan: vi.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { getPublishTimeWindows: vi.fn() } as any
    );

    await expect(
      service.schedulePlanPosts('org-1', 'plan-1', 'proj-1')
    ).rejects.toThrow('ProjectPublishingService is required');
  });

  it("falls back to the project's enabled platforms when the caller names none", async () => {
    const { service, getSchedulablePostsByIds, resolveProjectPublishing } =
      makeService(
        [xDraft({ id: 'x1', group: 'gx' }), xDraft({ id: 'r1', group: 'gr' })],
        [planRoot('x1', 'x', 'gx'), planRoot('r1', 'reddit', 'gr')]
      );
    resolveProjectPublishing.mockResolvedValue({
      automationEnabled: true,
      publishingEnabled: true,
      publishingConfigured: true,
      enabledPlatforms: ['x'],
      windows: {},
    });

    const res = await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    // Reddit is off for this project, so its root is never committed — and the
    // counts report only the platform the caller's project actually publishes.
    expect(getSchedulablePostsByIds).toHaveBeenCalledWith('org-1', ['x1']);
    expect(res.total).toBe(1);
  });

  it('queues nothing when every platform is explicitly turned off', async () => {
    const { service, getSchedulablePostsByIds, schedulePostGroupToQueue, resolveProjectPublishing } =
      makeService([xDraft({ id: 'x1', group: 'gx' })], [planRoot('x1', 'x', 'gx')]);
    // The Automation master switch: an EMPTY enabled list, not a null one.
    resolveProjectPublishing.mockResolvedValue({
      automationEnabled: true,
      publishingEnabled: true,
      publishingConfigured: true,
      enabledPlatforms: [],
      windows: {},
    });

    const res = await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    expect(schedulePostGroupToQueue).not.toHaveBeenCalled();
    // Reaches the id-based path with an EMPTY batch rather than being skipped,
    // which is the same no-op an already-committed plan produces.
    expect(getSchedulablePostsByIds).toHaveBeenCalledWith('org-1', []);
    expect(res.total).toBe(0);
  });

  it('leaves the platform set unconstrained when the project never configured publishing', async () => {
    const { service, getSchedulablePostsByIds, resolveProjectPublishing } =
      makeService(
        [xDraft({ id: 'x1', group: 'gx' }), xDraft({ id: 'r1', group: 'gr' })],
        [planRoot('x1', 'x', 'gx'), planRoot('r1', 'reddit', 'gr')]
      );
    // null = "never expressed a preference", which must NOT read as "all off".
    resolveProjectPublishing.mockResolvedValue({
      automationEnabled: true,
      publishingEnabled: true,
      publishingConfigured: true,
      enabledPlatforms: null,
      windows: {},
    });

    await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    expect(getSchedulablePostsByIds).toHaveBeenCalledWith('org-1', ['x1', 'r1']);
  });

  it('lets an explicit platforms argument win over the project setting', async () => {
    const { service, getSchedulablePostsByIds, resolveProjectPublishing } =
      makeService(
        [xDraft({ id: 'x1', group: 'gx' }), xDraft({ id: 'r1', group: 'gr' })],
        [planRoot('x1', 'x', 'gx'), planRoot('r1', 'reddit', 'gr')]
      );
    resolveProjectPublishing.mockResolvedValue({
      automationEnabled: true,
      publishingEnabled: true,
      publishingConfigured: true,
      enabledPlatforms: ['x', 'reddit'],
      windows: {},
    });

    await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1', undefined, ['reddit']);

    expect(getSchedulablePostsByIds).toHaveBeenCalledWith('org-1', ['r1']);
  });

  it("re-picks the publish time inside the PROJECT's window, not the admin one", async () => {
    const {
      service,
      schedulePostGroupToQueue,
      resolveProjectPublishing,
      getPublishTimeWindows,
    } = makeService(
      [xDraft({ id: 'x1', group: 'gx' })],
      [
        {
          id: 'x1',
          group: 'gx',
          state: 'DRAFT',
          providerIdentifier: 'x',
          publishDate: new Date('2026-08-01T03:00:00.000Z'), // outside 09:00-17:00
        },
      ]
    );
    // resolve() already layered the project window over the admin tiers, so the
    // schedule path must use ITS result and not re-read the admin setting.
    resolveProjectPublishing.mockResolvedValue({
      automationEnabled: true,
      publishingEnabled: true,
      publishingConfigured: true,
      enabledPlatforms: ['x'],
      windows: { x: { windowStart: '09:00', windowEnd: '17:00' } },
    });
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // midpoint of the 8h span

    await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    expect(getPublishTimeWindows).not.toHaveBeenCalled();
    expect(schedulePostGroupToQueue).toHaveBeenCalledWith(
      'org-1',
      'gx',
      'EXTENSION',
      new Date('2026-08-01T13:00:00.000Z')
    );
  });
});

// The switch chain the product asks for: master → feature → platform, ANDed.
// These pin the two upper levels; the platform level is covered by the
// "project scoping" block above.
//
// What they must NOT do is reach past the queue: a post already in QUEUE, or one
// the extension is mid-send on, is past this gate and finishes regardless. These
// switches gate what ENTERS the queue, which is why every assertion here is
// about schedulePostGroupToQueue never being called — not about anything being
// un-queued.
describe('PostsService.schedulePlanPosts — automation switch chain', () => {
  beforeEach(() => vi.restoreAllMocks());

  const xDraft = (over: Partial<any>) =>
    draft({
      integrationId: 'int-x',
      integration: { providerIdentifier: 'x', disabled: false },
      settings: JSON.stringify({ __type: 'x' }),
      ...over,
    });

  const oneDraftPlan = () =>
    makeService(
      [xDraft({ id: 'x1', group: 'gx' })],
      [
        {
          id: 'x1',
          group: 'gx',
          state: 'DRAFT',
          providerIdentifier: 'x',
          publishDate: new Date('2026-08-21T12:00:00.000Z'),
        },
      ]
    );

  const switches = (over: Partial<Record<string, unknown>> = {}) => ({
    automationEnabled: true,
    publishingEnabled: true,
    publishingConfigured: true,
    enabledPlatforms: ['x'],
    windows: {},
    ...over,
  });

  it('queues nothing when the MASTER switch is off, whatever the feature says', async () => {
    const { service, schedulePostGroupToQueue, getSchedulablePostRootsByPlan, resolveProjectPublishing } =
      oneDraftPlan();
    resolveProjectPublishing.mockResolvedValue(
      switches({ automationEnabled: false, publishingEnabled: true })
    );

    const res = await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    expect(schedulePostGroupToQueue).not.toHaveBeenCalled();
    // Short-circuits before even reading the plan's posts — a switched-off
    // project should cost nothing.
    expect(getSchedulablePostRootsByPlan).not.toHaveBeenCalled();
    expect(res).toEqual({ scheduled: [], failed: [], total: 0, alreadyScheduled: 0 });
  });

  it('queues nothing when the PUBLISHING feature switch is off under a live master', async () => {
    const { service, schedulePostGroupToQueue, resolveProjectPublishing } = oneDraftPlan();
    resolveProjectPublishing.mockResolvedValue(
      switches({ automationEnabled: true, publishingEnabled: false })
    );

    const res = await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    expect(schedulePostGroupToQueue).not.toHaveBeenCalled();
    expect(res.total).toBe(0);
  });

  it('queues when both levels are on', async () => {
    const { service, schedulePostGroupToQueue, resolveProjectPublishing } = oneDraftPlan();
    resolveProjectPublishing.mockResolvedValue(switches());

    const res = await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    expect(schedulePostGroupToQueue).toHaveBeenCalledWith('org-1', 'gx', 'EXTENSION', undefined);
    expect(res.scheduled).toEqual([{ id: 'x1', publishMethod: 'extension' }]);
  });

  it('still applies the PLATFORM level under two live switches', async () => {
    // Both features on, but this plan's platform is not in the project's list —
    // the third level of the chain, applied per post rather than per project.
    const { service, schedulePostGroupToQueue, resolveProjectPublishing } = oneDraftPlan();
    resolveProjectPublishing.mockResolvedValue(switches({ enabledPlatforms: ['reddit'] }));

    const res = await service.schedulePlanPosts('org-1', 'plan-1', 'proj-1');

    expect(schedulePostGroupToQueue).not.toHaveBeenCalled();
    expect(res.total).toBe(0);
  });

  it('reports an empty batch rather than throwing when a switch is off', async () => {
    // The caller is saving publishing settings with `commit` — a legitimate
    // action that simply has nothing to commit. Throwing would fail the save.
    const { service, resolveProjectPublishing } = oneDraftPlan();
    resolveProjectPublishing.mockResolvedValue(switches({ automationEnabled: false }));

    await expect(service.schedulePlanPosts('org-1', 'plan-1', 'proj-1')).resolves.toMatchObject({
      failed: [],
    });
  });
});

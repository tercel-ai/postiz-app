import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  const schedulePostGroupToQueue = vi.fn().mockResolvedValue({ count: 1 });
  const repo = {
    getSchedulablePostsByIds,
    getSchedulablePostRootsByPlan,
    schedulePostGroupToQueue,
  } as any;

  // No configured window on any platform, by default — the pre-existing
  // behaviour (materialized publishDate always kept as-is).
  const getPublishTimeWindows = vi.fn().mockResolvedValue({});
  const extensionPublishConfigService = { getPublishTimeWindows } as any;

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
    extensionPublishConfigService
  );
  // Stub the Temporal trigger so we can assert WHICH posts reach it.
  const startWorkflow = vi
    .spyOn(service as any, 'startWorkflow')
    .mockResolvedValue(undefined);

  return {
    service,
    getSchedulablePostsByIds,
    getSchedulablePostRootsByPlan,
    schedulePostGroupToQueue,
    startWorkflow,
    getPublishTimeWindows,
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

// Plan-scoped commit: the "activate this plan" action. What matters is that it
// reduces to the id-based path (same send-path resolution, same double-publish
// guard) while only ever touching the plan's still-DRAFT roots.
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

    const res = await service.schedulePlanPosts('org-1', 'plan-1');

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

  it('already-committed plan: no-op success that is distinguishable from an unknown plan', async () => {
    const { service, schedulePostGroupToQueue } = makeService(
      [],
      [{ id: 'p1', state: 'QUEUE' }]
    );

    const res = await service.schedulePlanPosts('org-1', 'plan-1');

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

    const res = await service.schedulePlanPosts('org-1', 'nope');

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

    const res = await service.schedulePlanPosts('org-1', 'plan-1', 'api');

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

    const res = await service.schedulePlanPosts('org-1', 'plan-1');

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

    const res = await service.schedulePlanPosts('org-1', 'plan-1', undefined, ['x']);

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

    await service.schedulePlanPosts('org-1', 'plan-1', undefined, ['x']);

    expect(getSchedulablePostsByIds).toHaveBeenCalledWith('org-1', ['x1']);
  });

  it('an empty match is a no-op success, not an error', async () => {
    const { service, getSchedulablePostsByIds, schedulePostGroupToQueue } = makeService(
      [],
      [{ id: 'r1', state: 'DRAFT', providerIdentifier: 'reddit' }]
    );

    const res = await service.schedulePlanPosts('org-1', 'plan-1', undefined, ['linkedin']);

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

    await service.schedulePlanPosts('org-1', 'plan-1', undefined, []);

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

    await service.schedulePlanPosts('org-1', 'plan-1');

    expect(schedulePostGroupToQueue).toHaveBeenCalledWith(
      'org-1',
      'gx',
      'EXTENSION',
      undefined
    );
  });

  it('leaves publishDate untouched when it already falls inside the window', async () => {
    const { service, schedulePostGroupToQueue, getPublishTimeWindows } = makeService(
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
    getPublishTimeWindows.mockResolvedValue({
      x: { windowStart: '09:00', windowEnd: '17:00' },
    });

    await service.schedulePlanPosts('org-1', 'plan-1');

    expect(schedulePostGroupToQueue).toHaveBeenCalledWith(
      'org-1',
      'gx',
      'EXTENSION',
      undefined
    );
  });

  it('re-picks a random time inside the window when the materialized time falls outside it', async () => {
    const { service, schedulePostGroupToQueue, getPublishTimeWindows } = makeService(
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
    getPublishTimeWindows.mockResolvedValue({
      x: { windowStart: '09:00', windowEnd: '17:00' },
    });
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // midpoint of the 8h span

    await service.schedulePlanPosts('org-1', 'plan-1');

    expect(schedulePostGroupToQueue).toHaveBeenCalledWith(
      'org-1',
      'gx',
      'EXTENSION',
      new Date('2026-08-01T13:00:00.000Z')
    );
  });

  it('honours the window timezone, not UTC clock time', async () => {
    const { service, schedulePostGroupToQueue, getPublishTimeWindows } = makeService(
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
    getPublishTimeWindows.mockResolvedValue({
      x: { windowStart: '09:00', windowEnd: '17:00', timezone: 'Asia/Tokyo' },
    });

    await service.schedulePlanPosts('org-1', 'plan-1');

    expect(schedulePostGroupToQueue).toHaveBeenCalledWith(
      'org-1',
      'gx',
      'EXTENSION',
      undefined
    );
  });

  it('re-picks into the following local day for a window that wraps past midnight', async () => {
    const { service, schedulePostGroupToQueue, getPublishTimeWindows } = makeService(
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
    getPublishTimeWindows.mockResolvedValue({
      x: { windowStart: '22:00', windowEnd: '02:00' },
    });
    // span = 240min; floor(0.999 * 240) = 239 -> 22:00 + 239min = next-day 01:59
    vi.spyOn(Math, 'random').mockReturnValue(0.999);

    await service.schedulePlanPosts('org-1', 'plan-1');

    expect(schedulePostGroupToQueue).toHaveBeenCalledWith(
      'org-1',
      'gx',
      'EXTENSION',
      new Date('2026-08-02T01:59:00.000Z')
    );
  });

  it('matches the window platform key case-insensitively', async () => {
    const { service, schedulePostGroupToQueue, getPublishTimeWindows } = makeService(
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
    getPublishTimeWindows.mockResolvedValue({
      x: { windowStart: '09:00', windowEnd: '17:00' },
    });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    await service.schedulePlanPosts('org-1', 'plan-1');

    expect(schedulePostGroupToQueue).toHaveBeenCalledWith(
      'org-1',
      'gx',
      'EXTENSION',
      new Date('2026-08-01T13:00:00.000Z')
    );
  });

  it('never calls getPublishTimeWindows when the plan has no DRAFT roots to schedule', async () => {
    const { service, getPublishTimeWindows } = makeService(
      [],
      [{ id: 'x1', state: 'QUEUE', providerIdentifier: 'x' }]
    );

    await service.schedulePlanPosts('org-1', 'plan-1');

    expect(getPublishTimeWindows).not.toHaveBeenCalled();
  });
});

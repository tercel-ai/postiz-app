import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminDiagnosticsController } from '../admin-diagnostics.controller';

// The integrations drill-down reports on TWO send paths with one table, and the
// difference decides whether a red row means "this account cannot publish" or
// "this token is stale and nothing depends on it". Seven providers publish
// through the browser extension, which uses the user's own session and never
// touches the OAuth token — so an expired token there blocks nothing, while the
// endpoint used to report it beside that integration's queued posts under a
// field literally named `blockedQueuePosts`.

const integration = (over: Record<string, unknown> = {}) => ({
  id: 'int-1',
  name: 'Acme',
  providerIdentifier: 'x',
  organizationId: 'org-1',
  refreshNeeded: false,
  inBetweenSteps: false,
  disabled: false,
  ...over,
});

function makeController(
  unhealthy: ReturnType<typeof integration>[],
  queueCounts: Array<{ integrationId: string; _count: number }> = []
) {
  const integrationRepository = {
    findUnhealthyIntegrations: vi.fn().mockResolvedValue(unhealthy),
  } as any;
  const postsRepository = {
    countQueuePostsByIntegrations: vi.fn().mockResolvedValue(queueCounts),
  } as any;
  return new AdminDiagnosticsController(
    postsRepository,
    integrationRepository,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
}

describe('AdminDiagnosticsController.checkIntegrations — send path', () => {
  beforeEach(() => vi.unstubAllEnvs());

  it('labels each row with the path it actually publishes on', async () => {
    const controller = makeController([
      integration({ id: 'ext', providerIdentifier: 'reddit', refreshNeeded: true }),
      integration({ id: 'api', providerIdentifier: 'instagram', refreshNeeded: true }),
    ]);

    const res = await controller.checkIntegrations();

    expect(res.unhealthyIntegrations.map((r: any) => [r.id, r.sendPath])).toEqual([
      ['ext', 'extension'],
      ['api', 'api'],
    ]);
  });

  // The bug this split exists for: an operator saw "token expired, 12 posts
  // blocked" and went to reconnect an OAuth app that has nothing to do with how
  // those posts go out.
  it('reports no blocked posts for an expired token on an extension platform', async () => {
    const controller = makeController(
      [integration({ providerIdentifier: 'reddit', refreshNeeded: true })],
      [{ integrationId: 'int-1', _count: 12 }]
    );

    const res = await controller.checkIntegrations();

    const row = res.unhealthyIntegrations[0] as any;
    expect(row.blocking).toBe(false);
    expect(row.blockedQueuePosts).toBe(0);
    // The posts are still THERE — they are queued for the browser, which is the
    // normal resting state for an extension platform, not a stall.
    expect(row.queuePosts).toBe(12);
  });

  it('still reports them as blocked on an API platform', async () => {
    const controller = makeController(
      [integration({ providerIdentifier: 'instagram', refreshNeeded: true })],
      [{ integrationId: 'int-1', _count: 12 }]
    );

    const res = await controller.checkIntegrations();

    const row = res.unhealthyIntegrations[0] as any;
    expect(row.blocking).toBe(true);
    expect(row.blockedQueuePosts).toBe(12);
  });

  // `disabled` is the one flag that means the same thing on both paths.
  it('treats a disabled integration as blocking whatever the path', async () => {
    const controller = makeController(
      [integration({ providerIdentifier: 'reddit', disabled: true })],
      [{ integrationId: 'int-1', _count: 3 }]
    );

    const res = await controller.checkIntegrations();

    expect((res.unhealthyIntegrations[0] as any).blocking).toBe(true);
    expect((res.unhealthyIntegrations[0] as any).blockedQueuePosts).toBe(3);
  });

  it('treats a half-finished OAuth flow as blocking only on the API path', async () => {
    const controller = makeController([
      integration({ id: 'ext', providerIdentifier: 'medium', inBetweenSteps: true }),
      integration({ id: 'api', providerIdentifier: 'facebook', inBetweenSteps: true }),
    ]);

    const res = await controller.checkIntegrations();

    const byId = Object.fromEntries(
      res.unhealthyIntegrations.map((r: any) => [r.id, r.blocking])
    );
    expect(byId).toEqual({ ext: false, api: true });
  });

  // The row stays visible either way: an expired token on an extension platform
  // means that integration cannot fall back to the API path, and its analytics
  // reads still use the token. It is worth seeing — it is just not an outage.
  it('keeps a non-blocking row in the list', async () => {
    const controller = makeController([
      integration({ providerIdentifier: 'reddit', refreshNeeded: true }),
    ]);

    const res = await controller.checkIntegrations();

    expect(res.unhealthyIntegrations).toHaveLength(1);
    expect(res.summary.total).toBe(1);
    expect(res.summary.refreshNeeded).toBe(1);
  });

  it('calls the whole dashboard healthy when nothing is blocking', async () => {
    const controller = makeController([
      integration({ providerIdentifier: 'reddit', refreshNeeded: true }),
      integration({ id: 'int-2', providerIdentifier: 'x', refreshNeeded: true }),
    ]);

    const res = await controller.checkIntegrations();

    expect(res.summary.blocking).toBe(0);
    expect(res.summary.healthy).toBe(true);
  });

  it('goes unhealthy the moment one row genuinely blocks', async () => {
    const controller = makeController(
      [
        integration({ providerIdentifier: 'reddit', refreshNeeded: true }),
        integration({ id: 'int-2', providerIdentifier: 'instagram', refreshNeeded: true }),
      ],
      [
        { integrationId: 'int-1', _count: 5 },
        { integrationId: 'int-2', _count: 7 },
      ]
    );

    const res = await controller.checkIntegrations();

    expect(res.summary.blocking).toBe(1);
    expect(res.summary.healthy).toBe(false);
    // Only the API-routed one's posts are counted as held up.
    expect(res.summary.blockedQueuePosts).toBe(7);
  });

  it('reports healthy with no unhealthy integrations at all', async () => {
    const controller = makeController([]);

    const res = await controller.checkIntegrations();

    expect(res.summary).toMatchObject({ total: 0, blocking: 0, healthy: true });
  });

  // The routing is a deployment decision (DEFAULT_PUBLISH_METHOD), so the same
  // provider must be read the way THIS deployment actually sends.
  it('follows the deployment when it routes everything through the API', async () => {
    vi.stubEnv('DEFAULT_PUBLISH_METHOD', 'api');
    vi.resetModules();
    const { AdminDiagnosticsController: Reloaded } = await import(
      '../admin-diagnostics.controller'
    );
    const controller = new Reloaded(
      { countQueuePostsByIntegrations: vi.fn().mockResolvedValue([]) } as any,
      {
        findUnhealthyIntegrations: vi
          .fn()
          .mockResolvedValue([integration({ providerIdentifier: 'reddit', refreshNeeded: true })]),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    const res = await controller.checkIntegrations();

    expect((res.unhealthyIntegrations[0] as any).sendPath).toBe('api');
    expect((res.unhealthyIntegrations[0] as any).blocking).toBe(true);
  });
});

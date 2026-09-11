/**
 * A channel created from a browser session (createChannelFromExtensionSession)
 * has NO server-side token: `token` is the handle, `refreshToken` is empty and
 * `tokenExpiration` is deliberately null so the hourly refresh sweep skips it.
 *
 * Attributing an extension-published post to such a channel made it reachable
 * from checkPostAnalytics for the first time, and the path it lands in is
 * destructive: the provider 401s on a handle-as-token, social.abstract turns
 * ANY 401 into `RefreshToken`, the catch re-enters with forceRefresh, and
 * refreshProcess answers a permanent refresh failure by flagging refreshNeeded,
 * notifying the user to reconnect, and disconnecting the channel.
 *
 * The channel would disable itself because a post was attributed to it. These
 * tests pin the guard that stops it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostsService } from '../posts.service';
import { RefreshToken } from '@gitroom/nestjs-libraries/integrations/social.abstract';

function makeService(integration: any, postAnalytics: any) {
  const repo: any = {
    getPostById: vi.fn().mockResolvedValue({
      id: 'p1',
      releaseId: 'rel-1',
      integration,
    }),
    batchUpdatePostAnalytics: vi.fn().mockResolvedValue({}),
  };
  const integrationManager: any = {
    getSocialIntegration: vi.fn().mockReturnValue({ postAnalytics }),
  };
  const integrationService: any = {
    disconnectChannel: vi.fn().mockResolvedValue({}),
  };
  const refreshIntegrationService: any = {
    refresh: vi.fn().mockResolvedValue(false),
  };
  const svc = new PostsService(
    repo,
    integrationManager,
    integrationService,
    {} as any, // _mediaService
    {} as any, // _shortLinkService
    {} as any, // _openaiService
    {} as any, // _temporalService
    refreshIntegrationService,
    {} as any, // _postOverageService
    {} as any // _extensionPublishConfigService
  );
  return { svc, refreshIntegrationService, integrationService };
}

/** A real OAuth channel: a server-side token with a known expiry. */
const OAUTH_CHANNEL = {
  id: 'int_oauth',
  providerIdentifier: 'reddit',
  internalId: 'abc',
  token: 'real-access-token',
  refreshToken: 'real-refresh-token',
  tokenExpiration: new Date(Date.now() - 60_000), // already expired
};

/** A session-created channel: the browser IS the credential. */
const SESSION_CHANNEL = {
  id: 'int_session',
  providerIdentifier: 'reddit',
  internalId: 'abc',
  token: 'u/someone',
  refreshToken: '',
  tokenExpiration: null,
};

describe('checkPostAnalytics — a session-credentialed channel is never refreshed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not attempt a refresh when the 401 came from a channel with no server-side token', async () => {
    const postAnalytics = vi
      .fn()
      .mockRejectedValue(new RefreshToken('reddit', '{}', '' as any, ''));
    const { svc, refreshIntegrationService, integrationService } = makeService(
      SESSION_CHANNEL,
      postAnalytics
    );

    const r = await svc.checkPostAnalytics('org-1', 'p1', Date.now());

    expect(r).toEqual([]);
    // The whole point: no refresh means no refreshNeeded, no "please reconnect"
    // notification, and no disconnect.
    expect(refreshIntegrationService.refresh).not.toHaveBeenCalled();
    expect(integrationService.disconnectChannel).not.toHaveBeenCalled();
  });

  it('still refreshes a real OAuth channel whose token has expired', async () => {
    const postAnalytics = vi.fn().mockResolvedValue([]);
    const { svc, refreshIntegrationService } = makeService(
      OAUTH_CHANNEL,
      postAnalytics
    );

    await svc.checkPostAnalytics('org-1', 'p1', Date.now());

    expect(refreshIntegrationService.refresh).toHaveBeenCalledTimes(1);
  });

  it('leaves an unexpired session channel free to read metrics when its token does work', async () => {
    // The guard only covers the REFRESH branch — a handle-only platform whose
    // reads need no bearer must keep working.
    const postAnalytics = vi
      .fn()
      .mockResolvedValue([{ label: 'Likes', data: [{ total: '3', date: '2026-09-11' }] }]);
    const { svc, refreshIntegrationService } = makeService(
      SESSION_CHANNEL,
      postAnalytics
    );

    const r = await svc.checkPostAnalytics('org-1', 'p1', Date.now());

    expect(refreshIntegrationService.refresh).not.toHaveBeenCalled();
    expect(r.length).toBeGreaterThan(0);
  });

  it('returns [] for a post with no integration at all, as before', async () => {
    const { svc } = makeService(null, vi.fn());

    expect(await svc.checkPostAnalytics('org-1', 'p1', Date.now())).toEqual([]);
  });
});

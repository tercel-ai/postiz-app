import type { Organization } from '@prisma/client';
import { ApiResponseError, TwitterApi } from 'twitter-api-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBizUsageContext } from '@gitroom/nestjs-libraries/database/prisma/api-usage/api-usage.service';
import { IntegrationsController } from '../integrations.controller';

function createController() {
  const integrationService = { getIntegrationById: vi.fn(), pickActiveIntegrationByProvider: vi.fn() };
  const refreshService = { refresh: vi.fn() };
  const manager = { getAllowedSocialsIntegrations: () => ['x', 'reddit'] };
  const controller = new IntegrationsController(
    manager as never,
    integrationService as never,
    {} as never,
    refreshService as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { controller, integrationService, refreshService };
}

function upstreamError(code: number) {
  return new ApiResponseError('upstream private details', {
    code, request: {} as never, response: {} as never, headers: {}, data: {},
  });
}

describe('IntegrationsController.fetchUserByUsername', () => {
  const organization = { id: 'org-1' } as Organization;
  const xUser = { id: 'user-123', username: 'alice', name: 'Alice' };
  const userByUsername = vi.fn();
  const readAuth = vi.fn();

  beforeEach(() => {
    vi.stubEnv('X_BEARER_TOKEN', 'app-bearer');
    vi.stubEnv('X_API_KEY', '');
    vi.stubEnv('X_API_SECRET', '');
    vi.stubEnv('X_API_ENABLED', 'false');
    readAuth.mockClear();
    userByUsername.mockReset().mockResolvedValue({ data: xUser });
    vi.spyOn(TwitterApi.prototype, 'v2', 'get').mockImplementation(function (this: TwitterApi) {
      readAuth(this.getActiveTokens());
      return { userByUsername } as never;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([{ username: 'alice' }, { username: '@alice', id: 'unavailable-integration', provider: 'x' }])(
    'looks up a public X user without integration or refresh access for %j',
    async (body) => {
      const { controller, integrationService, refreshService } = createController();
      userByUsername.mockImplementationOnce(async () => {
        expect(getBizUsageContext()).toEqual({ organizationId: 'org-1', bizCategory: 'user_lookup' });
        return { data: xUser };
      });

      await expect(controller.fetchUserByUsername(organization, body)).resolves.toMatchObject({
        ...xUser,
        url: 'https://twitter.com/alice',
        raw: xUser,
      });
      expect(readAuth).toHaveBeenCalledWith({ type: 'oauth2', bearerToken: 'app-bearer' });
      expect(userByUsername).toHaveBeenCalledWith('alice', expect.objectContaining({
        'user.fields': expect.arrayContaining(['username', 'profile_image_url', 'public_metrics']),
      }));
      expect(integrationService.getIntegrationById).not.toHaveBeenCalled();
      expect(integrationService.pickActiveIntegrationByProvider).not.toHaveBeenCalled();
      expect(refreshService.refresh).not.toHaveBeenCalled();
    },
  );

  it('prioritizes the configured bearer even when consumer credentials are present', async () => {
    vi.stubEnv('X_API_KEY', 'app-key');
    vi.stubEnv('X_API_SECRET', 'app-secret');
    const appLogin = vi.spyOn(TwitterApi.prototype, 'appLogin');

    await createController().controller.fetchUserByUsername(organization, { username: 'alice' });

    expect(appLogin).not.toHaveBeenCalled();
    expect(readAuth).toHaveBeenCalledWith({ type: 'oauth2', bearerToken: 'app-bearer' });
  });

  it('gets an app bearer using consumer credentials when no bearer is configured', async () => {
    vi.stubEnv('X_BEARER_TOKEN', '');
    vi.stubEnv('X_API_KEY', 'app-key');
    vi.stubEnv('X_API_SECRET', 'app-secret');
    const appLogin = vi.spyOn(TwitterApi.prototype, 'appLogin').mockImplementation(
      async function (this: TwitterApi) {
        expect(this.getActiveTokens()).toMatchObject({
          type: 'oauth-1.0a', appKey: 'app-key', appSecret: 'app-secret',
          accessToken: undefined, accessSecret: undefined,
        });
        return new TwitterApi('issued-app-bearer');
      },
    );

    await expect(createController().controller.fetchUserByUsername(organization, { username: 'alice' }))
      .resolves.toMatchObject(xUser);
    expect(appLogin).toHaveBeenCalledTimes(1);
    expect(readAuth).toHaveBeenCalledWith({ type: 'oauth2', bearerToken: 'issued-app-bearer' });
  });

  it('returns a configuration error before any upstream call with incomplete app credentials', async () => {
    vi.stubEnv('X_BEARER_TOKEN', ' ');
    vi.stubEnv('X_API_KEY', 'app-key');
    const appLogin = vi.spyOn(TwitterApi.prototype, 'appLogin');
    await expect(createController().controller.fetchUserByUsername(organization, { username: 'alice' }))
      .rejects.toMatchObject({ status: 503, response: { error: 'x_lookup_not_configured' } });
    expect(appLogin).not.toHaveBeenCalled();
    expect(userByUsername).not.toHaveBeenCalled();
  });

  it('returns 404 when X finds no user', async () => {
    userByUsername.mockResolvedValueOnce({ errors: [{ type: 'https://api.x.com/2/problems/resource-not-found' }] });
    await expect(createController().controller.fetchUserByUsername(organization, { username: 'nobody' }))
      .rejects.toMatchObject({ status: 404, response: { error: 'not_found' } });
  });

  it.each([[401, 502], [403, 502], [429, 429], [500, 502]])(
    'maps upstream %i to HTTP %i without refreshing an integration or exposing the raw error',
    async (upstream, status) => {
      userByUsername.mockRejectedValueOnce(upstreamError(upstream));
      const { controller, refreshService } = createController();
      const error = await controller.fetchUserByUsername(organization, { username: 'alice' }).catch(err => err);
      expect(error.status).toBe(status);
      expect(JSON.stringify(error.response)).not.toContain('upstream private details');
      expect(refreshService.refresh).not.toHaveBeenCalled();
    },
  );

  it.each([['unknown', 400], ['reddit', 501]])('rejects provider %s with %i before lookup', async (provider, status) => {
    await expect(createController().controller.fetchUserByUsername(organization, { username: 'alice', provider }))
      .rejects.toMatchObject({ status });
    expect(userByUsername).not.toHaveBeenCalled();
  });
});

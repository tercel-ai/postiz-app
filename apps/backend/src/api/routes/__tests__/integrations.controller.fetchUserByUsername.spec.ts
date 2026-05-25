import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpException } from '@nestjs/common';
import { IntegrationsController } from '../integrations.controller';
import { RefreshToken } from '@gitroom/nestjs-libraries/integrations/social.abstract';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const ALLOWED_PROVIDERS = ['x', 'reddit', 'linkedin'];

function createMocks() {
  return {
    integrationManager: {
      getAllowedSocialsIntegrations: vi.fn().mockReturnValue(ALLOWED_PROVIDERS),
      getSocialIntegration: vi.fn().mockReturnValue({
        refreshWait: false,
        fetchUserByUsername: vi.fn().mockResolvedValue({ id: 'user-123', username: 'alice' }),
      }),
      getAllIntegrations: vi.fn().mockReturnValue([]),
      getInternalPlugs: vi.fn(),
      getAllPlugs: vi.fn().mockReturnValue([]),
    },
    integrationService: {
      getIntegrationById: vi.fn(),
      pickActiveIntegrationByProvider: vi.fn(),
      getIntegrationsList: vi.fn().mockResolvedValue([]),
      customers: vi.fn(),
      setTimes: vi.fn(),
      getMentions: vi.fn().mockResolvedValue([]),
      insertMentions: vi.fn(),
      getIntegrationForOrder: vi.fn(),
      saveProviderPage: vi.fn(),
      disableChannel: vi.fn(),
      enableChannel: vi.fn(),
      deleteChannel: vi.fn(),
      softDeleteUnpublishedPostsForChannel: vi.fn(),
      getPlugsByIntegrationId: vi.fn(),
      createOrUpdatePlug: vi.fn(),
      changePlugActivation: vi.fn(),
      getPostsForChannel: vi.fn().mockResolvedValue([]),
      getPostsLevelAnalytics: vi.fn().mockResolvedValue([]),
      updateIntegrationGroup: vi.fn(),
      updateOnCustomerName: vi.fn(),
      updateProviderSettings: vi.fn(),
      updateNameAndUrl: vi.fn(),
      checkPreviousConnections: vi.fn(),
      createOrUpdateIntegration: vi.fn(),
    },
    postService: {},
    refreshIntegrationService: { refresh: vi.fn() },
    dataTicksService: { syncAccountMetricsById: vi.fn().mockResolvedValue(null) },
    aiseeClient: { syncIntegration: vi.fn() },
  };
}

function createController(mocks: ReturnType<typeof createMocks>) {
  return new IntegrationsController(
    mocks.integrationManager as any,
    mocks.integrationService as any,
    mocks.postService as any,
    mocks.refreshIntegrationService as any,
    mocks.dataTicksService as any,
    mocks.aiseeClient as any,
  );
}

const fakeOrg = { id: 'org-1' } as any;

const fakeIntegration = {
  id: 'int-1',
  token: 'tok-aaa',
  internalId: 'internal-1',
  providerIdentifier: 'x',
  refreshToken: 'ref-aaa',
  tokenExpiration: null as Date | null,
  organizationId: 'org-1',
};

// ---------------------------------------------------------------------------
// Branch A: org-scoped lookup (body.id present)
// ---------------------------------------------------------------------------

describe('IntegrationsController.fetchUserByUsername — branch A (body.id present)', () => {
  let mocks: ReturnType<typeof createMocks>;
  let controller: IntegrationsController;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    controller = createController(mocks);
    mocks.integrationService.getIntegrationById.mockResolvedValue(fakeIntegration);
  });

  it('looks up integration by org.id + body.id', async () => {
    await controller.fetchUserByUsername(fakeOrg, { id: 'int-1', username: 'alice' });
    expect(mocks.integrationService.getIntegrationById).toHaveBeenCalledWith('org-1', 'int-1');
    expect(mocks.integrationService.pickActiveIntegrationByProvider).not.toHaveBeenCalled();
  });

  it('throws 400 when integration not found', async () => {
    mocks.integrationService.getIntegrationById.mockResolvedValue(null);
    await expect(
      controller.fetchUserByUsername(fakeOrg, { id: 'bad-id', username: 'alice' })
    ).rejects.toThrow(HttpException);
  });

  it('returns provider result on success', async () => {
    const result = await controller.fetchUserByUsername(fakeOrg, { id: 'int-1', username: 'alice' });
    expect(result).toEqual({ id: 'user-123', username: 'alice' });
  });
});

// ---------------------------------------------------------------------------
// Branch B: system round-robin (body.id absent, body.provider present)
// ---------------------------------------------------------------------------

describe('IntegrationsController.fetchUserByUsername — branch B (provider round-robin)', () => {
  let mocks: ReturnType<typeof createMocks>;
  let controller: IntegrationsController;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    controller = createController(mocks);
    mocks.integrationService.pickActiveIntegrationByProvider.mockResolvedValue(fakeIntegration);
  });

  it('throws 400 for an unknown provider (not in allowlist)', async () => {
    await expect(
      controller.fetchUserByUsername(fakeOrg, { provider: 'unknown-provider', username: 'alice' })
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.integrationService.pickActiveIntegrationByProvider).not.toHaveBeenCalled();
  });

  it('throws 503 when no active integration is available', async () => {
    mocks.integrationService.pickActiveIntegrationByProvider.mockResolvedValue(null);
    await expect(
      controller.fetchUserByUsername(fakeOrg, { provider: 'x', username: 'alice' })
    ).rejects.toMatchObject({ status: 503 });
  });

  it('calls pickActiveIntegrationByProvider with the provider name', async () => {
    await controller.fetchUserByUsername(fakeOrg, { provider: 'x', username: 'alice' });
    expect(mocks.integrationService.pickActiveIntegrationByProvider).toHaveBeenCalledWith('x');
    expect(mocks.integrationService.getIntegrationById).not.toHaveBeenCalled();
  });

  it('returns provider result on success', async () => {
    const result = await controller.fetchUserByUsername(fakeOrg, { provider: 'x', username: 'alice' });
    expect(result).toEqual({ id: 'user-123', username: 'alice' });
  });

  it('retries with refreshed token on RefreshToken — uses same integration (not a new one)', async () => {
    const provider = mocks.integrationManager.getSocialIntegration('x') as any;
    provider.fetchUserByUsername
      .mockRejectedValueOnce(new RefreshToken('', '', ''))
      .mockResolvedValueOnce({ id: 'user-456', username: 'bob' });

    mocks.refreshIntegrationService.refresh.mockResolvedValue({ accessToken: 'tok-refreshed' });

    const result = await controller.fetchUserByUsername(fakeOrg, { provider: 'x', username: 'bob' });

    // Should have refreshed exactly once
    expect(mocks.refreshIntegrationService.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.refreshIntegrationService.refresh).toHaveBeenCalledWith(fakeIntegration);

    // pickActiveIntegrationByProvider called only ONCE — not again on retry
    expect(mocks.integrationService.pickActiveIntegrationByProvider).toHaveBeenCalledTimes(1);

    expect(result).toEqual({ id: 'user-456', username: 'bob' });
  });

  it('throws 401 when token refresh fails', async () => {
    const provider = mocks.integrationManager.getSocialIntegration('x') as any;
    provider.fetchUserByUsername.mockRejectedValueOnce(new RefreshToken('', '', ''));
    mocks.refreshIntegrationService.refresh.mockResolvedValue(null);

    await expect(
      controller.fetchUserByUsername(fakeOrg, { provider: 'x', username: 'alice' })
    ).rejects.toMatchObject({ status: 401 });
  });

  it('does not recurse infinitely — retries at most once on RefreshToken', async () => {
    const provider = mocks.integrationManager.getSocialIntegration('x') as any;
    // Always throw RefreshToken — should not loop more than 2 iterations
    provider.fetchUserByUsername.mockRejectedValue(new RefreshToken('', '', ''));
    mocks.refreshIntegrationService.refresh.mockResolvedValue({ accessToken: 'tok-new' });

    await expect(
      controller.fetchUserByUsername(fakeOrg, { provider: 'x', username: 'alice' })
    ).rejects.toMatchObject({ status: 500 });

    // fetchUserByUsername called at most twice (attempt 0 + attempt 1)
    expect(provider.fetchUserByUsername).toHaveBeenCalledTimes(2);
    // pickActiveIntegrationByProvider NOT called again on retry
    expect(mocks.integrationService.pickActiveIntegrationByProvider).toHaveBeenCalledTimes(1);
  });

  it('throws 501 when provider does not support username lookup', async () => {
    const provider = mocks.integrationManager.getSocialIntegration('x') as any;
    provider.fetchUserByUsername.mockResolvedValue({ supported: false });
    await expect(
      controller.fetchUserByUsername(fakeOrg, { provider: 'x', username: 'alice' })
    ).rejects.toMatchObject({ status: 501 });
  });

  it('throws 404 when user not found', async () => {
    const provider = mocks.integrationManager.getSocialIntegration('x') as any;
    provider.fetchUserByUsername.mockResolvedValue({ notFound: true });
    await expect(
      controller.fetchUserByUsername(fakeOrg, { provider: 'x', username: 'nobody' })
    ).rejects.toMatchObject({ status: 404 });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectValidationService } from './project-validation.service';
import {
  ProjectInactiveException,
  ProjectNotFoundException,
  ProjectValidationUnavailableException,
} from './project.exception';

const ORG_ID = 'org-1';
const OWNER_USER_ID = 'user-owner';
const VALID_PROJECT_ID = 'a1b2c3d4-e5f6-4789-9abc-def012345678';

function createMocks() {
  return {
    aiseeClient: {
      getProduct: vi.fn(),
    },
    aiseeCreditService: {
      resolveOwnerUserId: vi.fn().mockResolvedValue(OWNER_USER_ID),
    },
  };
}

function createService(mocks: ReturnType<typeof createMocks>) {
  return new ProjectValidationService(
    mocks.aiseeClient as any,
    mocks.aiseeCreditService as any
  );
}

describe('ProjectValidationService.assertProjectAccess', () => {
  let mocks: ReturnType<typeof createMocks>;
  let service: ProjectValidationService;

  beforeEach(() => {
    mocks = createMocks();
    service = createService(mocks);
  });

  it('resolves when the project is owned by the organization', async () => {
    mocks.aiseeClient.getProduct.mockResolvedValue({
      ok: true,
      product: { id: VALID_PROJECT_ID, userId: OWNER_USER_ID, status: 'active' },
    });

    await expect(
      service.assertProjectAccess(ORG_ID, VALID_PROJECT_ID)
    ).resolves.toBeUndefined();
  });

  it('throws ProjectNotFoundException for a non-UUID projectId without calling aisee-core', async () => {
    await expect(
      service.assertProjectAccess(ORG_ID, 'https://evil.example.com')
    ).rejects.toBeInstanceOf(ProjectNotFoundException);
    expect(mocks.aiseeClient.getProduct).not.toHaveBeenCalled();
  });

  it('throws ProjectNotFoundException when aisee-core has no such product', async () => {
    mocks.aiseeClient.getProduct.mockResolvedValue({ ok: false, reason: 'not_found' });

    await expect(
      service.assertProjectAccess(ORG_ID, VALID_PROJECT_ID)
    ).rejects.toBeInstanceOf(ProjectNotFoundException);
  });

  it('throws ProjectNotFoundException (not 403) when the project belongs to a different owner', async () => {
    mocks.aiseeClient.getProduct.mockResolvedValue({
      ok: true,
      product: { id: VALID_PROJECT_ID, userId: 'someone-else', status: 'active' },
    });

    await expect(
      service.assertProjectAccess(ORG_ID, VALID_PROJECT_ID)
    ).rejects.toBeInstanceOf(ProjectNotFoundException);
  });

  it('fails closed with ProjectValidationUnavailableException when aisee-core is unreachable', async () => {
    mocks.aiseeClient.getProduct.mockResolvedValue({ ok: false, reason: 'unavailable' });

    await expect(
      service.assertProjectAccess(ORG_ID, VALID_PROJECT_ID)
    ).rejects.toBeInstanceOf(ProjectValidationUnavailableException);
  });

  it('caches a positive verdict without re-calling aisee-core', async () => {
    mocks.aiseeClient.getProduct.mockResolvedValue({
      ok: true,
      product: { id: VALID_PROJECT_ID, userId: OWNER_USER_ID, status: 'active' },
    });

    await service.assertProjectAccess(ORG_ID, VALID_PROJECT_ID);
    await service.assertProjectAccess(ORG_ID, VALID_PROJECT_ID);

    expect(mocks.aiseeClient.getProduct).toHaveBeenCalledTimes(1);
  });

  it('caches a negative verdict without re-calling aisee-core', async () => {
    mocks.aiseeClient.getProduct.mockResolvedValue({ ok: false, reason: 'not_found' });

    await expect(
      service.assertProjectAccess(ORG_ID, VALID_PROJECT_ID)
    ).rejects.toBeInstanceOf(ProjectNotFoundException);
    await expect(
      service.assertProjectAccess(ORG_ID, VALID_PROJECT_ID)
    ).rejects.toBeInstanceOf(ProjectNotFoundException);

    expect(mocks.aiseeClient.getProduct).toHaveBeenCalledTimes(1);
  });

  it('does not cache an unavailable verdict, so the next call retries', async () => {
    mocks.aiseeClient.getProduct.mockResolvedValue({ ok: false, reason: 'unavailable' });

    await expect(
      service.assertProjectAccess(ORG_ID, VALID_PROJECT_ID)
    ).rejects.toBeInstanceOf(ProjectValidationUnavailableException);
    await expect(
      service.assertProjectAccess(ORG_ID, VALID_PROJECT_ID)
    ).rejects.toBeInstanceOf(ProjectValidationUnavailableException);

    expect(mocks.aiseeClient.getProduct).toHaveBeenCalledTimes(2);
  });

  it('never trusts a client-supplied organization mapping — organizationId always drives resolveOwnerUserId', async () => {
    mocks.aiseeClient.getProduct.mockResolvedValue({
      ok: true,
      product: { id: VALID_PROJECT_ID, userId: OWNER_USER_ID, status: 'active' },
    });

    await service.assertProjectAccess(ORG_ID, VALID_PROJECT_ID);

    expect(mocks.aiseeCreditService.resolveOwnerUserId).toHaveBeenCalledWith(ORG_ID);
  });

  it('allows a read on a deactivated project — only actions are blocked', async () => {
    mocks.aiseeClient.getProduct.mockResolvedValue({
      ok: true,
      product: {
        id: VALID_PROJECT_ID,
        userId: OWNER_USER_ID,
        status: 'active',
        isActive: false,
      },
    });

    await expect(
      service.assertProjectAccess(ORG_ID, VALID_PROJECT_ID)
    ).resolves.toBeUndefined();
  });
});

describe('ProjectValidationService.assertProjectActive', () => {
  let mocks: ReturnType<typeof createMocks>;
  let service: ProjectValidationService;

  beforeEach(() => {
    mocks = createMocks();
    service = createService(mocks);
  });

  it('resolves when the project is owned and active', async () => {
    mocks.aiseeClient.getProduct.mockResolvedValue({
      ok: true,
      product: {
        id: VALID_PROJECT_ID,
        userId: OWNER_USER_ID,
        status: 'active',
        isActive: true,
      },
    });

    await expect(
      service.assertProjectActive(ORG_ID, VALID_PROJECT_ID)
    ).resolves.toBeUndefined();
  });

  it('throws ProjectInactiveException (403) when the project is deactivated', async () => {
    mocks.aiseeClient.getProduct.mockResolvedValue({
      ok: true,
      product: {
        id: VALID_PROJECT_ID,
        userId: OWNER_USER_ID,
        status: 'active',
        isActive: false,
      },
    });

    await expect(
      service.assertProjectActive(ORG_ID, VALID_PROJECT_ID)
    ).rejects.toBeInstanceOf(ProjectInactiveException);
  });

  it('still throws ProjectNotFoundException (404) for another org — inactivity never leaks existence', async () => {
    mocks.aiseeClient.getProduct.mockResolvedValue({
      ok: true,
      product: {
        id: VALID_PROJECT_ID,
        userId: 'someone-else',
        status: 'active',
        isActive: false,
      },
    });

    await expect(
      service.assertProjectActive(ORG_ID, VALID_PROJECT_ID)
    ).rejects.toBeInstanceOf(ProjectNotFoundException);
  });

  it('reuses the ownership lookup — checking activation costs no extra call', async () => {
    mocks.aiseeClient.getProduct.mockResolvedValue({
      ok: true,
      product: {
        id: VALID_PROJECT_ID,
        userId: OWNER_USER_ID,
        status: 'active',
        isActive: true,
      },
    });

    await service.assertProjectAccess(ORG_ID, VALID_PROJECT_ID);
    await service.assertProjectActive(ORG_ID, VALID_PROJECT_ID);

    expect(mocks.aiseeClient.getProduct).toHaveBeenCalledTimes(1);
  });
});

describe('ProjectValidationService.isProjectActive', () => {
  let mocks: ReturnType<typeof createMocks>;
  let service: ProjectValidationService;

  beforeEach(() => {
    mocks = createMocks();
    service = createService(mocks);
  });

  it('returns true for an owned, active project', async () => {
    mocks.aiseeClient.getProduct.mockResolvedValue({
      ok: true,
      product: {
        id: VALID_PROJECT_ID,
        userId: OWNER_USER_ID,
        status: 'active',
        isActive: true,
      },
    });

    await expect(
      service.isProjectActive(ORG_ID, VALID_PROJECT_ID)
    ).resolves.toBe(true);
  });

  it('returns false for a deactivated project instead of throwing', async () => {
    mocks.aiseeClient.getProduct.mockResolvedValue({
      ok: true,
      product: {
        id: VALID_PROJECT_ID,
        userId: OWNER_USER_ID,
        status: 'active',
        isActive: false,
      },
    });

    await expect(
      service.isProjectActive(ORG_ID, VALID_PROJECT_ID)
    ).resolves.toBe(false);
  });

  it('re-checks a deactivated project sooner than the positive TTL, so reactivation lands promptly', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(0);
    mocks.aiseeClient.getProduct.mockResolvedValue({
      ok: true,
      product: {
        id: VALID_PROJECT_ID,
        userId: OWNER_USER_ID,
        status: 'active',
        isActive: false,
      },
    });

    await service.isProjectActive(ORG_ID, VALID_PROJECT_ID);

    // Past the 30s negative TTL but still inside the 60s positive one: the
    // inactive verdict must have expired, not ridden the longer cache.
    nowSpy.mockReturnValue(45_000);
    mocks.aiseeClient.getProduct.mockResolvedValue({
      ok: true,
      product: {
        id: VALID_PROJECT_ID,
        userId: OWNER_USER_ID,
        status: 'active',
        isActive: true,
      },
    });

    await expect(
      service.isProjectActive(ORG_ID, VALID_PROJECT_ID)
    ).resolves.toBe(true);
    expect(mocks.aiseeClient.getProduct).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('returns false (fail closed) when aisee-core is unreachable', async () => {
    mocks.aiseeClient.getProduct.mockResolvedValue({
      ok: false,
      reason: 'unavailable',
    });

    await expect(
      service.isProjectActive(ORG_ID, VALID_PROJECT_ID)
    ).resolves.toBe(false);
  });
});

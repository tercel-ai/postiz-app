import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectValidationService } from './project-validation.service';
import {
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
});

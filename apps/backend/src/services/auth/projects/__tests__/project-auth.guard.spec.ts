import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectAuthGuard } from '../project-auth.guard';

const ORG_ID = 'org-1';
const PROJECT_ID = 'a1b2c3d4-e5f6-4789-9abc-def012345678';

function createMocks() {
  return {
    projectValidation: {
      assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      assertProjectActive: vi.fn().mockResolvedValue(undefined),
    },
    reflector: { get: vi.fn().mockReturnValue(undefined) },
  };
}

function createContext(
  request: Record<string, unknown>,
  handler: () => void = () => undefined
) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
  } as any;
}

describe('ProjectAuthGuard', () => {
  let mocks: ReturnType<typeof createMocks>;
  let guard: ProjectAuthGuard;

  beforeEach(() => {
    mocks = createMocks();
    guard = new ProjectAuthGuard(
      mocks.projectValidation as any,
      mocks.reflector as any
    );
  });

  it('no-ops when the request carries no projectId', async () => {
    const request = { method: 'POST', org: { id: ORG_ID }, params: {}, query: {} };

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(mocks.projectValidation.assertProjectAccess).not.toHaveBeenCalled();
    expect(mocks.projectValidation.assertProjectActive).not.toHaveBeenCalled();
  });

  it('checks ownership only on a GET — reads stay open on a deactivated project', async () => {
    const request = {
      method: 'GET',
      org: { id: ORG_ID },
      query: { projectId: PROJECT_ID },
    };

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(mocks.projectValidation.assertProjectAccess).toHaveBeenCalledWith(
      ORG_ID,
      PROJECT_ID
    );
    expect(mocks.projectValidation.assertProjectActive).not.toHaveBeenCalled();
  });

  it('requires an active project on a mutation', async () => {
    const request = {
      method: 'POST',
      org: { id: ORG_ID },
      body: { projectId: PROJECT_ID },
    };

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(mocks.projectValidation.assertProjectActive).toHaveBeenCalledWith(
      ORG_ID,
      PROJECT_ID
    );
    expect(mocks.projectValidation.assertProjectAccess).not.toHaveBeenCalled();
  });

  it.each(['PATCH', 'PUT', 'DELETE'])(
    'requires an active project on %s too',
    async (method) => {
      const request = {
        method,
        org: { id: ORG_ID },
        params: { projectId: PROJECT_ID },
      };

      await guard.canActivate(createContext(request));

      expect(mocks.projectValidation.assertProjectActive).toHaveBeenCalledWith(
        ORG_ID,
        PROJECT_ID
      );
    }
  );

  it('propagates the rejection when the project is deactivated', async () => {
    const inactive = new Error('Project is deactivated');
    mocks.projectValidation.assertProjectActive.mockRejectedValue(inactive);
    const request = {
      method: 'POST',
      org: { id: ORG_ID },
      body: { projectId: PROJECT_ID },
    };

    await expect(guard.canActivate(createContext(request))).rejects.toBe(inactive);
  });

  it('falls back to the ownership-only check when the route opts out', async () => {
    mocks.reflector.get.mockReturnValue(true);
    const request = {
      method: 'POST',
      org: { id: ORG_ID },
      body: { projectId: PROJECT_ID },
    };

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(mocks.projectValidation.assertProjectAccess).toHaveBeenCalledWith(
      ORG_ID,
      PROJECT_ID
    );
    expect(mocks.projectValidation.assertProjectActive).not.toHaveBeenCalled();
  });

  it('exposes the validated projectId on the request', async () => {
    const request: Record<string, unknown> = {
      method: 'POST',
      org: { id: ORG_ID },
      body: { projectId: PROJECT_ID },
    };

    await guard.canActivate(createContext(request));

    expect(request.projectId).toBe(PROJECT_ID);
  });
});

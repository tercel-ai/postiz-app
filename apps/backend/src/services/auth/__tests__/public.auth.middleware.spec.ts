import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PublicAuthMiddleware } from '../public.auth.middleware';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockOrganizationService() {
  return {
    getOrgByApiKey: vi.fn(),
  };
}

function createMockReq(headers: Record<string, string> = {}) {
  return { headers, cookies: {} } as any;
}

function createMockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PublicAuthMiddleware', () => {
  let orgService: ReturnType<typeof createMockOrganizationService>;
  let middleware: PublicAuthMiddleware;
  const originalStripeKey = process.env.STRIPE_SECRET_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.STRIPE_SECRET_KEY;
    orgService = createMockOrganizationService();
    middleware = new PublicAuthMiddleware(orgService as any);
  });

  afterEach(() => {
    if (originalStripeKey !== undefined) {
      process.env.STRIPE_SECRET_KEY = originalStripeKey;
    } else {
      delete process.env.STRIPE_SECRET_KEY;
    }
  });

  it('sets req.user from org owner userId', async () => {
    orgService.getOrgByApiKey.mockResolvedValue({
      id: 'org-1',
      users: [{ userId: 'user-owner', role: 'SUPERADMIN' }],
    });
    const req = createMockReq({ authorization: 'test-api-key' });
    const next = vi.fn();

    await middleware.use(req, createMockRes(), next);

    expect(req.user).toEqual({ id: 'user-owner' });
    expect(next).toHaveBeenCalled();
  });

  it('sets req.org with SUPERADMIN role override', async () => {
    orgService.getOrgByApiKey.mockResolvedValue({
      id: 'org-1',
      users: [{ userId: 'user-1', role: 'USER' }],
    });
    const req = createMockReq({ authorization: 'key' });

    await middleware.use(req, createMockRes(), vi.fn());

    expect(req.org.users).toEqual([{ users: { role: 'SUPERADMIN' } }]);
  });

  it('does not set req.user when org has no users', async () => {
    orgService.getOrgByApiKey.mockResolvedValue({
      id: 'org-1',
      users: [],
    });
    const req = createMockReq({ authorization: 'key' });

    await middleware.use(req, createMockRes(), vi.fn());

    expect(req.user).toBeUndefined();
  });

  it('returns 401 when no authorization header', async () => {
    const req = createMockReq({});
    const res = createMockRes();

    await middleware.use(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ msg: 'No API Key found' });
  });

  it('returns 401 when API key is invalid', async () => {
    orgService.getOrgByApiKey.mockResolvedValue(null);
    const res = createMockRes();

    await middleware.use(createMockReq({ authorization: 'bad' }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ msg: 'Invalid API key' });
  });

  it('returns 401 when Stripe is configured but org has no subscription', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    orgService.getOrgByApiKey.mockResolvedValue({
      id: 'org-1',
      users: [{ userId: 'u1', role: 'SUPERADMIN' }],
      subscription: null,
    });
    const res = createMockRes();

    await middleware.use(createMockReq({ authorization: 'key' }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ msg: 'No subscription found' });
  });
});

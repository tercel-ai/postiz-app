import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AiseeClient } from './aisee.client';

/**
 * getProduct field mapping — in particular `is_active`, aisee-core's operational
 * activation switch. A missing field must read as active so a postiz deploy that
 * lands before the aisee-core one does not silently freeze every project.
 */
describe('AiseeClient.getProduct field mapping', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.AISEE_ORCHESTRATOR_URL = 'http://aisee.test';
    process.env.JWT_SECRET = 'test-secret';
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  function stubFetch(payload: Record<string, unknown>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }))
    );
  }

  it('maps is_active: true -> isActive: true', async () => {
    stubFetch({ id: 'p1', user_id: 'u1', status: 'completed', is_active: true });

    const res = await new AiseeClient().getProduct('p1');

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.product.isActive).toBe(true);
      expect(res.product.userId).toBe('u1');
    }
  });

  it('maps is_active: false -> isActive: false', async () => {
    stubFetch({ id: 'p1', user_id: 'u1', status: 'completed', is_active: false });

    const res = await new AiseeClient().getProduct('p1');

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.product.isActive).toBe(false);
    }
  });

  it('defaults to active when aisee-core omits is_active (older core)', async () => {
    stubFetch({ id: 'p1', user_id: 'u1', status: 'completed' });

    const res = await new AiseeClient().getProduct('p1');

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.product.isActive).toBe(true);
    }
  });
});

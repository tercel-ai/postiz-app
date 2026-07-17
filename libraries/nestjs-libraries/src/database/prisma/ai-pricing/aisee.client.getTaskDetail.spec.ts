import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AiseeClient } from './aisee.client';

/**
 * getTaskDetail field mapping — in particular the `version` provenance field,
 * which the aisee payload carries as `version_name` (e.g. "12.0", the analysis
 * revision). It maps to OperationPlan.sourceTaskVersion (audit only; unrelated
 * to Engage). Regression guard for the null-sourceTaskVersion bug.
 */
describe('AiseeClient.getTaskDetail field mapping', () => {
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

  it('maps version_name -> version when version/task_version are absent', async () => {
    stubFetch({
      id: 't1',
      user_id: 'u1',
      product_id: 'p1',
      status: 'completed',
      result: { summary: 'x' },
      product_snapshot: { keywords: [] },
      url: 'https://x',
      version_name: '12.0',
    });

    const res = await new AiseeClient().getTaskDetail('t1');

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.task.version).toBe('12.0');
      expect(res.task.productId).toBe('p1');
    }
  });

  it('prefers an explicit version over version_name', async () => {
    stubFetch({
      id: 't1',
      user_id: 'u1',
      product_id: 'p1',
      status: 'completed',
      result: {},
      product_snapshot: {},
      version: 'v9',
      version_name: '12.0',
    });

    const res = await new AiseeClient().getTaskDetail('t1');
    if (res.ok) expect(res.task.version).toBe('v9');
  });
});

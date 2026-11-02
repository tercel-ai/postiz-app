import { beforeEach, expect, it, vi } from 'vitest';
const quota = vi.hoisted(() => ({ resolve: vi.fn(), baseline: vi.fn() }));
vi.mock('../libraries/nestjs-libraries/src/extension/send-quota.service', () => ({ SendQuotaService: class { resolve = quota.resolve; baseline = quota.baseline; } }));
import { diagnoseSendQuota } from './diagnose-send-quota';
beforeEach(() => vi.clearAllMocks());
it('distinguishes enforced exhausted quotas from observation-only budgets without writing', async () => {
  const budget = { key: 'bucket', limit: 2, units: 1, scope: 'ACCOUNT', dimension: 'REPLY_WRITES' };
  quota.resolve.mockResolvedValue({ budgets: [budget, { ...budget, key: 'observe', enforce: false }] });
  quota.baseline.mockResolvedValue({ confirmedUnits: 2, heldUnits: 0 });
  const db = { sendExecution: { findUnique: vi.fn(async () => ({ organizationId: 'org', canonicalAccountKey: 'actor', intent: {}, createdAt: new Date() })) },
    accountWriteState: { findUnique: vi.fn(async () => ({ timezone: 'UTC' })) },
    sendQuotaBucket: { findUnique: vi.fn(async () => null) } };
  const result = await diagnoseSendQuota(db as any, 'attempt');
  expect(result.budgets.map(row => row.exhausted)).toEqual([true, false]);
  expect(result.budgets[0].source).toBe('HISTORICAL_BASELINE');
});
it('uses the existing ledger instead of recounting history', async () => {
  quota.resolve.mockResolvedValue({ budgets: [{ key: 'bucket', limit: 5, units: 1 }] });
  const db = { sendExecution: { findUnique: vi.fn(async () => ({ organizationId: 'org', intent: {}, createdAt: new Date() })) },
    accountWriteState: { findUnique: vi.fn(async () => ({})) }, sendQuotaBucket: { findUnique: vi.fn(async () => ({ id: 'bucket', confirmedUnits: 2, heldUnits: 3 })) },
    sendQuotaReservation: { findMany: vi.fn(async () => [{ executionId: 'held', segmentIndex: 0, units: 1, execution: { status: 'RECONCILING', segments: [{ segmentIndex: 0, status: 'UNKNOWN' }] } }]) } };
  expect((await diagnoseSendQuota(db as any, 'attempt')).budgets[0]).toMatchObject({ source: 'LEDGER', exhausted: true });
  expect(quota.baseline).not.toHaveBeenCalled();
  expect((await diagnoseSendQuota(db as any, 'attempt')).budgets[0].holds[0]).toMatchObject({ executionId: 'held', segment: { status: 'UNKNOWN' } });
});

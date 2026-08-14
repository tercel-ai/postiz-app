import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { AiseeCreditService } from './aisee-credit.service';
import { AiseeBusinessType, AiseeCostItem } from './aisee.client';

/**
 * `taskId` is unique on BillingRecord and, for callers that derive it from the
 * billed entity, it is the ONLY thing standing between a replayed call and a
 * double charge. Post overage does exactly that
 * (`postiz_post_overage_<postId>`): every re-save of the same post calls back
 * in with the same taskId. Production logged a stream of
 * "Unique constraint failed on the fields: (`taskId`)" — the create failed, was
 * logged, and the flow charged Aisee AGAIN with no local record.
 */
const COST_ITEMS: AiseeCostItem[] = [
  {
    type: 'text',
    amount: '25.000000',
    model: 'post_send',
    billing_mode: 'per_token',
    quantity: 0,
  },
];

const TASK_ID = 'postiz_post_overage_post-1';

function duplicateTaskIdError() {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`taskId`)',
    { code: 'P2002', clientVersion: '5.0.0', meta: { target: ['taskId'] } }
  );
}

function createService(
  existing: { id: string; status: string; transactionId?: string | null; costItems?: string } | null
) {
  const billingRecordModel = {
    create: vi.fn().mockRejectedValue(duplicateTaskIdError()),
    findUnique: vi.fn().mockResolvedValue(existing),
    update: vi.fn().mockImplementation(async ({ where }: any) => ({ id: where.id })),
  };
  const aiseeClient = {
    deductCredits: vi.fn().mockResolvedValue({
      success: true,
      transactionId: 'tx-1',
    }),
    confirmDeduction: vi.fn().mockResolvedValue({ success: true }),
  };
  const service = new AiseeCreditService(
    aiseeClient as any,
    {} as any,
    { model: { billingRecord: billingRecordModel } } as any,
    {
      model: {
        userOrganization: { findFirst: vi.fn().mockResolvedValue({ userId: 'user-1' }) },
      },
    } as any
  );
  return { service, billingRecordModel, aiseeClient };
}

describe('AiseeCreditService — duplicate taskId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['pending', 'success', 'skipped', 'internal'])(
    'skips the deduction when a %s record already exists for the task',
    async (status) => {
      const { service, aiseeClient } = createService({ id: 'rec-1', status });

      const result = await service.deductAndConfirm({
        userId: 'org-1',
        taskId: TASK_ID,
        businessType: AiseeBusinessType.POST_OVERAGE,
        description: 'Post overage',
        costItems: COST_ITEMS,
      });

      expect(result).toEqual({ success: true, skipped: true });
      expect(aiseeClient.deductCredits).not.toHaveBeenCalled();
      expect(aiseeClient.confirmDeduction).not.toHaveBeenCalled();
    }
  );

  // No money moved on a `failed` row, so the retry must go through — and reuse
  // the existing row rather than orphaning it.
  it('retries the deduction when the previous attempt failed', async () => {
    const { service, billingRecordModel, aiseeClient } = createService({
      id: 'rec-1',
      status: 'failed',
    });

    const result = await service.deductAndConfirm({
      userId: 'org-1',
      taskId: TASK_ID,
      businessType: AiseeBusinessType.POST_OVERAGE,
      description: 'Post overage',
      costItems: COST_ITEMS,
    });

    expect(result.success).toBe(true);
    expect(aiseeClient.deductCredits).toHaveBeenCalledOnce();
    expect(billingRecordModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rec-1' },
        data: expect.objectContaining({ status: 'pending', error: null }),
      })
    );
  });

  // Row gone / read failed: unknown state, so take the side that cannot
  // double-charge.
  it('skips the deduction when the existing record cannot be read', async () => {
    const { service, aiseeClient } = createService(null);

    const result = await service.deductAndConfirm({
      userId: 'org-1',
      taskId: TASK_ID,
      businessType: AiseeBusinessType.POST_OVERAGE,
      description: 'Post overage',
      costItems: COST_ITEMS,
    });

    expect(result).toEqual({ success: true, skipped: true });
    expect(aiseeClient.deductCredits).not.toHaveBeenCalled();
  });

  // A DB outage is NOT a duplicate — delivered work still has to be billed.
  it('still charges when the create fails for a non-uniqueness reason', async () => {
    const { service, billingRecordModel, aiseeClient } = createService(null);
    billingRecordModel.create.mockRejectedValue(new Error('connection reset'));

    const result = await service.deductAndConfirm({
      userId: 'org-1',
      taskId: TASK_ID,
      businessType: AiseeBusinessType.POST_OVERAGE,
      description: 'Post overage',
      costItems: COST_ITEMS,
    });

    expect(result.success).toBe(true);
    expect(aiseeClient.deductCredits).toHaveBeenCalledOnce();
    expect(billingRecordModel.findUnique).not.toHaveBeenCalled();
  });
});

/**
 * The retry path. `reconcileAwaitedDeduction` is only ever reached for a row
 * that exists with NO transactionId — i.e. the charge provably never completed
 * (a crash or a DB error between the create and the Aisee call). Its whole job
 * is to charge it now. The conservative duplicate default is exactly wrong
 * here: it would classify that `pending` row as already billed, return a
 * skipped response, and — because the caller (operation-plan `_reconcilePending`)
 * treats skipped as success — promote the plan to READY, materialize its posts,
 * and leave the taskId permanently occupied so nothing could ever bill it.
 */
describe('AiseeCreditService.reconcileAwaitedDeduction — retrying an unbilled task', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const RECONCILE_OPTS = {
    userId: 'org-1',
    taskId: 'operation_plan:plan-1',
    businessType: AiseeBusinessType.OPERATION_PLAN,
    description: 'Generate operation plan',
  };

  it('charges a pending row instead of reporting it as already billed', async () => {
    const { service, billingRecordModel, aiseeClient } = createService({
      id: 'rec-1',
      status: 'pending',
      transactionId: null,
      costItems: JSON.stringify(COST_ITEMS),
    });

    const result = await service.reconcileAwaitedDeduction(RECONCILE_OPTS);

    expect(aiseeClient.deductCredits).toHaveBeenCalledOnce();
    expect(result?.deduction).toEqual(
      expect.objectContaining({ success: true, transactionId: 'tx-1' })
    );
    expect(result?.deduction.skipped).toBeUndefined();
    // The existing row is reused, not orphaned.
    expect(billingRecordModel.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rec-1' } })
    );
  });

  it('still charges when the duplicate row cannot be read back', async () => {
    const { service, billingRecordModel, aiseeClient } = createService({
      id: 'rec-1',
      status: 'pending',
      transactionId: null,
      costItems: JSON.stringify(COST_ITEMS),
    });
    // First read (reconcileAwaitedDeduction's own lookup) succeeds; the second
    // one — inside the duplicate handler — fails.
    billingRecordModel.findUnique
      .mockResolvedValueOnce({
        id: 'rec-1',
        status: 'pending',
        transactionId: null,
        costItems: JSON.stringify(COST_ITEMS),
      })
      .mockRejectedValueOnce(new Error('connection reset'));

    const result = await service.reconcileAwaitedDeduction(RECONCILE_OPTS);

    expect(aiseeClient.deductCredits).toHaveBeenCalledOnce();
    expect(result?.deduction.success).toBe(true);
  });

  it.each(['success', 'skipped', 'internal'])(
    'does NOT re-charge a %s row',
    async (status) => {
      const { service, aiseeClient } = createService({
        id: 'rec-1',
        status,
        transactionId: null,
        costItems: JSON.stringify(COST_ITEMS),
      });

      const result = await service.reconcileAwaitedDeduction(RECONCILE_OPTS);

      expect(aiseeClient.deductCredits).not.toHaveBeenCalled();
      expect(result?.deduction).toEqual({ success: true, skipped: true });
    }
  );

  it('confirms instead of re-deducting when the row already has a transactionId', async () => {
    const { service, aiseeClient } = createService({
      id: 'rec-1',
      status: 'success',
      transactionId: 'tx-existing',
      costItems: JSON.stringify(COST_ITEMS),
    });

    const result = await service.reconcileAwaitedDeduction(RECONCILE_OPTS);

    expect(aiseeClient.deductCredits).not.toHaveBeenCalled();
    expect(aiseeClient.confirmDeduction).toHaveBeenCalledWith({
      taskId: RECONCILE_OPTS.taskId,
      status: 'success',
    });
    expect(result?.deduction.transactionId).toBe('tx-existing');
  });

  // The default (non-retry) callers must keep the conservative behaviour: a
  // post re-saved while a sibling charge is in flight must not be charged twice.
  it('leaves the default duplicate policy untouched for non-retry callers', async () => {
    const { service, aiseeClient } = createService({ id: 'rec-1', status: 'pending' });

    const result = await service.deductAndConfirm({
      userId: 'org-1',
      taskId: TASK_ID,
      businessType: AiseeBusinessType.POST_OVERAGE,
      description: 'Post overage',
      costItems: COST_ITEMS,
    });

    expect(result).toEqual({ success: true, skipped: true });
    expect(aiseeClient.deductCredits).not.toHaveBeenCalled();
  });
});

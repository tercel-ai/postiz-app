import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AiseeCreditService, ACCRUING_STATUS } from './aisee-credit.service';
import { AiseeBusinessType, AiseeBusinessSubType } from './aisee.client';
import { AiUsageInfo } from '@gitroom/nestjs-libraries/openai/openai.service';

/**
 * Accrual exists because /copilot/chat is driven by CopilotTextarea
 * autosuggestions, which fire on every typing pause. Charging per request would
 * put a ledger row and two aisee-core round-trips behind every pause. These
 * tests pin the two things that make deferral safe: nothing is charged twice,
 * and nothing is silently dropped.
 */

const ORG = 'org-1';
const STREAM = `copilot_chat_${ORG}`;

function usage(promptTokens: number, completionTokens: number): AiUsageInfo {
  return {
    servicer: 'openrouter',
    provider: 'openai',
    model: 'gpt-4.1',
    type: 'text',
    billing_mode: 'per_token',
    method: 'copilot_chat',
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

type Row = Record<string, any>;

/** In-memory BillingRecord store with the unique-taskId behaviour that matters. */
function createStore() {
  const rows: Row[] = [];
  let nextId = 1;

  const model = {
    create: vi.fn(async ({ data }: any) => {
      const row = { id: `rec-${nextId++}`, createdAt: new Date(), ...data };
      rows.push(row);
      return row;
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      return (
        rows.find((r) =>
          where.id ? r.id === where.id : r.taskId === where.taskId
        ) ?? null
      );
    }),
    findMany: vi.fn(async ({ where }: any) => {
      return rows.filter((r) => {
        if (where.organizationId && r.organizationId !== where.organizationId)
          return false;
        if (where.status && r.status !== where.status) return false;
        const t = where.taskId;
        if (t?.startsWith && !r.taskId.startsWith(t.startsWith)) return false;
        if (t?.not && r.taskId === t.not) return false;
        return true;
      });
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = rows.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const matched = rows.filter(
        (r) => r.id === where.id && (!where.status || r.status === where.status)
      );
      matched.forEach((r) => Object.assign(r, data));
      return { count: matched.length };
    }),
  };

  return { rows, model };
}

function createService(opts?: { deductFails?: boolean; pricingFails?: boolean }) {
  const store = createStore();

  const aiseeClient = {
    deductCredits: vi.fn(async () =>
      opts?.deductFails
        ? { success: false, error: 'boom' }
        : { success: true, transactionId: 'tx-1', remainingBalance: '100' }
    ),
    confirmDeduction: vi.fn(async () => ({ success: true })),
  };

  // 0.0015 credits per output token, 0.000375 per input token — the shipped
  // text pricing, so the amounts below are the real ones.
  const aiPricingService = {
    calculateCost: vi.fn(async (u: AiUsageInfo) => ({
      servicer: u.servicer,
      provider: u.provider,
      model: u.model,
      type: u.type,
      billingMode: 'per_token' as const,
      price: '0.0015',
      quantity: u.usage.total_tokens,
      cost: opts?.pricingFails
        ? 0
        : u.usage.prompt_tokens * 0.000375 + u.usage.completion_tokens * 0.0015,
      pricingFound: !opts?.pricingFails,
    })),
  };

  const service = new AiseeCreditService(
    aiseeClient as any,
    aiPricingService as any,
    { model: { billingRecord: store.model } } as any,
    {
      model: {
        userOrganization: {
          findFirst: vi.fn().mockResolvedValue({ userId: 'user-1' }),
        },
      },
    } as any,
    {
      model: {
        $transaction: vi.fn(async (fn: any) =>
          fn({ billingRecord: store.model })
        ),
      },
    } as any
  );

  return { service, store, aiseeClient, aiPricingService };
}

const BASE_OPTS = {
  userId: ORG,
  streamKey: STREAM,
  businessType: AiseeBusinessType.AI_COPYWRITING,
  subType: AiseeBusinessSubType.CHAT,
  description: 'Copilot editor assistant / autosuggestions',
};

describe('AiseeCreditService.accrueCollectedUsages', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T10:30:00Z'));
    delete process.env.BILL_TYPE;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.BILL_TYPE;
  });

  it('creates one accruing row per UTC hour window and charges nothing', async () => {
    const { service, store, aiseeClient } = createService();

    await service.accrueCollectedUsages(BASE_OPTS, [usage(100, 100)], 5);

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      organizationId: ORG,
      taskId: `postiz_${STREAM}_2026092810`,
      status: ACCRUING_STATUS,
      businessType: AiseeBusinessType.AI_COPYWRITING,
    });
    expect(aiseeClient.deductCredits).not.toHaveBeenCalled();
  });

  it('sums into the same row within the window instead of adding rows', async () => {
    const { service, store, aiseeClient } = createService();

    await service.accrueCollectedUsages(BASE_OPTS, [usage(100, 100)], 5);
    await service.accrueCollectedUsages(BASE_OPTS, [usage(100, 100)], 5);
    await service.accrueCollectedUsages(BASE_OPTS, [usage(100, 100)], 5);

    expect(store.rows).toHaveLength(1);
    // 3 × (100 × 0.000375 + 100 × 0.0015) = 3 × 0.1875
    expect(parseFloat(store.rows[0].amount)).toBeCloseTo(0.5625, 6);
    expect(store.rows[0].data.accruedCalls).toBe(3);
    expect(aiseeClient.deductCredits).not.toHaveBeenCalled();
  });

  it('merges cost items by type+model+billing_mode rather than appending', async () => {
    const { service, store } = createService();

    for (let i = 0; i < 4; i++) {
      await service.accrueCollectedUsages(BASE_OPTS, [usage(10, 10)], 5);
    }

    const items = JSON.parse(store.rows[0].costItems);
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(80); // 4 × 20 total_tokens
  });

  it('charges immediately once the accrued total reaches the threshold', async () => {
    const { service, store, aiseeClient } = createService();

    // 0.1875 credits per call — 6 calls clears a 1-credit threshold.
    for (let i = 0; i < 6; i++) {
      await service.accrueCollectedUsages(BASE_OPTS, [usage(100, 100)], 1);
    }

    expect(aiseeClient.deductCredits).toHaveBeenCalledTimes(1);
    expect(parseFloat(aiseeClient.deductCredits.mock.calls[0][0].amount)).toBeCloseTo(
      1.125,
      6
    );
    expect(store.rows[0].status).toBe('success');
    expect(store.rows[0].transactionId).toBe('tx-1');
    expect(aiseeClient.confirmDeduction).toHaveBeenCalledWith({
      taskId: `postiz_${STREAM}_2026092810`,
      status: 'success',
    });
  });

  it('settles the previous window when a request arrives in a newer one', async () => {
    const { service, store, aiseeClient } = createService();

    await service.accrueCollectedUsages(BASE_OPTS, [usage(100, 100)], 5);
    expect(aiseeClient.deductCredits).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-09-28T11:05:00Z'));
    await service.accrueCollectedUsages(BASE_OPTS, [usage(100, 100)], 5);

    expect(aiseeClient.deductCredits).toHaveBeenCalledTimes(1);
    expect(aiseeClient.deductCredits.mock.calls[0][0].taskId).toBe(
      `postiz_${STREAM}_2026092810`
    );

    const [old, current] = store.rows;
    expect(old.status).toBe('success');
    expect(current.taskId).toBe(`postiz_${STREAM}_2026092811`);
    expect(current.status).toBe(ACCRUING_STATUS);
  });

  it('never charges the same window twice', async () => {
    const { service, store, aiseeClient } = createService();

    for (let i = 0; i < 6; i++) {
      await service.accrueCollectedUsages(BASE_OPTS, [usage(100, 100)], 1);
    }
    expect(aiseeClient.deductCredits).toHaveBeenCalledTimes(1);

    // The row is settled now; further accrual must not reopen it, and moving to
    // the next window must not re-settle it.
    await service.accrueCollectedUsages(BASE_OPTS, [usage(100, 100)], 1);
    vi.setSystemTime(new Date('2026-09-28T11:05:00Z'));
    await service.accrueCollectedUsages(BASE_OPTS, [usage(100, 100)], 5);

    expect(aiseeClient.deductCredits).toHaveBeenCalledTimes(1);
    expect(store.rows.filter((r) => r.status === 'success')).toHaveLength(1);
  });

  it('scopes stale-window settlement to the same org and stream', async () => {
    const { service, store, aiseeClient } = createService();

    await service.accrueCollectedUsages(BASE_OPTS, [usage(100, 100)], 5);
    // Another org's window in the same hour.
    await service.accrueCollectedUsages(
      { ...BASE_OPTS, userId: 'org-2', streamKey: 'copilot_chat_org-2' },
      [usage(100, 100)],
      5
    );

    vi.setSystemTime(new Date('2026-09-28T11:05:00Z'));
    await service.accrueCollectedUsages(BASE_OPTS, [usage(100, 100)], 5);

    expect(aiseeClient.deductCredits).toHaveBeenCalledTimes(1);
    expect(aiseeClient.deductCredits.mock.calls[0][0].taskId).toBe(
      `postiz_${STREAM}_2026092810`
    );
    // org-2's row is untouched.
    expect(
      store.rows.find((r) => r.organizationId === 'org-2').status
    ).toBe(ACCRUING_STATUS);
  });

  it('leaves the row at pending when the deduction fails, for retry', async () => {
    const { service, store, aiseeClient } = createService({ deductFails: true });

    for (let i = 0; i < 6; i++) {
      await service.accrueCollectedUsages(BASE_OPTS, [usage(100, 100)], 1);
    }

    expect(aiseeClient.deductCredits).toHaveBeenCalledTimes(1);
    expect(store.rows[0].status).toBe('failed');
    expect(store.rows[0].error).toBe('boom');
    expect(aiseeClient.confirmDeduction).not.toHaveBeenCalled();
  });

  it('applies the minimum charge when tokens came back as zero', async () => {
    const { service, store } = createService();

    await service.accrueCollectedUsages(BASE_OPTS, [usage(0, 0), usage(0, 0)], 5);

    // 0.01 credits per untracked call, same floor the direct path uses.
    expect(parseFloat(store.rows[0].amount)).toBeCloseTo(0.02, 6);
  });

  it('does nothing when there are no usages', async () => {
    const { service, store, aiseeClient } = createService();

    await service.accrueCollectedUsages(BASE_OPTS, [], 5);

    expect(store.rows).toHaveLength(0);
    expect(aiseeClient.deductCredits).not.toHaveBeenCalled();
  });

  it('counts calls per requestType so autosuggest is separable from chat', async () => {
    const { service, store } = createService();

    await service.accrueCollectedUsages(
      { ...BASE_OPTS, data: { requestType: 'TextareaCompletion' } },
      [usage(10, 10)],
      5
    );
    await service.accrueCollectedUsages(
      { ...BASE_OPTS, data: { requestType: 'TextareaCompletion' } },
      [usage(10, 10)],
      5
    );
    await service.accrueCollectedUsages(
      { ...BASE_OPTS, data: { requestType: 'Chat' } },
      [usage(10, 10)],
      5
    );

    expect(store.rows[0].data.byRequestType).toEqual({
      TextareaCompletion: 2,
      Chat: 1,
    });
    expect(store.rows[0].data.accruedCalls).toBe(3);
  });

  it('counts real calls, not priced line items', async () => {
    // When pricing cannot resolve, usagesToCostItems collapses N calls into ONE
    // minimum-charge item whose amount already covers all N. The call counter
    // must still say N — it is what tells anyone reading the ledger how much of
    // the spend was autosuggestion noise.
    const { service, store } = createService({ pricingFails: true });

    await service.accrueCollectedUsages(
      { ...BASE_OPTS, data: { requestType: 'TextareaCompletion' } },
      [usage(100, 100), usage(100, 100), usage(100, 100)],
      5
    );

    expect(store.rows[0].data.accruedCalls).toBe(3);
    expect(store.rows[0].data.byRequestType).toEqual({ TextareaCompletion: 3 });
    // The amount is the floor charge for all three, on one line item.
    expect(parseFloat(store.rows[0].amount)).toBeCloseTo(0.03, 6);
    expect(JSON.parse(store.rows[0].costItems)).toHaveLength(1);
  });

  it('skips the Aisee call under BILL_TYPE=internal', async () => {
    process.env.BILL_TYPE = 'internal';
    const { service, store, aiseeClient } = createService();

    for (let i = 0; i < 6; i++) {
      await service.accrueCollectedUsages(BASE_OPTS, [usage(100, 100)], 1);
    }

    expect(aiseeClient.deductCredits).not.toHaveBeenCalled();
    expect(store.rows[0].status).toBe('internal');
  });

  it('sends the accrued cost_items and org owner to Aisee on settle', async () => {
    const { service, aiseeClient } = createService();

    for (let i = 0; i < 6; i++) {
      await service.accrueCollectedUsages(
        { ...BASE_OPTS, data: { requestType: 'Chat', surface: 'copilot_chat' } },
        [usage(100, 100)],
        1
      );
    }

    const call = aiseeClient.deductCredits.mock.calls[0][0];
    expect(call.userId).toBe('user-1'); // resolved owner, not the org id
    expect(call.channel).toBe('postiz');
    expect(call.data.business_type).toBe(AiseeBusinessType.AI_COPYWRITING);
    expect(call.data.sub_type).toBe(AiseeBusinessSubType.CHAT);
    expect(call.data.cost_items).toHaveLength(1);
    expect(call.data.accruedCalls).toBe(6);
    expect(call.data.surface).toBe('copilot_chat');
  });
});

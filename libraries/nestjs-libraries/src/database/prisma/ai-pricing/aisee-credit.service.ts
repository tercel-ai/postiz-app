import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AiseeClient,
  AiseeBusinessType,
  deriveTokenColumns,
  AiseeBusinessSubType,
  AiseeCostItem,
  AiseeCreditBalance,
  AiseeDeductResponse,
} from './aisee.client';
import { AiPricingService, AiCostResult } from './ai-pricing.service';
import { AiUsageInfo } from '@gitroom/nestjs-libraries/openai/openai.service';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { isInternalBilling } from '@gitroom/nestjs-libraries/services/billing.helper';

/**
 * A BillingRecord still accumulating cost that has NOT been charged yet.
 *
 * Deliberately distinct from `pending` ("row created, Aisee call not yet made"),
 * which /admin/billing/summary counts as actionRequired and which flips its
 * `healthy` flag. An accruing row is the normal steady state of an accrual
 * stream, not a stuck charge, so it must not trip that alarm.
 */
export const ACCRUING_STATUS = 'accruing';

/** Postgres serialization failure — the retryable outcome of a SERIALIZABLE conflict. */
const SERIALIZATION_FAILURE_CODE = 'P2034';

/**
 * Prisma errors that mean the SCHEMA is wrong, not that the database blipped.
 *   P2021 — table does not exist
 *   P2022 — column does not exist
 * These are not worth charging past: they persist for every request until a
 * migration runs, so treating one as a transient write failure would charge every
 * caller while writing no audit row at all.
 *
 * P2010 ("raw query failed") is deliberately NOT here. It cannot reach this catch
 * — the create goes through Prisma's query builder, not `$queryRaw` — and it
 * carries transient Postgres codes (deadlock 40P01, serialization 40001,
 * statement timeout 57014), so listing it would only risk refusing a charge that
 * a retry would have completed.
 */
const STRUCTURAL_DB_ERROR_CODES = new Set(['P2021', 'P2022']);

export interface AiseeCreditExecOptions {
  userId: string;
  taskId: string;
  businessType: AiseeBusinessType;
  description: string;
  /** Optional related entity ID for business context (e.g. post ID, media ID) */
  relatedId?: string;
  /** Fine-grained sub-type within businessType (e.g. chat, post_gen, image) */
  subType?: AiseeBusinessSubType;
  /** Flexible business context (prompt, generation params, etc.) */
  data?: Record<string, unknown>;
}

export interface AiseeCreditExecResult<T> {
  result: T;
  costItems: AiseeCostItem[];
  deduction: AiseeDeductResponse | null;
}

/**
 * Orchestrates the full credit lifecycle for AI operations:
 *
 *   1. getBalance()        — soft check, reject if balance <= 0
 *   2. execute LLM call    — if it fails, stop here (zero cost)
 *   3. calculateCost()     — determine amount from AI usage
 *   4. create BillingRecord — local audit row (status=pending), id sent to Aisee
 *   5. deductCredits()     — atomic deduction on Aisee (one txn per post, with cost_items breakdown)
 *   6. update BillingRecord — set status + transactionId from Aisee response
 *   7. confirmDeduction()  — fire-and-forget delivery receipt
 */
@Injectable()
export class AiseeCreditService {
  private readonly logger = new Logger(AiseeCreditService.name);

  constructor(
    private readonly aiseeClient: AiseeClient,
    private readonly aiPricingService: AiPricingService,
    private readonly _billingRecord: PrismaRepository<'billingRecord'>,
    private readonly _userOrganization: PrismaRepository<'userOrganization'>,
    private readonly _tx: PrismaTransaction
  ) {}

  // Short-lived cache: orgId → userId (avoids double DB query per billing flow)
  private _ownerCache = new Map<string, { userId: string; expiresAt: number }>();

  /**
   * Infer a default sub-type from businessType if missing.
   * Ensures backward compatibility and consistent analytics in Aisee.
   */
  static inferSubType(
    businessType: AiseeBusinessType,
    providedSubType?: AiseeBusinessSubType
  ): AiseeBusinessSubType | undefined {
    return (
      providedSubType ||
      (businessType === AiseeBusinessType.IMAGE_GEN
        ? AiseeBusinessSubType.IMAGE
        : businessType === AiseeBusinessType.VIDEO_GEN
        ? AiseeBusinessSubType.VIDEO
        : businessType === AiseeBusinessType.AI_COPYWRITING
        ? AiseeBusinessSubType.CHAT
        : undefined)
    );
  }

  /**
   * Resolve the Aisee transaction `channel` (business-module attribution) for a
   * deduction. Engage consumption is tagged 'engage' so it can be distinguished
   * from post consumption ('postiz') in the aisee-core transactions ledger:
   *   - ENGAGE_REPLY                              → engage
   *   - POST_OVERAGE with data.source === 'engage' → engage (overage on an engage post)
   *   - everything else                            → postiz
   */
  static resolveChannel(
    businessType: AiseeBusinessType,
    data?: Record<string, unknown>
  ): string {
    if (businessType === AiseeBusinessType.ENGAGE_REPLY) {
      return AiseeClient.ENGAGE_CHANNEL;
    }
    if (
      businessType === AiseeBusinessType.POST_OVERAGE &&
      data?.source === 'engage'
    ) {
      return AiseeClient.ENGAGE_CHANNEL;
    }
    return AiseeClient.CHANNEL;
  }

  /**
   * Resolve the owner (SUPERADMIN or ADMIN) user ID for an organization.
   * Aisee bills by user, not by organization.
   * Cached for 5 minutes to avoid repeated DB lookups within a single flow.
   */
  async resolveOwnerUserId(organizationId: string): Promise<string> {
    const cached = this._ownerCache.get(organizationId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.userId;
    }
    // Prefer SUPERADMIN over ADMIN
    const owner =
      (await this._userOrganization.model.userOrganization.findFirst({
        where: { organizationId, role: 'SUPERADMIN', disabled: false },
        select: { userId: true },
      })) ||
      (await this._userOrganization.model.userOrganization.findFirst({
        where: { organizationId, role: 'ADMIN', disabled: false },
        select: { userId: true },
      }));

    if (!owner) {
      this.logger.warn(
        `No owner found for org=${organizationId}, falling back to orgId`
      );
      return organizationId;
    }

    this._ownerCache.set(organizationId, {
      userId: owner.userId,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
    });
    return owner.userId;
  }

  /**
   * Get the credit balance for an organization (resolved to owner user).
   * Returns null if Aisee is disabled (self-hosted / no billing).
   */
  async getBalance(organizationId: string): Promise<AiseeCreditBalance | null> {
    const userId = await this.resolveOwnerUserId(organizationId);
    return this.aiseeClient.getBalance(userId);
  }

  /**
   * Check whether the organization's owner has a positive credit balance.
   * Returns true if Aisee is disabled (self-hosted / no billing).
   */
  async hasCredits(organizationId: string): Promise<boolean> {
    const balance = await this.getBalance(organizationId);
    if (!balance) {
      return true;
    }
    return balance.total > 0;
  }

  /**
   * Execute a single AI operation (text OR image) with post-success billing.
   *
   * For single-step calls like generateImage or generatePosts.
   */
  async executeWithBilling<T>(
    opts: AiseeCreditExecOptions,
    llmCall: () => Promise<{ result: T; usage: AiUsageInfo }>
  ): Promise<AiseeCreditExecResult<T>> {
    const hasBalance = await this.hasCredits(opts.userId);
    if (!hasBalance) {
      throw new Error('Insufficient credits');
    }

    const { result, usage } = await llmCall();

    const cost = await this.aiPricingService.calculateCost(usage);
    const costItem = this.costResultToItem(cost);

    if (!costItem) {
      return { result, costItems: [], deduction: null };
    }

    const deduction = await this.deductWithItems(opts, [costItem]);
    return { result, costItems: [costItem], deduction };
  }

  async executeWithAwaitedBilling<T>(
    opts: AiseeCreditExecOptions,
    llmCall: () => Promise<{ result: T; usage: AiUsageInfo }>
  ): Promise<AiseeCreditExecResult<T>> {
    const hasBalance = await this.hasCredits(opts.userId);
    if (!hasBalance) throw new Error('Insufficient credits');
    const { result, usage } = await llmCall();
    const cost = await this.aiPricingService.calculateCost(usage);
    const costItem = this.costResultToItem(cost);
    if (!costItem) return { result, costItems: [], deduction: null };
    const deduction = await this.deductWithItems(opts, [costItem], true);
    return { result, costItems: [costItem], deduction };
  }

  async deductUsageAndConfirm(
    opts: AiseeCreditExecOptions,
    usage: AiUsageInfo | AiUsageInfo[]
  ): Promise<{ deduction: AiseeDeductResponse | null; costItems: AiseeCostItem[] }> {
    // Accept one or many usage records: an operation (e.g. an operation plan) may
    // span multiple LLM calls — a main generation plus per-post shrink calls,
    // possibly on different models. Each is priced separately (correct per-model
    // cost) and billed as ONE transaction via cost_items, mirroring
    // executeMultiStepWithBilling. Zero-token records price to no item and drop out.
    const usages = Array.isArray(usage) ? usage : [usage];
    const costItems: AiseeCostItem[] = [];
    for (const single of usages) {
      const cost = await this.aiPricingService.calculateCost(single);
      const costItem = this.costResultToItem(cost);
      if (costItem) costItems.push(costItem);
    }
    if (!costItems.length) return { deduction: null, costItems: [] };
    return {
      deduction: await this.deductWithItems(opts, costItems, true),
      costItems,
    };
  }

  async reconcileAwaitedDeduction(opts: AiseeCreditExecOptions): Promise<{
    deduction: AiseeDeductResponse;
    costItems: AiseeCostItem[];
  } | null> {
    const record = await this._billingRecord.model.billingRecord.findUnique({
      where: { taskId: opts.taskId },
      select: { transactionId: true, costItems: true },
    });
    if (!record) return null;
    let costItems: AiseeCostItem[];
    try {
      costItems = JSON.parse(record.costItems) as AiseeCostItem[];
    } catch {
      return null;
    }
    if (record.transactionId) {
      const confirmation = await this.aiseeClient.confirmDeduction({
        taskId: opts.taskId,
        status: 'success',
      });
      if (!confirmation.success) {
        throw new Error(confirmation.error || 'Credit deduction confirmation failed');
      }
      return {
        deduction: { success: true, transactionId: record.transactionId },
        costItems,
      };
    }
    // No transactionId ⇒ the charge never completed, so this IS the retry this
    // method exists for. Say so explicitly: the row is already there, and the
    // duplicate-taskId default would otherwise read it as "already billed",
    // return a skipped response, and leave the work permanently unbillable.
    return {
      deduction: await this.deductWithItems(opts, costItems, true, true),
      costItems,
    };
  }

  /**
   * Execute a multi-step AI operation (text + image in one post) with combined billing.
   *
   * For Agent workflow where a single post involves multiple LLM calls.
   * All usage records are collected, then billed as one transaction with cost_items breakdown.
   */
  async executeMultiStepWithBilling<T>(
    opts: AiseeCreditExecOptions,
    llmCall: () => Promise<{ result: T; usages: AiUsageInfo[] }>
  ): Promise<AiseeCreditExecResult<T>> {
    const hasBalance = await this.hasCredits(opts.userId);
    if (!hasBalance) {
      throw new Error('Insufficient credits');
    }

    const { result, usages } = await llmCall();

    const costItems: AiseeCostItem[] = [];
    for (const usage of usages) {
      const cost = await this.aiPricingService.calculateCost(usage);
      const item = this.costResultToItem(cost);
      if (item) {
        costItems.push(item);
      }
    }

    if (costItems.length === 0) {
      return { result, costItems: [], deduction: null };
    }

    const deduction = await this.deductWithItems(opts, costItems);
    return { result, costItems, deduction };
  }

  /**
   * Standalone deduct + confirm for cases where cost is already known
   * (e.g. fixed per-image pricing).
   */
  async deductAndConfirm(
    opts: AiseeCreditExecOptions & { costItems: AiseeCostItem[] }
  ): Promise<AiseeDeductResponse> {
    return this.deductWithItems(opts, opts.costItems);
  }

  /**
   * Charge an already-created (reserved) BillingRecord on Aisee, UPDATING that
   * row in place rather than inserting a new one. The caller owns the row's
   * lifecycle — e.g. a usage reservation written before the work, where the row
   * doubles as a quota ledger and must already exist (and already be counted) by
   * charge time. Unlike deductWithItems this never creates a row.
   *
   * On a delivered-work charge that the Aisee call rejects or that throws, the
   * row is marked 'unbilled' (still a real, counted reservation) rather than
   * 'failed' — so a billing-backend outage cannot silently un-count delivered
   * work. Throws on a transport error after marking the row, so the caller can
   * log; success/skip return normally.
   */
  async deductReserved(opts: {
    userId: string;
    taskId: string;
    description: string;
    costItems: AiseeCostItem[];
  }): Promise<AiseeDeductResponse> {
    const totalAmount = this.sumDecimalStrings(
      opts.costItems.map((item) => item.amount)
    );

    if (isInternalBilling()) {
      await this._billingRecord.model.billingRecord
        .update({ where: { taskId: opts.taskId }, data: { status: 'internal' } })
        .catch(() => undefined);
      return { success: true, skipped: true };
    }

    const aiseeUserId = await this.resolveOwnerUserId(opts.userId);

    let deduction: AiseeDeductResponse;
    try {
      deduction = await this.aiseeClient.deductCredits({
        userId: aiseeUserId,
        amount: totalAmount,
        taskId: opts.taskId,
        description: opts.description,
        channel: AiseeClient.ENGAGE_CHANNEL,
        data: {
          business_type: AiseeBusinessType.ENGAGE_REPLY,
          cost_items: opts.costItems,
        },
      });
    } catch (err) {
      // Transport failure: keep the reservation counted (unbilled), then rethrow.
      await this._billingRecord.model.billingRecord
        .update({
          where: { taskId: opts.taskId },
          data: { status: 'unbilled', error: (err as Error)?.message?.slice(0, 500) },
        })
        .catch(() => undefined);
      throw err;
    }

    await this._billingRecord.model.billingRecord
      .update({
        where: { taskId: opts.taskId },
        data:
          deduction.success && !deduction.skipped
            ? {
                status: 'success',
                transactionId: deduction.transactionId,
                remainingBalance: deduction.remainingBalance,
                debtAmount: deduction.debtAmount,
              }
            : deduction.skipped
            ? { status: 'skipped' }
            : { status: 'unbilled', error: deduction.error },
      })
      .catch(() => undefined);

    if (deduction.success && !deduction.skipped && deduction.transactionId) {
      this.fireConfirm(opts.taskId, 'success');
    }

    return deduction;
  }

  /**
   * Confirm a previously deducted transaction as failed — triggers refund on Aisee side.
   */
  async confirmFailed(taskId: string): Promise<void> {
    try {
      const resp = await this.aiseeClient.confirmDeduction({
        taskId,
        status: 'failed',
      });

      // Update local record
      await this._billingRecord.model.billingRecord
        .update({
          where: { taskId },
          data: { status: 'failed' },
        })
        .catch(() => {
          // Record may not exist if deduction was never created
        });

      if (resp.refundedAmount) {
        this.logger.log(
          `Refunded ${resp.refundedAmount} credits for task=${taskId}`
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to confirm failure for task=${taskId}:`,
        error
      );
    }
  }

  /**
   * Bill already-collected AI usages after the LLM work is done.
   *
   * Use this when the LLM calls have already completed and you just need
   * to calculate costs and deduct. No balance check — the work is done.
   */
  async billCollectedUsages(
    opts: AiseeCreditExecOptions,
    usages: AiUsageInfo[]
  ): Promise<AiseeDeductResponse | null> {
    const costItems = await this.usagesToCostItems(opts, usages);

    if (costItems.length === 0) {
      return null;
    }

    return this.deductWithItems(opts, costItems);
  }

  // ---------------------------------------------------------------------------
  // Accrual: many small calls, one charge
  // ---------------------------------------------------------------------------

  /**
   * Accumulate `usages` onto a single per-org, per-window BillingRecord instead
   * of charging every call.
   *
   * Why this exists: /copilot/chat is driven by CopilotTextarea autosuggestions,
   * which fire on every typing pause. Charging per request would mean one
   * BillingRecord row and two aisee-core round-trips per pause — load
   * proportional to keystrokes rather than to spend.
   *
   * Settlement is LAZY; there is no scheduled sweep. A window is charged when
   * either:
   *   - a later request on the same stream arrives in a NEWER window, or
   *   - the accrued total reaches `thresholdCredits`.
   *
   * The consequence is accepted, not overlooked: a stream that goes quiet
   * mid-window leaves its last row uncharged — bounded by `thresholdCredits`,
   * listed by `GET /admin/billing/records?status=accruing`, and chargeable with
   * `POST /admin/billing/retry/:id`. Nothing is lost, it just waits.
   *
   * `streamKey` must identify the stream WITHOUT the window (e.g.
   * `copilot_chat_{orgId}`): it is the prefix used to find that stream's older
   * windows, so two orgs — or two surfaces — never settle each other's rows.
   */
  async accrueCollectedUsages(
    opts: Omit<AiseeCreditExecOptions, 'taskId'> & { streamKey: string },
    usages: AiUsageInfo[],
    thresholdCredits: number
  ): Promise<void> {
    const costItems = await this.usagesToCostItems(opts, usages);
    if (costItems.length === 0) {
      return;
    }

    const taskId = `postiz_${opts.streamKey}_${this.accrualWindow()}`;

    // Older windows first: they are complete, and charging them before touching
    // the current one keeps the stream's history in order even if the accrual
    // below (or its threshold flush) throws.
    await this.settleStaleWindows(opts.userId, opts.streamKey, taskId);

    // usages.length, NOT costItems.length: when pricing cannot resolve,
    // usagesToCostItems collapses every call into ONE minimum-charge item whose
    // amount already covers them all. Counting line items there would under-report
    // the calls by exactly the factor that matters.
    const accrued = await this.accrueOntoWindow(
      taskId,
      opts,
      costItems,
      usages.length
    );
    if (!accrued) {
      return;
    }

    if (parseFloat(accrued.amount) >= thresholdCredits) {
      await this.settleAccruedRecord(accrued.recordId);
    }
  }

  /** UTC hour bucket — the accrual window. */
  private accrualWindow(now = new Date()): string {
    return now.toISOString().slice(0, 13).replace(/[-T]/g, '');
  }

  /**
   * Read-modify-write the window's row under SERIALIZABLE isolation.
   *
   * Two concurrent requests from the same org would otherwise lose one
   * increment — `amount` is a decimal STRING, so there is no atomic column
   * increment to lean on. Postgres SSI aborts the loser and the retry reads the
   * winner's committed row. Same mechanism engage's reserveReplyGeneration
   * relies on for its cap.
   */
  private async accrueOntoWindow(
    taskId: string,
    opts: Omit<AiseeCreditExecOptions, 'taskId'> & { streamKey: string },
    incoming: AiseeCostItem[],
    callCount: number
  ): Promise<{ recordId: string; amount: string } | null> {
    const subType = AiseeCreditService.inferSubType(
      opts.businessType,
      opts.subType as AiseeBusinessSubType
    );
    const incomingAmount = this.sumDecimalStrings(
      incoming.map((item) => item.amount)
    );

    try {
      return await this.runSerializable(async (tx) => {
        const existing = await tx.billingRecord.findUnique({ where: { taskId } });

        if (!existing) {
          const created = await tx.billingRecord.create({
            data: {
              organizationId: opts.userId,
              taskId,
              amount: incomingAmount,
              businessType: opts.businessType,
              subType: subType || null,
              description: opts.description,
              costItems: JSON.stringify(incoming),
              ...deriveTokenColumns(incoming),
              relatedId: opts.relatedId || null,
              data: this.mergeAccrualData(null, opts.data, callCount),
              status: ACCRUING_STATUS,
            },
          });
          return { recordId: created.id, amount: created.amount };
        }

        // A window already charged (or being charged) must not be reopened —
        // its taskId is spent as far as Aisee is concerned, so topping it up
        // would silently drop the new cost. Roll into the next window instead.
        if (existing.status !== ACCRUING_STATUS) {
          this.logger.warn(
            `Accrual window ${taskId} is already ${existing.status}; skipping ${incomingAmount} credits`
          );
          return null;
        }

        const merged = this.mergeCostItems(
          this.parseCostItems(existing.costItems),
          incoming
        );
        const amount = this.sumDecimalStrings(merged.map((i) => i.amount));

        const updated = await tx.billingRecord.update({
          where: { id: existing.id },
          data: {
            amount,
            costItems: JSON.stringify(merged),
            ...deriveTokenColumns(merged),
            data: this.mergeAccrualData(
              existing.data as Record<string, unknown> | null,
              opts.data,
              callCount
            ),
          },
        });
        return { recordId: updated.id, amount: updated.amount };
      });
    } catch (err) {
      // Accrual is bookkeeping on a response that already went out; losing a
      // window is better than throwing from a 'close' handler.
      this.logger.error(`Failed to accrue onto ${taskId}:`, err);
      return null;
    }
  }

  /**
   * Charge every window of this stream except `currentTaskId`. Sequential on
   * purpose: each settle is an Aisee round-trip, and a stream normally has at
   * most one stale window.
   */
  private async settleStaleWindows(
    organizationId: string,
    streamKey: string,
    currentTaskId: string
  ): Promise<void> {
    try {
      const stale = await this._billingRecord.model.billingRecord.findMany({
        where: {
          organizationId,
          status: ACCRUING_STATUS,
          taskId: { startsWith: `postiz_${streamKey}_`, not: currentTaskId },
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });

      for (const record of stale) {
        await this.settleAccruedRecord(record.id);
      }
    } catch (err) {
      this.logger.error(
        `Failed to settle stale accrual windows for ${streamKey}:`,
        err
      );
    }
  }

  /**
   * Charge an accruing row: flip it out of `accruing` FIRST so a concurrent
   * accrual cannot keep adding to a row that is about to be sent, then run the
   * same Aisee deduct/confirm the direct path uses.
   */
  private async settleAccruedRecord(recordId: string): Promise<void> {
    const internal = isInternalBilling();

    // Claim it: the conditional status guard means only one caller can win, so
    // two overlapping requests cannot charge the same window twice.
    const claimed = await this._billingRecord.model.billingRecord
      .updateMany({
        where: { id: recordId, status: ACCRUING_STATUS },
        data: { status: internal ? 'internal' : 'pending' },
      })
      .catch((err) => {
        this.logger.error(`Failed to claim accrual ${recordId}:`, err);
        return { count: 0 };
      });

    if (claimed.count === 0) {
      return;
    }

    const record = await this._billingRecord.model.billingRecord.findUnique({
      where: { id: recordId },
    });
    if (!record) {
      return;
    }

    if (internal) {
      return;
    }

    try {
      const aiseeUserId = await this.resolveOwnerUserId(record.organizationId);
      const costItems = this.parseCostItems(record.costItems);
      const data = (record.data as Record<string, unknown>) || {};

      const deduction = await this.aiseeClient.deductCredits({
        userId: aiseeUserId,
        amount: record.amount,
        taskId: record.taskId,
        description: record.description,
        relatedId: record.relatedId || undefined,
        channel: AiseeCreditService.resolveChannel(
          record.businessType as AiseeBusinessType,
          data
        ),
        data: {
          business_type: record.businessType,
          sub_type: record.subType || undefined,
          cost_items: costItems,
          postiz_billing_id: record.id,
          ...data,
        },
      });

      await this.updateBillingRecord(record.id, deduction);

      if (!deduction.success && !deduction.skipped) {
        this.logger.error(
          `Accrual deduction failed for task=${record.taskId}: ${deduction.error}`
        );
        return;
      }

      if (deduction.success && !deduction.skipped && deduction.transactionId) {
        this.fireConfirm(record.taskId, 'success');
      }
    } catch (err) {
      // The row is left at 'pending', which /admin/billing/summary already
      // reports as actionRequired and POST /admin/billing/retry/:id can finish.
      this.logger.error(`Failed to settle accrual ${record.taskId}:`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Price `usages` into cost items. Shared with billCollectedUsages so the
   * accrual path applies the same minimum charge for untracked calls — usage
   * that reached a model is never free, whichever path settles it.
   */
  private async usagesToCostItems(
    opts: { taskId?: string; streamKey?: string },
    usages: AiUsageInfo[]
  ): Promise<AiseeCostItem[]> {
    const costItems: AiseeCostItem[] = [];
    for (const usage of usages) {
      const cost = await this.aiPricingService.calculateCost(usage);
      const item = this.costResultToItem(cost);
      if (item) {
        costItems.push(item);
      }
    }

    if (costItems.length === 0 && usages.length > 0) {
      this.logger.warn(
        `Zero-cost usages for ${opts.taskId ?? opts.streamKey} (${usages.length} calls, tokens may not have been tracked). Applying minimum charge.`
      );
      costItems.push({
        type: 'text',
        amount: (0.01 * usages.length).toFixed(6),
        model: usages[0]?.model || 'unknown',
        billing_mode: 'per_token',
        quantity: 0,
      });
    }

    return costItems;
  }

  private parseCostItems(raw: string): AiseeCostItem[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      this.logger.warn('Unparseable costItems on an accrual row — treating as empty');
      return [];
    }
  }

  /**
   * Fold incoming items into existing ones, keyed by what actually distinguishes
   * a price line: type + model + billing_mode. Without this a busy window would
   * carry one item per request, and that list is sent to Aisee verbatim.
   */
  private mergeCostItems(
    existing: AiseeCostItem[],
    incoming: AiseeCostItem[]
  ): AiseeCostItem[] {
    const byKey = new Map<string, AiseeCostItem>();
    for (const item of [...existing, ...incoming]) {
      const key = `${item.type}|${item.model}|${item.billing_mode}`;
      const current = byKey.get(key);
      if (!current) {
        byKey.set(key, { ...item });
        continue;
      }
      current.amount = this.sumDecimalStrings([current.amount, item.amount]);
      current.quantity += item.quantity;
      this.mergeTokenSplit(current, item);
    }
    return [...byKey.values()];
  }

  /**
   * Add `item`'s prompt/completion split onto `current`, or drop the split when
   * either side does not have one.
   *
   * Dropping matters during the transition: an accruing window opened before the
   * split was persisted gets merged with items that do have it. Adding them as
   * if the missing side were 0 would produce a split that no longer accounts for
   * `quantity` — a number that looks precise and under-reports. Absent is the
   * honest answer, and it self-heals as soon as that window settles.
   */
  private mergeTokenSplit(current: AiseeCostItem, item: AiseeCostItem): void {
    // prompt+completion is what makes a split; one without the other is not one.
    const hasSplit = (costItem: AiseeCostItem) =>
      costItem.prompt_tokens !== undefined &&
      costItem.completion_tokens !== undefined;

    if (!hasSplit(current) || !hasSplit(item)) {
      delete current.prompt_tokens;
      delete current.completion_tokens;
      delete current.cached_prompt_tokens;
      return;
    }

    current.prompt_tokens = current.prompt_tokens! + item.prompt_tokens!;
    current.completion_tokens =
      current.completion_tokens! + item.completion_tokens!;

    // Unlike the pair above, cached_prompt_tokens is legitimately absent when a
    // call cached nothing — and here both sides DO carry a split, so absent
    // means zero rather than unknown.
    const cached =
      (current.cached_prompt_tokens ?? 0) + (item.cached_prompt_tokens ?? 0);
    if (cached > 0) {
      current.cached_prompt_tokens = cached;
    } else {
      delete current.cached_prompt_tokens;
    }
  }

  /**
   * Carry the caller's context onto the window and keep running counters. The
   * first request's context wins for scalar fields — later ones only add to the
   * counters, so the row says how many calls it covers and of which kind.
   */
  private mergeAccrualData(
    existing: Record<string, unknown> | null,
    incoming: Record<string, unknown> | undefined,
    callCount: number
  ): Record<string, unknown> {
    const base = existing ?? { ...(incoming || {}) };
    const previousCalls = Number(base.accruedCalls ?? 0);

    const requestType = incoming?.requestType as string | undefined;
    const byRequestType = {
      ...((base.byRequestType as Record<string, number>) || {}),
    };
    if (requestType) {
      byRequestType[requestType] = (byRequestType[requestType] || 0) + callCount;
    }

    return {
      ...base,
      accruedCalls: previousCalls + callCount,
      ...(Object.keys(byRequestType).length > 0 && { byRequestType }),
    };
  }

  /**
   * Run `fn` in a SERIALIZABLE transaction, retrying a bounded number of times
   * on a serialization conflict.
   */
  private async runSerializable<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this._tx.model.$transaction(fn, {
          isolationLevel: 'Serializable',
        });
      } catch (err) {
        if (
          attempt < 3 &&
          (err as { code?: string })?.code === SERIALIZATION_FAILURE_CODE
        ) {
          continue;
        }
        throw err;
      }
    }
  }

  private costResultToItem(cost: AiCostResult): AiseeCostItem | null {
    if (!cost.pricingFound || cost.cost <= 0) {
      return null;
    }
    return {
      type: cost.type as AiseeCostItem['type'],
      amount: cost.cost.toFixed(6),
      model: cost.model,
      billing_mode: cost.billingMode,
      quantity: cost.quantity,
      // Spread-omitted rather than written as 0: absent must read as "unknown"
      // so a historical row keeps showing only its total instead of claiming a
      // 0/0 split that does not add up to `quantity`.
      ...(cost.promptTokens !== undefined && {
        prompt_tokens: cost.promptTokens,
      }),
      ...(cost.completionTokens !== undefined && {
        completion_tokens: cost.completionTokens,
      }),
      ...(cost.cachedPromptTokens !== undefined && {
        cached_prompt_tokens: cost.cachedPromptTokens,
      }),
    };
  }

  /**
   * Sum decimal strings without floating-point loss.
   * Pads to 6 decimal places, sums as BigInt, then restores the decimal point.
   */
  private sumDecimalStrings(amounts: string[]): string {
    const SCALE = BigInt(1_000_000); // 6 decimal places
    let total = BigInt(0);
    for (const amt of amounts) {
      const [intPart, fracPart = ''] = amt.split('.');
      const padded = (fracPart + '000000').slice(0, 6);
      total += BigInt(intPart) * SCALE + BigInt(padded);
    }
    const intStr = (total / SCALE).toString();
    const fracStr = (total % SCALE).toString().padStart(6, '0');
    return `${intStr}.${fracStr}`;
  }

  /**
   * Core deduction flow:
   * 1. Create local BillingRecord — always, regardless of billing mode
   * 2. If BILL_TYPE=internal: set status='internal', skip Aisee call
   * 3. If BILL_TYPE=third: call Aisee deductCredits(), update record, confirm
   *
   * `retryUnbilledTask` inverts the duplicate-taskId default for the ONE caller
   * that already knows the previous attempt never took the money
   * (reconcileAwaitedDeduction, which only re-deducts a row with no
   * transactionId). Without it the conservative default — "a row exists, assume
   * it was billed" — would permanently defeat that retry; see
   * resolveDuplicateTask.
   */
  private async deductWithItems(
    opts: AiseeCreditExecOptions,
    costItems: AiseeCostItem[],
    awaitConfirmation = false,
    retryUnbilledTask = false
  ): Promise<AiseeDeductResponse> {
    const totalAmount = this.sumDecimalStrings(
      costItems.map((item) => item.amount)
    );

    const internal = isInternalBilling();

    // Infer default subType if missing
    const subType = AiseeCreditService.inferSubType(
      opts.businessType,
      opts.subType as AiseeBusinessSubType
    );

    // Step 1: Create local BillingRecord — always created for unified tracking.
    //
    // `taskId` is unique, and for callers that derive it deterministically from
    // the billed entity (post overage → `postiz_post_overage_<postId>`) it is the
    // ONLY idempotency guard: re-saving the same post calls straight back in here
    // with the same taskId. A P2002 therefore means "this task was already
    // billed" — falling through would charge the user a SECOND time on Aisee with
    // no local record to show for it, so short-circuit instead.
    let recordId: string | undefined;
    try {
      const record = await this._billingRecord.model.billingRecord.create({
        data: {
          organizationId: opts.userId,
          taskId: opts.taskId,
          amount: totalAmount,
          businessType: opts.businessType,
          subType: subType || null,
          description: opts.description,
          costItems: JSON.stringify(costItems),
          ...deriveTokenColumns(costItems),
          relatedId: opts.relatedId || null,
          data: (opts.data as any) || undefined,
          status: internal ? 'internal' : 'pending',
        },
      });
      recordId = record.id;
    } catch (dbErr) {
      if (
        dbErr instanceof Prisma.PrismaClientKnownRequestError &&
        dbErr.code === 'P2002'
      ) {
        const replay = await this.resolveDuplicateTask(
          opts.taskId,
          totalAmount,
          costItems,
          internal,
          retryUnbilledTask
        );
        if (replay.alreadyBilled) {
          return { success: true, skipped: true };
        }
        recordId = replay.recordId;
      } else if (STRUCTURAL_DB_ERROR_CODES.has((dbErr as { code?: string })?.code ?? '')) {
        // A schema mismatch — most likely this build deployed ahead of
        // `prisma db push`, so a column it names does not exist yet. Charging
        // past it would take the user's credits with NO local BillingRecord,
        // which also means no taskId row to stop the next attempt charging
        // again. Refuse instead: a missed charge is recoverable, a silent
        // double charge with no audit row is not.
        this.logger.error(
          `Failed to create BillingRecord for task=${opts.taskId} with a ` +
            `schema error — NOT charging. Deploy is likely ahead of ` +
            `prisma db push:`,
          dbErr
        );
        return {
          success: false,
          // retryable: a migration fixes this, so a caller that records a
          // terminal failure would throw away work it could still bill for.
          retryable: true,
          error: 'billing_record_schema_error',
        };
      } else {
        this.logger.error(
          `Failed to create BillingRecord for task=${opts.taskId}, proceeding:`,
          dbErr
        );
      }
    }

    // Step 2: Internal billing — record created, no Aisee call needed
    if (internal) {
      return { success: true, skipped: true };
    }

    // Step 3: Call Aisee with resolved user ID (not org ID)
    const aiseeUserId = await this.resolveOwnerUserId(opts.userId);
    const deduction = await this.aiseeClient.deductCredits({
      userId: aiseeUserId,
      amount: totalAmount,
      taskId: opts.taskId,
      description: opts.description,
      relatedId: opts.relatedId,
      channel: AiseeCreditService.resolveChannel(opts.businessType, opts.data),
      data: {
        business_type: opts.businessType,
        sub_type: subType,
        cost_items: costItems,
        postiz_billing_id: recordId,
        ...(opts.data || {}),
      },
    });

    // Step 4: Update local record with Aisee response.
    if (recordId) {
      const update = this.updateBillingRecord(recordId, deduction);
      if (awaitConfirmation) await update;
      else update.catch((dbErr) => {
          this.logger.error(
            `Failed to update BillingRecord id=${recordId} for task=${opts.taskId}:`,
            dbErr
          );
        });
    }

    if (!deduction.success && !deduction.skipped) {
      this.logger.error(
        `Credit deduction failed for task=${opts.taskId}: ${deduction.error}`
      );
    }

    // Step 5: Fire-and-forget confirm on success
    if (deduction.success && !deduction.skipped && deduction.transactionId) {
      if (awaitConfirmation) {
        const confirmation = await this.aiseeClient.confirmDeduction({
          taskId: opts.taskId,
          status: 'success',
        });
        if (!confirmation.success) {
          throw new Error(confirmation.error || 'Credit deduction confirmation failed');
        }
      } else {
        this.fireConfirm(opts.taskId, 'success');
      }
    }

    return deduction;
  }

  /**
   * A BillingRecord already exists for this taskId (unique-constraint hit).
   * Decide whether the caller is replaying work that was already billed or
   * retrying a charge that never took the money.
   *
   * DEFAULT (`retryUnbilled = false`) — the caller cannot tell the two apart, so
   * only `failed` retries. Everything else, `pending` included, counts as billed:
   * a pending row is an in-flight or crashed sibling, and for the callers that
   * derive taskId from an entity (post overage, re-saved on every edit)
   * double-charging is worse than leaving a stale row behind.
   *
   * `retryUnbilled = true` — the caller has ALREADY established that no money
   * moved (reconcileAwaitedDeduction only re-deducts a row with no
   * transactionId). Here the conservative default is the dangerous one: it would
   * return "already billed" for a row that was never charged, and since the
   * taskId stays occupied the work could never be billed by any later attempt.
   * So only the statuses that genuinely owe nothing — `success`, `skipped`,
   * `internal` — stop the charge; `failed`, `pending` and an unreadable row all
   * proceed. Charging twice is not a risk here: taskId is Aisee's idempotency
   * key, which is exactly what this path relied on before the duplicate branch
   * existed.
   */
  private async resolveDuplicateTask(
    taskId: string,
    totalAmount: string,
    costItems: AiseeCostItem[],
    internal: boolean,
    retryUnbilled: boolean
  ): Promise<{ alreadyBilled: boolean; recordId?: string }> {
    const existing = await this._billingRecord.model.billingRecord
      .findUnique({ where: { taskId } })
      .catch((err: unknown) => {
        this.logger.error(`Duplicate billing task=${taskId}: lookup failed:`, err);
        return null;
      });

    const status = existing?.status ?? null;
    // Terminal states that can never owe a charge, whichever mode we are in.
    const settled = status === 'success' || status === 'skipped' || status === 'internal';
    const retryable = retryUnbilled ? !settled : status === 'failed';

    if (!retryable) {
      if (status === null) {
        // Not the same event as a benign replay, and it is the branch that can
        // actually leave real work uncharged — so it must be greppable on its
        // own rather than hidden inside the "already billed" line that fires
        // constantly in normal operation.
        this.logger.error(
          `Duplicate billing task=${taskId}: state unknown (record unreadable), declining to charge — amount=${totalAmount} may be uncollected`
        );
      } else {
        this.logger.warn(
          `Duplicate billing task=${taskId} (status=${status}) — already billed, skipping deduction`
        );
      }
      return { alreadyBilled: true };
    }

    // Retry mode with no row to reuse (it vanished, or the read failed). Charge
    // anyway rather than silently dropping a real debt — same fall-through as a
    // non-uniqueness create failure, which also bills without a local record.
    if (!existing) {
      this.logger.warn(
        `Duplicate billing task=${taskId}: retry requested but the record could not be read — charging without a local record`
      );
      return { alreadyBilled: false };
    }

    // Retry of a charge that never went through: refresh the row with this
    // attempt's cost and let the normal flow re-run against Aisee.
    const reset = await this._billingRecord.model.billingRecord
      .update({
        where: { id: existing.id },
        data: {
          amount: totalAmount,
          costItems: JSON.stringify(costItems),
          ...deriveTokenColumns(costItems),
          status: internal ? 'internal' : 'pending',
          error: null,
        },
      })
      .catch((err: unknown) => {
        this.logger.error(
          `Duplicate billing task=${taskId}: failed to reset the ${status} record for retry:`,
          err
        );
        return null;
      });

    this.logger.log(
      `Duplicate billing task=${taskId} (status=${status}): previous attempt took no money, retrying deduction`
    );
    return { alreadyBilled: false, recordId: reset?.id ?? existing.id };
  }

  private async updateBillingRecord(
    recordId: string,
    deduction: AiseeDeductResponse
  ): Promise<void> {
    if (deduction.skipped) {
      await this._billingRecord.model.billingRecord.update({
        where: { id: recordId },
        data: { status: 'skipped' },
      });
    } else if (deduction.success) {
      await this._billingRecord.model.billingRecord.update({
        where: { id: recordId },
        data: {
          status: 'success',
          transactionId: deduction.transactionId,
          remainingBalance: deduction.remainingBalance,
          debtAmount: deduction.debtAmount,
        },
      });
    } else {
      await this._billingRecord.model.billingRecord.update({
        where: { id: recordId },
        data: {
          status: 'failed',
          error: deduction.error,
        },
      });
    }
  }

  private fireConfirm(taskId: string, status: 'success' | 'failed'): void {
    this.aiseeClient
      .confirmDeduction({ taskId, status })
      .then((resp) => {
        if (!resp.success) {
          this.logger.warn(
            `Confirm ${status} failed for task=${taskId}: ${resp.error}`
          );
        }
      })
      .catch((err) => {
        this.logger.error(`Confirm ${status} error for task=${taskId}:`, err);
      });
  }

  // ---------------------------------------------------------------------------
  // Back-fill: associate business entities after the fact
  // ---------------------------------------------------------------------------

  /**
   * Associate a BillingRecord with a business entity created after billing.
   * Used when the entity (Post, Media) is created after the AI generation.
   *
   * @param taskId - The billing taskId (returned to the caller at generation time)
   * @param update - Fields to back-fill (relatedId, data merge)
   */
  async associateEntity(
    taskId: string,
    update: { relatedId?: string; data?: Record<string, unknown> }
  ): Promise<boolean> {
    try {
      const record = await this._billingRecord.model.billingRecord.findUnique({
        where: { taskId },
      });
      if (!record) {
        this.logger.warn(`associateEntity: no record for task=${taskId}`);
        return false;
      }

      const mergedData = {
        ...((record.data as Record<string, unknown>) || {}),
        ...(update.data || {}),
      };

      await this._billingRecord.model.billingRecord.update({
        where: { taskId },
        data: {
          relatedId: update.relatedId ?? record.relatedId,
          data: mergedData as any,
        },
      });

      this.logger.log(
        `associateEntity: task=${taskId} → relatedId=${update.relatedId}`
      );
      return true;
    } catch (err) {
      this.logger.error(`associateEntity failed for task=${taskId}:`, err);
      return false;
    }
  }

  syncIntegration(orgId: string, channelId: string, data: Record<string, unknown>): void {
    if (!this.aiseeClient.enabled) return;

    this.resolveOwnerUserId(orgId)
      .then((userId) => this.aiseeClient.syncIntegration(userId, channelId, data))
      .catch((err) =>
        this.logger.warn(`[syncIntegration] org=${orgId} channel=${channelId}: ${err.message}`)
      );
  }
}

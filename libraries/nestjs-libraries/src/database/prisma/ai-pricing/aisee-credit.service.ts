import { Injectable, Logger } from '@nestjs/common';
import {
  AiseeClient,
  AiseeBusinessType,
  AiseeCostItem,
  AiseeCreditBalance,
  AiseeDeductResponse,
} from './aisee.client';
import { AiPricingService, AiCostResult } from './ai-pricing.service';
import { AiUsageInfo } from '@gitroom/nestjs-libraries/openai/openai.service';
import {
  PrismaRepository,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

export interface AiseeCreditExecOptions {
  userId: string;
  taskId: string;
  businessType: AiseeBusinessType;
  description: string;
  /** Optional related entity ID for business context (e.g. post ID, media ID) */
  relatedId?: string;
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
    private readonly _userOrganization: PrismaRepository<'userOrganization'>
  ) {}

  // Short-lived cache: orgId → userId (avoids double DB query per billing flow)
  private _ownerCache = new Map<string, { userId: string; expiresAt: number }>();

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
    const costItems: AiseeCostItem[] = [];
    for (const usage of usages) {
      const cost = await this.aiPricingService.calculateCost(usage);
      const item = this.costResultToItem(cost);
      if (item) {
        costItems.push(item);
      }
    }

    if (costItems.length === 0) {
      this.logger.warn(
        `No billable cost for task=${opts.taskId} — skipping deduction`
      );
      return null;
    }

    return this.deductWithItems(opts, costItems);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

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
   * 1. Create local BillingRecord (status=pending) — its id is sent to Aisee for reconciliation
   * 2. Call Aisee deductCredits()
   * 3. Update local record with Aisee response (status, transactionId, etc.)
   * 4. Fire-and-forget confirm
   */
  private async deductWithItems(
    opts: AiseeCreditExecOptions,
    costItems: AiseeCostItem[]
  ): Promise<AiseeDeductResponse> {
    const totalAmount = this.sumDecimalStrings(
      costItems.map((item) => item.amount)
    );

    // Resolve organization ID to owner user ID for Aisee billing
    const aiseeUserId = await this.resolveOwnerUserId(opts.userId);

    // Step 1: Create local audit record BEFORE calling Aisee.
    // If DB write fails, proceed with deduction anyway — billing must not be
    // blocked by a local audit failure.
    let recordId: string | undefined;
    try {
      const record = await this._billingRecord.model.billingRecord.create({
        data: {
          organizationId: opts.userId,
          taskId: opts.taskId,
          amount: totalAmount,
          businessType: opts.businessType,
          description: opts.description,
          costItems: JSON.stringify(costItems),
          relatedId: opts.relatedId || null,
          status: 'pending',
        },
      });
      recordId = record.id;
    } catch (dbErr) {
      this.logger.error(
        `Failed to create BillingRecord for task=${opts.taskId}, proceeding with deduction:`,
        dbErr
      );
    }

    // Step 2: Call Aisee with resolved user ID (not org ID)
    const deduction = await this.aiseeClient.deductCredits({
      userId: aiseeUserId,
      amount: totalAmount,
      taskId: opts.taskId,
      description: opts.description,
      businessType: opts.businessType,
      costItems,
      postizBillingId: recordId,
    });

    // Step 3: Update local record with Aisee response.
    // Wrapped in catch — a failed status update must never mask the deduction result.
    if (recordId) {
      this.updateBillingRecord(recordId, deduction).catch(
        (dbErr) => {
          this.logger.error(
            `Failed to update BillingRecord id=${recordId} for task=${opts.taskId}:`,
            dbErr
          );
        }
      );
    }

    if (!deduction.success && !deduction.skipped) {
      this.logger.error(
        `Credit deduction failed for task=${opts.taskId}: ${deduction.error}`
      );
    }

    // Step 4: Fire-and-forget confirm on success
    if (deduction.success && !deduction.skipped && deduction.transactionId) {
      this.fireConfirm(opts.taskId, 'success');
    }

    return deduction;
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
}

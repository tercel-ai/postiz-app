import { Injectable, Logger } from '@nestjs/common';
import {
  AiseeClient,
  AiseeBusinessType,
  AiseeCostItem,
  AiseeDeductResponse,
} from './aisee.client';
import { AiPricingService, AiCostResult } from './ai-pricing.service';
import { AiUsageInfo } from '@gitroom/nestjs-libraries/openai/openai.service';

export interface AiseeCreditExecOptions {
  userId: string;
  taskId: string;
  businessType: AiseeBusinessType;
  description: string;
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
 *   4. deductCredits()     — atomic deduction on Aisee (one txn per post, with cost_items breakdown)
 *   5. confirmDeduction()  — fire-and-forget delivery receipt
 */
@Injectable()
export class AiseeCreditService {
  private readonly logger = new Logger(AiseeCreditService.name);

  constructor(
    private readonly aiseeClient: AiseeClient,
    private readonly aiPricingService: AiPricingService
  ) {}

  /**
   * Check whether the user has a positive credit balance.
   * Returns true if Aisee is disabled (self-hosted / no billing).
   */
  async hasCredits(userId: string): Promise<boolean> {
    const balance = await this.aiseeClient.getBalance(userId);
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

  private async deductWithItems(
    opts: AiseeCreditExecOptions,
    costItems: AiseeCostItem[]
  ): Promise<AiseeDeductResponse> {
    const totalAmount = this.sumDecimalStrings(
      costItems.map((item) => item.amount)
    );

    const deduction = await this.aiseeClient.deductCredits({
      userId: opts.userId,
      amount: totalAmount,
      taskId: opts.taskId,
      description: opts.description,
      businessType: opts.businessType,
      costItems,
    });

    if (!deduction.success && !deduction.skipped) {
      this.logger.error(
        `Credit deduction failed for task=${opts.taskId}: ${deduction.error}`
      );
    }

    if (deduction.success && !deduction.skipped && deduction.transactionId) {
      this.fireConfirm(opts.taskId, 'success');
    }

    return deduction;
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

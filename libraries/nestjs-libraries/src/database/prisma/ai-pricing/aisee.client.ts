import { Injectable, Logger } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Business type constants — align with Aisee analytics categories
// ---------------------------------------------------------------------------

export const AiseeBusinessType = {
  AI_COPYWRITING: 'ai_copywriting',
  IMAGE_GEN: 'image_gen',
  // TODO: AI_VIDEO — pending KieAI cost integration with Aisee billing
} as const;

export type AiseeBusinessType =
  (typeof AiseeBusinessType)[keyof typeof AiseeBusinessType];

export const AiseeConsumptionType = {
  TEXT: 'text',
  IMAGE: 'image',
  VIDEO: 'video',
} as const;

export type AiseeConsumptionType =
  (typeof AiseeConsumptionType)[keyof typeof AiseeConsumptionType];

/** One line-item within a deduction — stored in Aisee transaction.data for audit */
export interface AiseeCostItem {
  /** text / image / video */
  type: AiseeConsumptionType;
  /** Decimal string cost for this item */
  amount: string;
  /** e.g. "gpt-4.1", "dall-e-3" */
  model: string;
  /** per_token or per_image */
  billing_mode: 'per_token' | 'per_image';
  /** per_token: total_tokens, per_image: image count */
  quantity: number;
}

// ---------------------------------------------------------------------------
// Request / Response interfaces
// ---------------------------------------------------------------------------

export interface AiseeDeductRequest {
  userId: string;
  /** Total cost — decimal string, sum of all cost_items */
  amount: string;
  /** Idempotency key, e.g. "postiz_{postId}" */
  taskId: string;
  description: string;
  /** Business category for analytics */
  businessType: AiseeBusinessType;
  /** Breakdown of individual costs (text, image, etc.) — stored in transaction data */
  costItems: AiseeCostItem[];
}

export interface AiseeDeductResponse {
  success: boolean;
  skipped?: boolean;
  transactionId?: string;
  remainingBalance?: string;
  /** Non-null when user balance went negative */
  debtAmount?: string;
  error?: string;
}

export interface AiseeConfirmRequest {
  taskId: string;
  status: 'success' | 'failed';
}

export interface AiseeConfirmResponse {
  success: boolean;
  transactionId?: string;
  status?: string;
  refundedAmount?: string;
  error?: string;
}

export interface AiseeCreditBalance {
  subscription: number;
  top_up: number;
  bonus: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

@Injectable()
export class AiseeClient {
  private readonly logger = new Logger(AiseeClient.name);

  static readonly CHANNEL = 'postiz';

  private _cachedToken: string | null = null;
  private _tokenExpiresAt = 0;

  private get baseUrl(): string {
    return process.env.AISEE_ORCHESTRATOR_URL || 'http://localhost:8000';
  }

  private get enabled(): boolean {
    return !!process.env.AISEE_ORCHESTRATOR_URL;
  }

  /**
   * Sign a short-lived JWT with system-internal role for service-to-service auth.
   * Uses the same JWT_SECRET as the rest of the platform.
   * Cached and reused until 1 minute before expiry.
   */
  private signInternalToken(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this._cachedToken && now < this._tokenExpiresAt - 60) {
      return this._cachedToken;
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET is not configured');
    }

    const expiresIn = 120; // 2 minutes
    this._cachedToken = sign(
      { roles: ['system-internal'], iss: 'postiz' },
      secret,
      { expiresIn }
    );
    this._tokenExpiresAt = now + expiresIn;
    return this._cachedToken;
  }

  private get authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.signInternalToken()}` };
  }

  // -------------------------------------------------------------------------
  // GET /credit/balance/{user_id}
  // -------------------------------------------------------------------------

  async getBalance(userId: string): Promise<AiseeCreditBalance | null> {
    if (!this.enabled) {
      return null;
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/credit/balance/${encodeURIComponent(userId)}`,
        { headers: this.authHeaders }
      );

      if (!response.ok) {
        this.logger.error(`Balance query failed: ${response.status}`);
        return null;
      }

      const data = await response.json();
      return {
        subscription: Number(data.subscription),
        top_up: Number(data.top_up),
        bonus: Number(data.bonus),
        total: Number(data.total),
      };
    } catch (error) {
      this.logger.error('Balance query error:', error);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // POST /credit/deduct  — phase 1: consume credits (status = CONFIRMED)
  // -------------------------------------------------------------------------

  async deductCredits(req: AiseeDeductRequest): Promise<AiseeDeductResponse> {
    if (!this.enabled) {
      this.logger.warn('Not configured, skipping credit deduction');
      return { success: true, skipped: true };
    }

    try {
      const response = await fetch(`${this.baseUrl}/credit/deduct`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders,
        },
        body: JSON.stringify({
          user_id: req.userId,
          amount: req.amount,
          task_id: req.taskId,
          description: req.description,
          channel: AiseeClient.CHANNEL,
          business_type: req.businessType,
          cost_items: req.costItems,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `Credit deduction failed: ${response.status} ${errorText}`
        );
        return {
          success: false,
          error: `HTTP ${response.status}: ${errorText}`,
        };
      }

      const data = await response.json();
      if (!data.success) {
        return {
          success: false,
          error: data.error || 'Unknown error from orchestrator',
        };
      }

      return {
        success: true,
        transactionId: data.transaction_id,
        remainingBalance: data.remaining_balance,
        debtAmount: data.debt_amount || undefined,
      };
    } catch (error) {
      this.logger.error('Credit deduction error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // -------------------------------------------------------------------------
  // POST /credit/deduct/confirm  — phase 2: finalise to SUCCESS or FAILED
  // -------------------------------------------------------------------------

  async confirmDeduction(
    req: AiseeConfirmRequest
  ): Promise<AiseeConfirmResponse> {
    if (!this.enabled) {
      return { success: true };
    }

    try {
      const response = await fetch(`${this.baseUrl}/credit/deduct/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders,
        },
        body: JSON.stringify({
          task_id: req.taskId,
          status: req.status,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `Deduction confirm failed: ${response.status} ${errorText}`
        );
        return {
          success: false,
          error: `HTTP ${response.status}: ${errorText}`,
        };
      }

      const data = await response.json();
      if (!data.success) {
        return {
          success: false,
          error: data.error || 'Unknown error from orchestrator',
        };
      }

      return {
        success: true,
        transactionId: data.transaction_id,
        status: data.status,
        refundedAmount: data.refunded_amount || undefined,
      };
    } catch (error) {
      this.logger.error('Deduction confirm error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Build a unique task_id: postiz_{label}_{random}
   * The random suffix prevents collisions when Date.now() overlaps.
   */
  static buildTaskId(label: string): string {
    const rand = randomBytes(4).toString('hex');
    return `postiz_${label}_${rand}`;
  }
}

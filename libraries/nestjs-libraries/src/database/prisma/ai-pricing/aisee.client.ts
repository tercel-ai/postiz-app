import { Injectable, Logger } from '@nestjs/common';
import { sign } from 'jsonwebtoken';

export interface AiseeDeductRequest {
  userId: string;
  amount: number;
  taskId: string;
  description: string;
}

export interface AiseeDeductResponse {
  success: boolean;
  skipped?: boolean;
  transactionId?: string;
  remainingBalance?: number;
  error?: string;
}

export interface AiseeCreditBalance {
  subscription: number;
  top_up: number;
  bonus: number;
  total: number;
}

@Injectable()
export class AiseeClient {
  private readonly logger = new Logger(AiseeClient.name);

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
        remainingBalance: Number(data.remaining_balance),
      };
    } catch (error) {
      this.logger.error('Credit deduction error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getBalance(userId: string): Promise<AiseeCreditBalance | null> {
    if (!this.enabled) {
      return null;
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/credit/balance/${encodeURIComponent(userId)}`,
        {
          headers: this.authHeaders,
        }
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

  /**
   * Build task_id in the format: postiz_{postId}
   */
  static buildTaskId(postId: string): string {
    return `postiz_${postId}`;
  }
}

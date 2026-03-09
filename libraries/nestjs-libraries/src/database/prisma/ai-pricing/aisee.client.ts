import { Injectable } from '@nestjs/common';

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
  private get baseUrl(): string {
    return process.env.AISEE_ORCHESTRATOR_URL || 'http://localhost:8000';
  }

  private get apiKey(): string {
    return process.env.AISEE_API_KEY || '';
  }

  private get enabled(): boolean {
    return !!process.env.AISEE_ORCHESTRATOR_URL;
  }

  async deductCredits(req: AiseeDeductRequest): Promise<AiseeDeductResponse> {
    if (!this.enabled) {
      console.warn('[AiseeClient] Not configured, skipping credit deduction');
      return { success: true, skipped: true };
    }

    try {
      const response = await fetch(`${this.baseUrl}/credit/deduct`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
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
        console.error(
          `[AiseeClient] Credit deduction failed: ${response.status} ${errorText}`
        );
        return {
          success: false,
          error: `HTTP ${response.status}: ${errorText}`,
        };
      }

      const data = await response.json();
      return {
        success: true,
        transactionId: data.transaction_id,
        remainingBalance: data.remaining_balance,
      };
    } catch (error) {
      console.error('[AiseeClient] Credit deduction error:', error);
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
        `${this.baseUrl}/credit-balance/${encodeURIComponent(userId)}/balance`,
        {
          headers: {
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
        }
      );

      if (!response.ok) {
        console.error(
          `[AiseeClient] Balance query failed: ${response.status}`
        );
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
      console.error('[AiseeClient] Balance query error:', error);
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

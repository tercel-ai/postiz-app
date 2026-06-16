import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import { AiseeCreditService } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee-credit.service';
import { AiseeBusinessType } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee.client';

export const POST_ANALYTICS_CREDITS_KEY = 'post_analytics_credits';

export interface PostAnalyticsCreditsConfig {
  /** Whether credit deduction is enabled (default: false for backward compat). */
  enabled: boolean;
  /** Credits deducted per integration per analytics run (default: 1). */
  default: number;
  /** Per-platform overrides, keyed by providerIdentifier (e.g. "x", "linkedin"). */
  perPlatform: Record<string, number>;
}

const DEFAULT_CONFIG: PostAnalyticsCreditsConfig = {
  enabled: false,
  default: 1,
  perPlatform: {},
};

/**
 * Manages credit deduction for the daily post analytics monitoring job.
 * Cost is configurable per platform from the Settings store (admin-editable,
 * no redeploy). Deductions are best-effort — analytics always runs; a billing
 * failure is logged but never blocks data collection.
 */
@Injectable()
export class PostAnalyticsCreditService implements OnModuleInit {
  private readonly logger = new Logger(PostAnalyticsCreditService.name);

  constructor(
    private readonly _settings: SettingsService,
    private readonly _aiseeCredit: AiseeCreditService
  ) {}

  async onModuleInit(): Promise<void> {
    const existing = await this._settings.get(POST_ANALYTICS_CREDITS_KEY);
    if (existing === null || existing === undefined) {
      await this._settings.set(POST_ANALYTICS_CREDITS_KEY, DEFAULT_CONFIG, {
        type: 'object',
        description:
          'Post analytics monitoring credit costs. enabled: toggle billing; default: credits per integration per run; perPlatform: per-provider overrides (e.g. {"x": 2, "linkedin": 1}).',
        defaultValue: DEFAULT_CONFIG,
      });
      this.logger.log(`Seeded default ${POST_ANALYTICS_CREDITS_KEY}`);
    }
  }

  async loadConfig(): Promise<PostAnalyticsCreditsConfig> {
    const stored = await this._settings.get<Partial<PostAnalyticsCreditsConfig>>(
      POST_ANALYTICS_CREDITS_KEY
    );
    return {
      enabled: stored?.enabled ?? false,
      default: stored?.default ?? DEFAULT_CONFIG.default,
      perPlatform: { ...DEFAULT_CONFIG.perPlatform, ...(stored?.perPlatform ?? {}) },
    };
  }

  /** Credits to deduct for one integration analytics call on a given platform. */
  getCostForPlatform(config: PostAnalyticsCreditsConfig, platform: string): number {
    return config.perPlatform[platform] ?? config.default;
  }

  /**
   * Deduct credits for a successful integration analytics run.
   * Best-effort: errors are logged but never thrown so analytics sync is unaffected.
   */
  async deductForIntegration(
    orgId: string,
    platform: string,
    integrationId: string,
    config: PostAnalyticsCreditsConfig
  ): Promise<void> {
    if (!config.enabled) return;

    const cost = this.getCostForPlatform(config, platform);
    if (cost <= 0) return;

    const taskId = `postiz_analytics_${integrationId}_${randomBytes(6).toString('hex')}`;

    try {
      await this._aiseeCredit.deductAndConfirm({
        userId: orgId,
        taskId,
        businessType: AiseeBusinessType.POST_ANALYTICS,
        description: `Post analytics sync: ${platform}`,
        relatedId: integrationId,
        data: { platform, integrationId },
        costItems: [
          {
            type: 'text',
            amount: cost.toFixed(6),
            model: 'post_analytics',
            billing_mode: 'per_token',
            quantity: 0,
          },
        ],
      });
    } catch (err) {
      this.logger.warn(
        `Analytics credit deduction failed for org=${orgId} integration=${integrationId} platform=${platform}: ${(err as Error)?.message}`
      );
    }
  }
}

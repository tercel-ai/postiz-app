import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import { AiUsageInfo } from '@gitroom/nestjs-libraries/openai/openai.service';
import { AI_PRICING_SEED } from './seed-pricing';

const SETTINGS_KEY = 'ai_model_pricing';

export interface AiModelPricingConfig {
  text: AiPricingEntry;
  image: AiPricingEntry;
}

export interface AiPricingEntry {
  servicer: string;
  provider: string;
  model: string;
  billing_mode: 'per_token' | 'per_image';
  /** Default price: credits per 1 token (per_token) or credits per 1 image (per_image). Uses output price when input_price/output_price not set. */
  price: string;
  /** Optional: credits per 1 input token. When both input_price and output_price are set, overrides price for per_token billing. */
  input_price?: string;
  /** Optional: credits per 1 output token. When both input_price and output_price are set, overrides price for per_token billing. */
  output_price?: string;
}

export interface AiCostResult {
  servicer: string;
  provider: string;
  model: string;
  type: 'text' | 'image';
  billingMode: 'per_token' | 'per_image';
  price: string;
  inputPrice?: string;
  outputPrice?: string;
  quantity: number; // per_token: total_tokens, per_image: count
  cost: number; // in credits
  pricingFound: boolean;
}

@Injectable()
export class AiPricingService implements OnModuleInit {
  private readonly logger = new Logger(AiPricingService.name);
  private _cache: { data: AiModelPricingConfig; expiry: number } | null = null;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(private _settingsService: SettingsService) {}

  async onModuleInit(): Promise<void> {
    const existing = await this.getPricingConfig();
    if (!existing) {
      await this.setPricingConfig(AI_PRICING_SEED);
      this.logger.log('Seeded default ai_model_pricing config');
    }
  }

  async getPricingConfig(): Promise<AiModelPricingConfig | null> {
    if (this._cache && Date.now() < this._cache.expiry) {
      return this._cache.data;
    }
    const data = await this._settingsService.get<AiModelPricingConfig>(SETTINGS_KEY);
    if (data) {
      this._cache = { data, expiry: Date.now() + this.CACHE_TTL_MS };
    }
    return data;
  }

  async setPricingConfig(config: AiModelPricingConfig): Promise<void> {
    await this._settingsService.set(SETTINGS_KEY, config, {
      type: 'object',
      description:
        'AI model pricing: price in credits (per_token: credits per 1 token, per_image: credits per 1 image). $1 = 100 credits.',
    });
    this._cache = null;
  }

  async calculateCost(usage: AiUsageInfo): Promise<AiCostResult> {
    const config = await this.getPricingConfig();
    const entry = config?.[usage.type];

    if (!entry) {
      this.logger.warn(
        `No pricing config for type=${usage.type}`
      );
      return {
        servicer: usage.servicer,
        provider: usage.provider,
        model: usage.model,
        type: usage.type,
        billingMode: 'per_token',
        price: '0',
        quantity: 0,
        cost: 0,
        pricingFound: false,
      };
    }

    let quantity: number;
    let cost: number;

    if (entry.billing_mode === 'per_image') {
      // credits per 1 image
      quantity = usage.image_billing?.count || 1;
      cost = quantity * parseFloat(entry.price);
    } else {
      // per_token: credits per 1 token
      quantity = usage.usage.total_tokens;
      const hasInputPrice = !!entry.input_price;
      const hasOutputPrice = !!entry.output_price;
      if (hasInputPrice && hasOutputPrice) {
        // Split input/output pricing
        const inputCost =
          usage.usage.prompt_tokens * parseFloat(entry.input_price!);
        const outputCost =
          usage.usage.completion_tokens * parseFloat(entry.output_price!);
        cost = inputCost + outputCost;
      } else {
        if (hasInputPrice !== hasOutputPrice) {
          this.logger.warn(
            `Only one of input_price/output_price is set for type=${usage.type}, falling back to price`
          );
        }
        // Fallback: use price (output price) for all tokens
        cost = quantity * parseFloat(entry.price);
      }
    }

    if (isNaN(cost)) {
      this.logger.error(
        `NaN cost detected for type=${usage.type}, price=${entry.price} input_price=${entry.input_price} output_price=${entry.output_price}`
      );
      cost = 0;
    }

    return {
      servicer: entry.servicer,
      provider: entry.provider,
      model: entry.model,
      type: usage.type,
      billingMode: entry.billing_mode,
      price: entry.price,
      inputPrice: entry.input_price,
      outputPrice: entry.output_price,
      quantity,
      cost,
      pricingFound: true,
    };
  }
}

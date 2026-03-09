import { Injectable } from '@nestjs/common';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import { AiUsageInfo } from '@gitroom/nestjs-libraries/openai/openai.service';

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
  price: number; // per_token: per 1M tokens, per_image: per image
}

export interface AiCostResult {
  servicer: string;
  provider: string;
  model: string;
  type: 'text' | 'image';
  billingMode: 'per_token' | 'per_image';
  unitPrice: number;
  quantity: number; // per_token: total_tokens, per_image: count
  cost: number;
  pricingFound: boolean;
}

@Injectable()
export class AiPricingService {
  private _cache: { data: AiModelPricingConfig; expiry: number } | null = null;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(private _settingsService: SettingsService) {}

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
        'AI model pricing: price unit depends on billing_mode (per_token: per 1M tokens, per_image: per image)',
    });
    this._cache = null;
  }

  async calculateCost(usage: AiUsageInfo): Promise<AiCostResult> {
    const config = await this.getPricingConfig();
    const entry = config?.[usage.type];

    if (!entry) {
      console.warn(
        `[AiPricing] No pricing config for type=${usage.type}`
      );
      return {
        servicer: usage.servicer,
        provider: usage.provider,
        model: usage.model,
        type: usage.type,
        billingMode: 'per_token',
        unitPrice: 0,
        quantity: 0,
        cost: 0,
        pricingFound: false,
      };
    }

    let quantity: number;
    let cost: number;

    if (entry.billing_mode === 'per_image') {
      quantity = usage.image_billing?.count || 1;
      cost = quantity * entry.price;
    } else {
      quantity = usage.usage.total_tokens;
      cost = (quantity / 1_000_000) * entry.price;
    }

    return {
      servicer: entry.servicer,
      provider: entry.provider,
      model: entry.model,
      type: usage.type,
      billingMode: entry.billing_mode,
      unitPrice: entry.price,
      quantity,
      cost,
      pricingFound: true,
    };
  }
}

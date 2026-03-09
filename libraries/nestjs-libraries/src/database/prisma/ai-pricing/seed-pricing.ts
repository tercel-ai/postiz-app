/**
 * AI model pricing seed data.
 * Stored as a JSON object in Settings table under key "ai_model_pricing".
 *
 * price unit depends on billing_mode:
 *   per_token - cost per 1M tokens (USD), based on output price x 1.5
 *   per_image - cost per image (USD)
 */

import type {
  AiModelPricingConfig,
} from './ai-pricing.service';

export const AI_PRICING_SEED: AiModelPricingConfig = {
  text: {
    servicer: 'openrouter',
    provider: 'openai',
    model: 'gpt-5.1',
    billing_mode: 'per_token',
    price: 15, // output $10/M x 1.5
  },
  image: {
    servicer: 'openrouter',
    provider: 'google',
    model: 'gemini-3.1-flash-image-preview',
    billing_mode: 'per_token',
    price: 4.5, // output $3/M x 1.5
  },
};

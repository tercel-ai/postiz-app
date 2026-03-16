/**
 * AI model pricing seed data.
 * Stored as a JSON object in Settings table under key "ai_model_pricing".
 *
 * All prices are in Aisee credits ($1 = 100 credits).
 *
 * price unit depends on billing_mode:
 *   per_token - credits per 1 token
 *   per_image - credits per 1 image
 *
 * price      = default (uses output price for all tokens when input_price/output_price not set)
 * input_price  = optional, credits per 1 input token
 * output_price = optional, credits per 1 output token
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
    price: '0.0015',          // output $10/1M * 1.5 markup = $15/1M → 1500 credits/1M = 0.0015 credits/token
    input_price: '0.000375',  // input  $2.5/1M * 1.5 markup = $3.75/1M → 375 credits/1M = 0.000375 credits/token
    output_price: '0.0015',   // output $10/1M * 1.5 markup = $15/1M → 1500 credits/1M = 0.0015 credits/token
  },
  image: {
    servicer: 'openrouter',
    provider: 'google',
    model: 'gemini-3.1-flash-image-preview',
    billing_mode: 'per_token',
    price: '0.00045',          // output $3/1M * 1.5 markup = $4.5/1M → 450 credits/1M = 0.00045 credits/token
    input_price: '0.0000225',  // input  $0.15/1M * 1.5 markup = $0.225/1M → 22.5 credits/1M = 0.0000225 credits/token
    output_price: '0.00045',   // output $3/1M * 1.5 markup = $4.5/1M → 450 credits/1M = 0.00045 credits/token
  },
};

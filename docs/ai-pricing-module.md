# AI Pricing Module

## Overview

Calculates AI operation costs in Aisee credits ($1 = 100 credits) based on a pricing configuration stored in the Settings table. Supports both per-token and per-image billing modes.

## Pricing Config Structure

Stored in Settings table under key `ai_model_pricing`:

```json
{
  "text": {
    "servicer": "openrouter",
    "provider": "openai",
    "model": "gpt-5.1",
    "billing_mode": "per_token",
    "price": "0.0015",
    "input_price": "0.000375",
    "output_price": "0.0015"
  },
  "image": {
    "servicer": "openrouter",
    "provider": "google",
    "model": "gemini-3.1-flash-image-preview",
    "billing_mode": "per_token",
    "price": "0.00045",
    "input_price": "0.0000225",
    "output_price": "0.00045"
  }
}
```

### Fields

| Field | Description |
|-------|-------------|
| `servicer` | API service provider (openrouter, openai) |
| `provider` | Model maker (openai, google, anthropic) |
| `model` | Bare model name |
| `billing_mode` | `per_token` or `per_image` — determines how prices are interpreted |
| `price` | Default price (string): credits per 1 token (`per_token`) or credits per 1 image (`per_image`). Used when `input_price`/`output_price` not set. |
| `input_price` | Optional (string): credits per 1 input token. When both `input_price` and `output_price` are set, overrides `price` for `per_token` billing. |
| `output_price` | Optional (string): credits per 1 output token. When both `input_price` and `output_price` are set, overrides `price` for `per_token` billing. |

## Cost Calculation

### AiPricingService.calculateCost(usage)

Takes an `AiUsageInfo` (from `logAiUsage()`) and returns `AiCostResult`:

```
per_token (with input_price + output_price):
  cost = prompt_tokens × input_price + completion_tokens × output_price

per_token (fallback, price only):
  cost = total_tokens × price

per_image:
  cost = image_count × price
```

All results are in **credits** (not USD).

### AiCostResult

```typescript
interface AiCostResult {
  servicer: string;
  provider: string;
  model: string;
  type: 'text' | 'image';
  billingMode: 'per_token' | 'per_image';
  price: string;
  inputPrice?: string;
  outputPrice?: string;
  quantity: number;     // total_tokens or image count
  cost: number;         // calculated cost in credits
  pricingFound: boolean;
}
```

## Caching

Pricing config is cached in memory for 5 minutes. Cache is automatically cleared when `setPricingConfig()` is called (e.g., via Admin API).

## Seed Data

Default pricing in credits ($1 = 100 credits, based on OpenRouter output prices × 1.5 markup):

| Type | Model | price (credits/token) | input_price | output_price | Basis |
|------|-------|-----------------------|-------------|--------------|-------|
| text | openai/gpt-5.1 | 0.0015 | 0.000375 | 0.0015 | input $2.5/M, output $10/M × 1.5 |
| image | google/gemini-3.1-flash-image-preview | 0.00045 | 0.0000225 | 0.00045 | input $0.15/M, output $3/M × 1.5 |

Run seed:
```bash
npx ts-node -r tsconfig-paths/register libraries/nestjs-libraries/src/database/prisma/ai-pricing/run-seed-pricing.ts
```

## Integration with Aisee

The calculated cost from `AiCostResult` (in credits) feeds directly into `AiseeClient.deductCredits()`. The `amount` field sent to Aisee is already in credits — no USD-to-credit conversion needed.

See [aisee-integration.md](./aisee-integration.md).

## Key Files

- `libraries/nestjs-libraries/src/database/prisma/ai-pricing/ai-pricing.service.ts`
- `libraries/nestjs-libraries/src/database/prisma/ai-pricing/seed-pricing.ts`
- `libraries/nestjs-libraries/src/database/prisma/ai-pricing/run-seed-pricing.ts`

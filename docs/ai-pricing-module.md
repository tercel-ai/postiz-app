# AI Pricing Module

## Overview

Calculates AI operation costs based on a pricing configuration stored in the Settings table. Supports both per-token and per-image billing modes.

## Pricing Config Structure

Stored in Settings table under key `ai_model_pricing`:

```json
{
  "text": {
    "servicer": "openrouter",
    "provider": "openai",
    "model": "gpt-5.1",
    "billing_mode": "per_token",
    "price": 15
  },
  "image": {
    "servicer": "openrouter",
    "provider": "google",
    "model": "gemini-3.1-flash-image-preview",
    "billing_mode": "per_token",
    "price": 4.5
  }
}
```

### Fields

| Field | Description |
|-------|-------------|
| `servicer` | API service provider (openrouter, openai) |
| `provider` | Model maker (openai, google, anthropic) |
| `model` | Bare model name |
| `billing_mode` | `per_token` or `per_image` — determines how `price` is interpreted |
| `price` | Unit price: per 1M tokens (`per_token`) or per image (`per_image`) in USD |

## Cost Calculation

### AiPricingService.calculateCost(usage)

Takes an `AiUsageInfo` (from `logAiUsage()`) and returns `AiCostResult`:

```
per_token:  cost = total_tokens / 1,000,000 × price
per_image:  cost = image_count × price
```

### AiCostResult

```typescript
interface AiCostResult {
  servicer: string;
  provider: string;
  model: string;
  type: 'text' | 'image';
  billingMode: 'per_token' | 'per_image';
  unitPrice: number;
  quantity: number;     // total_tokens or image count
  cost: number;         // calculated cost in USD
  pricingFound: boolean;
}
```

## Caching

Pricing config is cached in memory for 5 minutes. Cache is automatically cleared when `setPricingConfig()` is called (e.g., via Admin API).

## Seed Data

Default pricing (based on OpenRouter output prices × 1.5):

| Type | Model | Price | Basis |
|------|-------|-------|-------|
| text | openai/gpt-5.1 | $15/1M tokens | output $10/M × 1.5 |
| image | google/gemini-3.1-flash-image-preview | $4.5/1M tokens | output $3/M × 1.5 |

Run seed:
```bash
npx ts-node -r tsconfig-paths/register libraries/nestjs-libraries/src/database/prisma/ai-pricing/run-seed-pricing.ts
```

## Integration with Aisee

The calculated cost from `AiCostResult` feeds into `AiseeClient.deductCredits()` for actual credit deduction. See [aisee-integration.md](./aisee-integration.md).

## Key Files

- `libraries/nestjs-libraries/src/database/prisma/ai-pricing/ai-pricing.service.ts`
- `libraries/nestjs-libraries/src/database/prisma/ai-pricing/seed-pricing.ts`
- `libraries/nestjs-libraries/src/database/prisma/ai-pricing/run-seed-pricing.ts`

# Aisee Integration

## Overview

Postiz integrates with [aisee_orchestrator](../aisee-core/aisee_orchestrator/) for credit-based billing. Postiz handles AI model pricing and cost calculation; aisee handles credit balance and deduction.

## Architecture

```
AI Call → logAiUsage(AiUsageInfo) → AiPricingService.calculateCost() → AiseeClient.deductCredits()
                                          ↓                                      ↓
                                   Settings table                         aisee_orchestrator
                                   (ai_model_pricing)                     POST /credit/deduct
                                   credits per token                      amount in credits
```

All prices and costs are in **Aisee credits** ($1 = 100 credits). No USD-to-credit conversion is needed — the entire pipeline operates in credits.

## AiseeClient

HTTP client for communicating with aisee_orchestrator.

### Environment Variables

```env
# Required: aisee orchestrator base URL
AISEE_ORCHESTRATOR_URL="http://localhost:8000"

# Optional: API key for authentication
AISEE_API_KEY="your-api-key"
```

When `AISEE_ORCHESTRATOR_URL` is not set, `AiseeClient` is disabled — `deductCredits()` returns `{ success: true, skipped: true }`.

### Methods

| Method | Description |
|--------|-------------|
| `deductCredits(req)` | POST to `/credit/deduct` with userId, amount, taskId, description |
| `getBalance(userId)` | GET `/credit-balance/{userId}/balance` |
| `AiseeClient.buildTaskId(postId)` | Returns `postiz_{postId}` |

### AiseeDeductRequest

```typescript
interface AiseeDeductRequest {
  userId: string;
  amount: string;     // cost in credits from AiPricingService.calculateCost()
  taskId: string;     // format: postiz_{label}_{random}
  description: string;
  businessType: AiseeBusinessType;  // 'ai_copywriting' | 'image_gen'
  costItems: AiseeCostItem[];       // breakdown of individual costs
}
```

### AiseeDeductResponse

```typescript
interface AiseeDeductResponse {
  success: boolean;
  skipped?: boolean;        // true when aisee is not configured
  transactionId?: string;
  remainingBalance?: number;
  error?: string;
}
```

## Task ID Format

All Postiz operations use the format `postiz_{postId}` as the task_id for aisee credit deduction. This allows tracing costs back to specific posts.

## Pending Work

- **aisee_orchestrator** needs a new `POST /credit/deduct` endpoint that wraps `credit_service.consume_credits()`. Currently only internal methods exist for credit deduction.
- **media.service.ts** integration: replace current `useCredit()` flow with `AiPricingService.calculateCost()` + `AiseeClient.deductCredits()`.

## Key Files

- `libraries/nestjs-libraries/src/database/prisma/ai-pricing/aisee.client.ts`
- `libraries/nestjs-libraries/src/database/prisma/ai-pricing/ai-pricing.service.ts`

# Aisee Integration

## Overview

Postiz integrates with [aisee_orchestrator](../aisee-core/aisee_orchestrator/) for credit-based billing. Postiz handles AI model pricing and cost calculation; aisee handles credit balance and deduction.

Billing mode is controlled by `BILL_TYPE` env var:
- `internal` — legacy Stripe-based subscription billing (Credits table). BillingRecord still created (status=`internal`) for unified AI operation tracking.
- `third` (default) — Aisee handles all billing externally. BillingRecord tracks deduction lifecycle (pending→success/failed/skipped).

See [aisee-billing-env.md](./aisee-billing-env.md) for full environment variable reference.

## Architecture

```
AI Call → logAiUsage(AiUsageInfo) → AiPricingService.calculateCost() → AiseeCreditService.deductWithItems()
                                          ↓                                      ↓
                                   Settings table                     1. Create BillingRecord (always)
                                   (ai_model_pricing)                    - BILL_TYPE=internal → status='internal', stop
                                   credits per token                     - BILL_TYPE=third    → status='pending', continue:
                                                                      2. POST /credit/deduct (with postiz_billing_id)
                                                                      3. Update BillingRecord (success/failed/skipped)
                                                                      4. POST /credit/deduct/confirm (fire-and-forget)
```

### Agent Chat Billing Flow

```
POST /copilot/agent
  → checkMinChatCredits() → 402 if balance < estimated min cost
  → runWithContext({ usages: [] })
      → handler(req, res)
          → Mastra Agent → LLM (withBillingTracking Proxy)
              → doStream finish → collectUsage() → writes to AsyncLocalStorage
  → res.on('close')
      → billAfterResponse()
          → getCollectedUsages() from ALS
          → logAiUsage()
          → AiseeCreditService.billCollectedUsages() → POST /credit/deduct (fire-and-forget)
```

All prices and costs are in **Aisee credits** ($1 = 100 credits). No USD-to-credit conversion is needed — the entire pipeline operates in credits.

## User ID Resolution (organizationId → Aisee userId)

Aisee bills by **user**, but Postiz's AI operations are scoped to **organizations**. The `AiseeCreditService` transparently resolves this:

```
Caller passes organizationId
  → resolveOwnerUserId(organizationId)
      → UserOrganization table: find SUPERADMIN (preferred) or ADMIN
      → returns userId
  → AiseeClient calls Aisee API with resolved userId
```

- Callers (agent, media service, copilot) always pass `organizationId` as `opts.userId`
- `AiseeCreditService` resolves it internally before every Aisee API call (`getBalance`, `deductCredits`)
- The resolved userId is cached for 5 minutes to avoid repeated DB lookups
- `BillingRecord` stores the original `organizationId` (local audit), not the resolved userId
- If no SUPERADMIN/ADMIN is found, falls back to `organizationId` with a warning log

**Important**: When creating users in Aisee, use the Postiz **User.id** (not Organization.id). The billing owner is the organization's SUPERADMIN.

## AiseeClient

HTTP client for communicating with aisee_orchestrator.

### Environment Variables

```env
# Required: aisee orchestrator base URL (only when BILL_TYPE=third)
AISEE_ORCHESTRATOR_URL="http://localhost:8000"

# Required: shared JWT secret for service-to-service auth
JWT_SECRET="your-jwt-secret"
```

When `AISEE_ORCHESTRATOR_URL` is not set, `AiseeClient` is disabled — `deductCredits()` returns `{ success: true, skipped: true }`.

### Methods

| Method | Description |
|--------|-------------|
| `deductCredits(req)` | POST to `/credit/deduct` with Aisee userId, amount, taskId, postiz_billing_id |
| `confirmDeduction(req)` | POST to `/credit/deduct/confirm` with taskId, status (success/failed) |
| `getBalance(userId)` | GET `/credit/balance/{userId}` — expects **Aisee user ID** (not org ID) |
| `AiseeClient.buildTaskId(label)` | Returns `postiz_{label}_{random}` |

> **Note**: `AiseeClient` methods expect the **resolved Aisee user ID**. Do not pass `organizationId` directly — use `AiseeCreditService` which handles the resolution automatically.

### AiseeDeductRequest

```typescript
interface AiseeDeductRequest {
  userId: string;
  amount: string;       // cost in credits from AiPricingService.calculateCost()
  taskId: string;       // format: postiz_{label}_{random}
  description: string;
  relatedId?: string;   // business entity ID → Aisee Transaction.related_id column
  data?: {              // all business metadata → Aisee transaction.data (stored as-is)
    business_type: string;      // 'ai_copywriting' | 'image_gen' | 'video_gen'
    sub_type?: string;          // 'chat' | 'post_gen' | 'image' | 'video'
    cost_items: AiseeCostItem[];
    postiz_billing_id?: string;
    [key: string]: unknown;     // prompt, format, tone, etc.
  };
}
```

**Wire format** — `related_id` is a top-level field (stored as Aisee Transaction column, indexed). All other business metadata goes into `data` dict which Aisee stores as-is without parsing.

### AiseeDeductResponse

```typescript
interface AiseeDeductResponse {
  success: boolean;
  skipped?: boolean;        // true when aisee is not configured
  transactionId?: string;
  remainingBalance?: string;
  debtAmount?: string;      // non-null when user balance went negative
  error?: string;
}
```

## Local Audit Trail (BillingRecord)

**Every AI operation creates a BillingRecord**, regardless of `BILL_TYPE`:

```
BillingRecord.id  →  sent as postiz_billing_id  →  enables cross-system reconciliation
```

The record tracks: taskId, amount, businessType, subType (fine-grained categorization), costItems (JSON), relatedId (optional business entity), data (JSON business context), status, transactionId, remainingBalance, debtAmount, error.

| Status | Meaning |
|--------|---------|
| `pending` | Record created, Aisee call not yet made |
| `success` | Aisee deduction confirmed |
| `failed` | Aisee deduction failed or refunded |
| `skipped` | Aisee not configured (self-hosted) |
| `internal` | BILL_TYPE=internal, subscription billing, no Aisee call |

The `data` field (JSON) stores flexible business context: prompt, generation parameters, associated entity IDs. It supports **back-filling** via `associateEntity(taskId, { relatedId, data })` — used when business entities (Post, Media) are created after AI generation.

If the local DB write fails, the deduction proceeds anyway — billing must not be blocked by audit failures.

## Task ID Format

All Postiz operations use the format `postiz_{label}_{random}` as the task_id for aisee credit deduction. Examples:
- Agent chat: `postiz_agent_chat_{orgId}_{timestamp}_{random}`
- Image generation: `postiz_img_{orgId}_{timestamp}_{random}`
- Agent post generation: `postiz_agent_{orgId}_{timestamp}_{random}`

## Billing Touchpoints

| Scenario | Trigger | Business Type | Sub Type | relatedId | BILL_TYPE=internal | BILL_TYPE=third |
|----------|---------|---------------|----------|-----------|--------------------|-----------------
| **Copilot chat** | `POST /copilot/agent` | `ai_copywriting` | `chat` | threadId | Aisee (pre-check + post-billing) | Same |
| **Image generation** | `POST /media/generate-image` | `image_gen` | `image` | null | Subscription useCredit() only | Aisee credits only |
| **Image gen+save** | `POST /media/generate-image-with-prompt` | `image_gen` | `image` | mediaId | Subscription useCredit() only | Aisee credits only |
| **Agent post generation** | Agent workflow | `ai_copywriting` | `post_gen` | null | Aisee only | Same |
| **Video generation** | `POST /media/generate-video` | `video_gen` | — | — | Subscription useCredit() | **TODO**: Aisee (pending KieAI) |

## AiseeCreditService

Orchestrates the credit lifecycle. All methods accept `organizationId` and internally resolve it to the Aisee user ID via `resolveOwnerUserId()`.

| Method | Description |
|--------|-------------|
| `resolveOwnerUserId(orgId)` | Resolves org → owner user ID (SUPERADMIN > ADMIN), cached 5 min |
| `getBalance(orgId)` | Returns credit balance (null if Aisee disabled) |
| `hasCredits(orgId)` | Returns `true` if balance > 0 or Aisee disabled |
| `executeWithBilling(opts, llmCall)` | Single-step: check balance → execute → calculate cost → deduct |
| `executeMultiStepWithBilling(opts, llmCall)` | Multi-step: check balance → execute → aggregate costs → single deduct |
| `billCollectedUsages(opts, usages)` | Post-hoc billing for already-collected usages (agent chat) |
| `confirmFailed(taskId)` | Confirm deduction as failed — triggers refund on Aisee side |
| `associateEntity(taskId, update)` | Back-fill relatedId + data on existing BillingRecord (merge semantics) |

`opts.userId` in `AiseeCreditExecOptions` is the **organizationId** (naming is historical). The resolution to Aisee user ID happens inside the service.

All deduction methods create a local BillingRecord (keyed by `organizationId`) — in both billing modes. `BILL_TYPE=internal` sets status='internal' and skips Aisee call; `BILL_TYPE=third` proceeds with deduction.

`opts.data` (optional JSON) stores business context (prompt, generation params). It is saved to BillingRecord.data and also merged into the Aisee `data` payload (alongside `business_type`, `sub_type`, `cost_items`, etc.).

## Admin Billing API

Billing records can be managed via `/admin/billing/*` endpoints (requires `@SuperAdmin()`):
- **List / detail / summary** — query and aggregate records
- **Associate** — `PATCH /associate/:taskId` back-fills `relatedId` and `data` (merge semantics)
- **Retry** — re-send failed deductions to Aisee (guards against retrying `internal` or `skipped` records)

See [aisee-billing-env.md](./aisee-billing-env.md#admin-billing-api) for the full endpoint reference.

## Key Files

- `libraries/nestjs-libraries/src/services/billing.helper.ts` — `getBillType()`, `isInternalBilling()`, `isThirdPartyBilling()`
- `libraries/nestjs-libraries/src/database/prisma/ai-pricing/aisee.client.ts`
- `libraries/nestjs-libraries/src/database/prisma/ai-pricing/aisee-credit.service.ts`
- `libraries/nestjs-libraries/src/database/prisma/ai-pricing/ai-pricing.service.ts`
- `libraries/nestjs-libraries/src/database/prisma/media/media.service.ts` — Image/video billing (branches on BILL_TYPE)
- `libraries/nestjs-libraries/src/chat/billing.middleware.ts` — Agent chat token tracking (ALS context snapshot)
- `apps/backend/src/api/routes/copilot.controller.ts` — Pre-check + post-billing wiring
- `apps/backend/src/api/routes/stripe.controller.ts` — Stripe webhook (branches on BILL_TYPE)
- `apps/backend/src/api/routes/billing.controller.ts` — Billing API (branches on BILL_TYPE)
- `apps/backend/src/admin-api/routes/admin-billing.controller.ts` — Admin billing list + retry

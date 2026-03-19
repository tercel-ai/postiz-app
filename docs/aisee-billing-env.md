# Billing Configuration

## BILL_TYPE

Controls which billing system is active:

| Value | Description |
|-------|-------------|
| `internal` | Legacy Stripe-based subscription billing. Credits table tracks per-operation quotas (ai_images, ai_videos). Stripe webhooks process subscription lifecycle events. |
| `third` **(default)** | Aisee (`../aisee-core`) handles all billing externally. BillingRecord table stores local audit trail. Stripe endpoints return stubs. Subscription quotas are not enforced locally. |

## Environment Variables

### Always required

| Variable | Description | Example |
|----------|-------------|---------|
| `BILL_TYPE` | Billing mode: `internal` or `third` (default: `third`) | `third` |
| `JWT_SECRET` | Shared secret for signing service-to-service JWTs. Must match Aisee config. | `my-super-secret` |

### Required when `BILL_TYPE=third`

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `AISEE_ORCHESTRATOR_URL` | **Yes** | Base URL of the Aisee orchestrator service. When unset, all deductions are skipped (self-hosted mode). | `http://localhost:8000` |

### Required when `BILL_TYPE=internal`

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe API key |
| `STRIPE_SIGNING_KEY` | Stripe webhook signing secret |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key (frontend) |
| `FEE_AMOUNT` | Platform fee amount |

## How Aisee Billing Works (`BILL_TYPE=third`)

### 1. Aisee Client (`aisee.client.ts`)

Communicates with the Aisee orchestrator REST API:

- **`GET /credit/balance/{user_id}`** — Check credit balance (subscription + top-up + bonus).
- **`POST /credit/deduct`** — Deduct credits. Sends `task_id` (idempotency key), `amount`, `cost_items` breakdown, and `postiz_billing_id` (Postiz `BillingRecord.id` for reconciliation).
- **`POST /credit/deduct/confirm`** — Confirm deduction as `success` or `failed` (triggers refund on failure).

All requests include a short-lived JWT (`Authorization: Bearer <token>`) signed with `JWT_SECRET`.

### 2. Local Audit Trail (`BillingRecord` table)

Every deduction creates a local `BillingRecord` row **before** calling Aisee:

```
BillingRecord.id  →  sent to Aisee as postiz_billing_id  →  enables cross-system reconciliation
```

| Field | Description |
|-------|-------------|
| `id` | UUID, created before Aisee call, sent as `postiz_billing_id` |
| `taskId` | Idempotency key (`postiz_{label}_{random}`) — unique index |
| `amount` | Total cost in Aisee credits (decimal string) |
| `businessType` | `ai_copywriting` / `image_gen` / `video_gen` |
| `costItems` | JSON-serialised `AiseeCostItem[]` breakdown |
| `relatedId` | Optional related entity ID (e.g. post ID, media ID) for business context |
| `status` | `pending` → `success` / `failed` / `skipped` |
| `transactionId` | Aisee transaction ID (set after successful deduction) |
| `remainingBalance` | User's remaining balance after deduction |
| `debtAmount` | Non-null if user went into debt |
| `error` | Error message if deduction failed |

### 3. Billing Touchpoints

| Scenario | Trigger | Business Type | BILL_TYPE=internal | BILL_TYPE=third |
|----------|---------|---------------|--------------------|-----------------
| **Copilot chat** | `POST /copilot/agent` | `ai_copywriting` | Aisee (pre-check + post-billing) | Same |
| **Image generation** | `POST /media/generate-image` | `image_gen` | Subscription useCredit() only | Aisee credits only |
| **Agent post generation** | Agent workflow | `ai_copywriting` | Aisee only | Same |
| **Video generation** | `POST /media/generate-video` | `video_gen` | Subscription useCredit() | **TODO**: Aisee (pending KieAI) |
| **Stripe webhooks** | `POST /stripe` | — | Active | Skipped |
| **Billing endpoints** | `/billing/*` | — | Active | Stubs |

### 4. Self-Hosted Mode (`BILL_TYPE=third` without `AISEE_ORCHESTRATOR_URL`)

- `AiseeClient.enabled` returns `false`
- All deduction calls return `{ success: true, skipped: true }`
- `BillingRecord` is still created locally with `status = 'skipped'`
- Balance checks return `null` (treated as "unlimited")

## Database Tables

### Credits (BILL_TYPE=internal only)

Subscription-based per-operation counter. Tracks monthly quota usage for `ai_images` and `ai_videos`.

### BillingRecord (BILL_TYPE=third only)

Local audit trail with `postiz_billing_id` sent to Aisee for reconciliation. Supports `relatedId` for linking to business entities (posts, media, etc.).

## Admin Billing API

All endpoints require `@SuperAdmin()` permission.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/billing/records` | GET | List billing records with filters (`status`, `organizationId`, `businessType`, pagination) |
| `/admin/billing/records/:id` | GET | Single record detail with parsed `costItems` |
| `/admin/billing/summary` | GET | Aggregated counts by status and businessType |
| `/admin/billing/retry/:id` | POST | Retry single failed/pending record — re-sends deduction to Aisee |
| `/admin/billing/retry-all-failed` | POST | Batch retry all `failed` records sequentially |

Retry uses the original `taskId` (idempotency key), so duplicate deductions are prevented by Aisee.

## Key Files

| File | Purpose |
|------|---------|
| `libraries/.../services/billing.helper.ts` | `getBillType()`, `isInternalBilling()`, `isThirdPartyBilling()` |
| `libraries/.../ai-pricing/aisee.client.ts` | HTTP client for Aisee orchestrator |
| `libraries/.../ai-pricing/aisee-credit.service.ts` | Credit lifecycle orchestration + local BillingRecord |
| `libraries/.../ai-pricing/ai-pricing.service.ts` | Cost calculation (token/image → credits) |
| `libraries/.../media/media.service.ts` | Image/video generation billing (branches on BILL_TYPE) |
| `libraries/.../chat/billing.middleware.ts` | Agent chat token tracking (ALS context snapshot for TransformStream) |
| `apps/backend/.../copilot.controller.ts` | Copilot chat billing |
| `apps/backend/.../stripe.controller.ts` | Stripe webhook (branches on BILL_TYPE) |
| `apps/backend/.../billing.controller.ts` | Billing API (branches on BILL_TYPE) |
| `apps/backend/.../admin-billing.controller.ts` | Admin billing list + retry API |

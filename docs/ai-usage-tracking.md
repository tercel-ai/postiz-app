# AI Usage Tracking

## Overview

All AI calls (text and image generation) across OpenAI SDK, OpenRouter fetch, and LangChain ChatOpenAI are tracked with a unified logging format. This provides visibility into token consumption, model usage, and billing data.

## Unified Naming Convention (LiteLLM-compatible)

| Field | Meaning | Example |
|-------|---------|---------|
| `servicer` | API service provider (who you pay) | `openrouter`, `openai` |
| `provider` | Model maker | `google`, `openai`, `anthropic` |
| `model` | Bare model name | `gpt-5.1`, `gemini-3.1-flash-image-preview` |

Model IDs like `google/gemini-3.1-flash-image-preview` are parsed by `parseModelId()` into `provider=google`, `model=gemini-3.1-flash-image-preview`.

## AiUsageInfo Interface

```typescript
interface AiUsageInfo {
  servicer: string;
  provider: string;
  model: string;
  type: 'text' | 'image';
  billing_mode: 'per_token' | 'per_image';
  method: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_prompt_tokens?: number;
  };
  image_billing?: {
    count: number;
    size: string;
    quality: string;
  };
}
```

## Billing Mode

Determined by the model's actual response:

- `per_token` — model returns token usage (`total_tokens > 0`). Text models and some image models (e.g., Gemini image generation via OpenRouter).
- `per_image` — no token usage returned. DALL-E and similar per-image models.

## Tracked Methods

### openai.service.ts (9 methods)

| Method | Type | Notes |
|--------|------|-------|
| `generateImage` | image | DALL-E 3 (per_image) |
| `generateImageViaOpenRouter` | image | Auto-detects billing_mode |
| `generatePromptForPicture` | text | |
| `generateVoiceFromText` | text | |
| `generatePosts` | text | 2 parallel calls tracked separately |
| `extractWebsiteText` | text | |
| `separatePosts` | text | Includes shrink retries |
| `generateSlidesFromText` | text | |

### agent.graph.service.ts (LangChain)

| Method | Type | Notes |
|--------|------|-------|
| `AiUsageCallbackHandler.handleLLMEnd` | text | Intercepts all ChatOpenAI calls |
| `generatePictures` | image | DALL-E via DallEAPIWrapper |

### billing.middleware.ts (Agent Chat via CopilotKit)

| Method | Type | Notes |
|--------|------|-------|
| `withBillingTracking` Proxy → `doGenerate` | text | Captures usage from non-streaming LLM calls |
| `withBillingTracking` Proxy → `doStream` finish chunk | text | Captures usage from streaming LLM calls |

The billing middleware wraps the ai-sdk `LanguageModelV2` with a `Proxy` that intercepts `doGenerate` and `doStream`. Token usage is collected into `AsyncLocalStorage` via `collectUsage()`, then billed via `AiseeCreditService.billCollectedUsages()` when the HTTP response stream closes.

## Log Format

```
[AI Usage] servicer=openrouter provider=google model=gemini-3.1-flash-image-preview type=image billing_mode=per_token method=generateImageViaOpenRouter prompt_tokens=50 completion_tokens=1200 total_tokens=1250
```

## Billing Integration

Tracked `AiUsageInfo` feeds into `AiPricingService.calculateCost()` for credit calculation, then into `AiseeCreditService` for deduction. The billing path depends on `BILL_TYPE`:

- `BILL_TYPE=internal` — Image/video generation uses subscription-based `useCredit()` quotas only (no Aisee). Copilot chat and Agent workflows always use Aisee.
- `BILL_TYPE=third` — All AI usage is billed via Aisee. Local `BillingRecord` provides audit trail.

See [aisee-billing-env.md](./aisee-billing-env.md) for details.

## Implementation Note: AsyncLocalStorage in TransformStream

The `withBillingTracking()` proxy intercepts `doStream` and wraps the stream with a `TransformStream` to capture token usage from the `finish` chunk. However, `TransformStream.transform` callbacks run in a detached async context where `AsyncLocalStorage.getStore()` returns `undefined`.

**Fix**: The middleware captures the ALS store reference (`ctxSnapshot = getContext()`) before creating the TransformStream, then writes directly to `ctxSnapshot.usages` inside the transform callback. A fallback to `collectUsage()` (ALS-based) is kept for environments where Node.js does propagate context.

This is covered by tests in `chat/__tests__/billing.middleware.spec.ts`.

## Key Files

- `libraries/nestjs-libraries/src/openai/openai.service.ts` — `AiUsageInfo`, `parseModelId()`, `logAiUsage()`
- `libraries/nestjs-libraries/src/agent/agent.graph.service.ts` — `AiUsageCallbackHandler`
- `libraries/nestjs-libraries/src/chat/billing.middleware.ts` — `withBillingTracking()` Proxy for agent chat (ALS snapshot)
- `libraries/nestjs-libraries/src/chat/async.storage.ts` — `collectUsage()`, `getCollectedUsages()`, `getContext()`
- `libraries/nestjs-libraries/src/services/billing.helper.ts` — `getBillType()`, `isInternalBilling()`

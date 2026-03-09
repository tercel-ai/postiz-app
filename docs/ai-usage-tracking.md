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

## Log Format

```
[AI Usage] servicer=openrouter provider=google model=gemini-3.1-flash-image-preview type=image billing_mode=per_token method=generateImageViaOpenRouter prompt_tokens=50 completion_tokens=1200 total_tokens=1250
```

## Key Files

- `libraries/nestjs-libraries/src/openai/openai.service.ts` — `AiUsageInfo`, `parseModelId()`, `logAiUsage()`
- `libraries/nestjs-libraries/src/agent/agent.graph.service.ts` — `AiUsageCallbackHandler`

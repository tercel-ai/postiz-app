# OpenRouter Integration Guide

## Overview

Postiz supports [OpenRouter](https://openrouter.ai/) as an alternative AI provider. This allows you to use OpenRouter's unified API to access various models (Google Gemini, OpenAI GPT, Anthropic Claude, etc.) for both **image generation** and **text generation**, without needing a direct OpenAI API key.

## Environment Variables

Add the following to your `.env` file:

```env
# AI Provider — "openai" (default, uses DALL-E 3 + GPT) or "openrouter"
IMAGE_PROVIDER="openrouter"

# Your OpenRouter API key (required when IMAGE_PROVIDER=openrouter)
OPENROUTER_API_KEY="sk-or-v1-..."

# Model for image generation (default: google/gemini-3.1-flash-image-preview)
OPENROUTER_IMAGE_MODEL="google/gemini-3.1-flash-image-preview"

# Model for text generation — post creation, prompt enhancement, etc. (default: openai/gpt-5.1)
OPENROUTER_TEXT_MODEL="openai/gpt-5.1"
```

## Configuration Scenarios

### Scenario 1: OpenRouter only (no OpenAI key)

```env
IMAGE_PROVIDER="openrouter"
OPENROUTER_API_KEY="sk-or-v1-..."
OPENAI_API_KEY=""            # empty or omitted
```

All AI features route through OpenRouter:
- Image generation → `OPENROUTER_IMAGE_MODEL`
- Text generation (posts, prompts, voice, slides, etc.) → `OPENROUTER_TEXT_MODEL`
- **Agent chat** → driven by `ai_model_pricing.text` config (see [ai-pricing-module.md](./ai-pricing-module.md)), falls back to `OPENROUTER_TEXT_MODEL` if no config exists

### Scenario 2: OpenRouter for images, OpenAI for text

```env
IMAGE_PROVIDER="openrouter"
OPENROUTER_API_KEY="sk-or-v1-..."
OPENAI_API_KEY="sk-proj-..."  # valid OpenAI key
```

- Image generation → OpenRouter (`OPENROUTER_IMAGE_MODEL`)
- Text generation → OpenAI (`gpt-5.1`) — since a valid OpenAI key is present

### Scenario 3: OpenAI only (default, no changes needed)

```env
OPENAI_API_KEY="sk-proj-..."
# IMAGE_PROVIDER is unset or "openai"
```

Everything uses OpenAI as before (DALL-E 3 for images, GPT for text). No OpenRouter variables needed.

## Features Covered

| Feature | OpenRouter Support | API Used |
|---------|:-:|----------|
| Image generation (`/media/generate-image`) | Yes | `chat/completions` with `modalities: ["image", "text"]` |
| Image prompt enhancement (`/media/generate-image-with-prompt`) | Yes | `chat/completions` with structured output |
| Post generation (AI compose) | Yes | `chat/completions` |
| Website text extraction | Yes | `chat/completions` |
| Post thread splitting | Yes | `chat/completions` with structured output |
| Voice text generation | Yes | `chat/completions` with structured output |
| Slide generation from text | Yes | `chat/completions` with structured output |

## Recommended Models

### Image Generation (`OPENROUTER_IMAGE_MODEL`)

| Model | Notes |
|-------|-------|
| `google/gemini-3.1-flash-image-preview` | Default. Fast, good quality. |
| `google/gemini-2.0-flash-exp:free` | Free tier available. |

The image model must support `modalities: ["image", "text"]` in the OpenRouter API.

### Text Generation (`OPENROUTER_TEXT_MODEL`)

| Model | Notes |
|-------|-------|
| `openai/gpt-5.1` | Default. Best structured output support. |
| `anthropic/claude-sonnet-4` | Strong alternative. |
| `google/gemini-2.5-flash-preview` | Fast and cost-effective. |

The text model must support `response_format` with JSON schema (structured output) for features like post splitting, slide generation, etc.

## How It Works

### Image Generation

OpenRouter's image generation uses the `chat/completions` endpoint with special parameters:

```
POST https://openrouter.ai/api/v1/chat/completions
{
  "model": "google/gemini-3.1-flash-image-preview",
  "messages": [{ "role": "user", "content": "a sunset over mountains" }],
  "modalities": ["image", "text"],
  "image_config": {
    "aspect_ratio": "1:1"   // or "9:16" for vertical
  }
}
```

The response contains an `image_url` part with a base64 data URI, which is then saved to your configured storage provider (local or Cloudflare R2).

### Text Generation

Text features use the OpenAI SDK pointed at OpenRouter's compatible endpoint (`https://openrouter.ai/api/v1`). This means all existing structured output features (`.parse()` with Zod schemas) work seamlessly — no special handling needed.

## Data URI Bug Fix

As part of this integration, a bug was fixed in both `LocalStorage` and `CloudflareStorage`: the `uploadSimple()` method now correctly handles `data:` URIs (e.g., `data:image/png;base64,...`). Previously, these were incorrectly passed to HTTP clients (`axios.get` / `fetch`) which would fail. This fix benefits both OpenRouter and DALL-E image generation paths.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `OPENROUTER_API_KEY is required...` | Set `OPENROUTER_API_KEY` in your `.env` when using `IMAGE_PROVIDER=openrouter` |
| `OpenRouter image generation failed (401)` | Check your API key is valid and has credits |
| `OpenRouter response did not contain an image` | Your `OPENROUTER_IMAGE_MODEL` may not support image generation. Use a model with `modalities: ["image"]` support. |
| `generatePosts` fails with `n` parameter error | Some models don't support `n > 1`. Switch `OPENROUTER_TEXT_MODEL` to `openai/gpt-4.1` which supports it. |
| Structured output errors | Ensure your `OPENROUTER_TEXT_MODEL` supports JSON schema `response_format`. GPT-5.1 and Claude models do. |

import { describe, it, expect } from 'vitest';
import {
  resolveCopilotOpenAiCtor,
  createCopilotOpenRouterClient,
} from '../copilot-openai-client';

// ---------------------------------------------------------------------------
// Regression guard for the /copilot/chat crash.
//
// @copilotkit/runtime's OpenAIAdapter calls `openai.beta.chat.completions.stream()`,
// an openai v4 API that v6 removed. The root install is v6, so injecting a
// root-imported client (what the OpenRouter branch of createServiceAdapter used
// to do) made every /copilot/chat request throw
// `TypeError: Cannot read properties of undefined (reading 'completions')`.
//
// These tests pin both halves of the fix: the client we hand the adapter has the
// namespace the adapter needs, and the root import still does not — so a future
// change that reintroduces the root client fails here instead of in production.
// ---------------------------------------------------------------------------

describe('copilot openai client', () => {
  it('resolves a constructor whose instances expose beta.chat.completions.stream', () => {
    const Ctor = resolveCopilotOpenAiCtor();
    const client = new Ctor({ apiKey: 'test-key' });

    expect(typeof client.beta.chat.completions.stream).toBe('function');
  });

  it('caches the resolved constructor', () => {
    expect(resolveCopilotOpenAiCtor()).toBe(resolveCopilotOpenAiCtor());
  });

  it('points the OpenRouter client at the OpenRouter base URL', () => {
    const client = createCopilotOpenRouterClient('or-test-key') as any;

    expect(client.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(client.apiKey).toBe('or-test-key');
    expect(typeof client.beta.chat.completions.stream).toBe('function');
  });

  it('documents why the root openai import cannot be used', async () => {
    // If this ever starts passing, the root openai has regained beta.chat and
    // the indirection in copilot-openai-client.ts can be deleted.
    const mod: any = await import('openai');
    const RootOpenAI = mod.default || mod;
    const rootClient = new RootOpenAI({ apiKey: 'test-key' });

    expect(rootClient.beta.chat).toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withBillingTracking } from '../billing.middleware';
import { runWithContext, getCollectedUsages } from '../async.storage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockModel(options?: {
  doGenerateUsage?: { promptTokens: number; completionTokens: number };
  doStreamUsage?: { promptTokens: number; completionTokens: number };
}) {
  const generateUsage = options?.doGenerateUsage || {
    promptTokens: 100,
    completionTokens: 200,
  };
  const streamUsage = options?.doStreamUsage || {
    promptTokens: 150,
    completionTokens: 300,
  };

  return {
    provider: 'openrouter',
    modelId: 'openai/gpt-4.1',

    doGenerate: vi.fn().mockResolvedValue({
      text: 'Hello world',
      usage: generateUsage,
    }),

    doStream: vi.fn().mockResolvedValue({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-delta', textDelta: 'Hello' });
          controller.enqueue({ type: 'text-delta', textDelta: ' world' });
          controller.enqueue({
            type: 'finish',
            usage: streamUsage,
          });
          controller.close();
        },
      }),
    }),
  };
}

async function consumeStream(stream: ReadableStream): Promise<any[]> {
  const reader = stream.getReader();
  const chunks: any[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('withBillingTracking', () => {
  it('doGenerate — collects usage within ALS context', async () => {
    const model = createMockModel();
    const tracked = withBillingTracking(model);

    const usages = await runWithContext(
      { requestId: 'test-1', auth: {}, usages: [] },
      async () => {
        await tracked.doGenerate({} as any);
        return getCollectedUsages();
      }
    );

    expect(usages).toHaveLength(1);
    expect(usages[0].servicer).toBe('openrouter');
    expect(usages[0].provider).toBe('openai');
    expect(usages[0].model).toBe('gpt-4.1');
    expect(usages[0].usage.prompt_tokens).toBe(100);
    expect(usages[0].usage.completion_tokens).toBe(200);
    expect(usages[0].usage.total_tokens).toBe(300);
    expect(usages[0].type).toBe('text');
    expect(usages[0].billing_mode).toBe('per_token');
  });

  it('doStream — collects usage from finish chunk despite TransformStream ALS loss', async () => {
    const model = createMockModel({
      doStreamUsage: { promptTokens: 500, completionTokens: 1000 },
    });
    const tracked = withBillingTracking(model);

    const usages = await runWithContext(
      { requestId: 'test-2', auth: {}, usages: [] },
      async () => {
        const result = await tracked.doStream({} as any);
        // Consume the stream fully — this triggers the transform callback
        await consumeStream(result.stream);
        return getCollectedUsages();
      }
    );

    expect(usages).toHaveLength(1);
    expect(usages[0].usage.prompt_tokens).toBe(500);
    expect(usages[0].usage.completion_tokens).toBe(1000);
    expect(usages[0].usage.total_tokens).toBe(1500);
    expect(usages[0].method).toBe('agent_chat');
  });

  it('doStream — chunks are passed through unmodified', async () => {
    const model = createMockModel();
    const tracked = withBillingTracking(model);

    const chunks = await runWithContext(
      { requestId: 'test-3', auth: {}, usages: [] },
      async () => {
        const result = await tracked.doStream({} as any);
        return consumeStream(result.stream);
      }
    );

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ type: 'text-delta', textDelta: 'Hello' });
    expect(chunks[1]).toEqual({ type: 'text-delta', textDelta: ' world' });
    expect(chunks[2].type).toBe('finish');
  });

  it('doStream without usage in finish chunk — no usage collected', async () => {
    const model = {
      provider: 'openai',
      modelId: 'gpt-4.1',
      doStream: vi.fn().mockResolvedValue({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'finish' }); // no usage field
            controller.close();
          },
        }),
      }),
    };

    const tracked = withBillingTracking(model);

    const usages = await runWithContext(
      { requestId: 'test-4', auth: {}, usages: [] },
      async () => {
        const result = await tracked.doStream({} as any);
        await consumeStream(result.stream);
        return getCollectedUsages();
      }
    );

    expect(usages).toHaveLength(0);
  });

  it('doStream with null stream — returns result as-is', async () => {
    const model = {
      provider: 'openai',
      modelId: 'gpt-4.1',
      doStream: vi.fn().mockResolvedValue({ stream: null }),
    };

    const tracked = withBillingTracking(model);

    const result = await runWithContext(
      { requestId: 'test-5', auth: {}, usages: [] },
      async () => tracked.doStream({} as any)
    );

    expect(result.stream).toBeNull();
  });

  it('multiple doGenerate calls — accumulates usages', async () => {
    const model = createMockModel();
    const tracked = withBillingTracking(model);

    const usages = await runWithContext(
      { requestId: 'test-6', auth: {}, usages: [] },
      async () => {
        await tracked.doGenerate({} as any);
        await tracked.doGenerate({} as any);
        await tracked.doGenerate({} as any);
        return getCollectedUsages();
      }
    );

    expect(usages).toHaveLength(3);
  });

  it('mixed doGenerate + doStream — all usages collected', async () => {
    const model = createMockModel();
    const tracked = withBillingTracking(model);

    const usages = await runWithContext(
      { requestId: 'test-7', auth: {}, usages: [] },
      async () => {
        await tracked.doGenerate({} as any);
        const streamResult = await tracked.doStream({} as any);
        await consumeStream(streamResult.stream);
        return getCollectedUsages();
      }
    );

    expect(usages).toHaveLength(2);
    expect(usages[0].usage.prompt_tokens).toBe(100); // doGenerate
    expect(usages[1].usage.prompt_tokens).toBe(150); // doStream
  });

  it('openai provider detection — non-openrouter', async () => {
    const model = {
      provider: 'openai.chat',
      modelId: 'gpt-4.1',
      doGenerate: vi.fn().mockResolvedValue({
        text: 'test',
        usage: { promptTokens: 10, completionTokens: 20 },
      }),
    };

    const tracked = withBillingTracking(model);

    const usages = await runWithContext(
      { requestId: 'test-8', auth: {}, usages: [] },
      async () => {
        await tracked.doGenerate({} as any);
        return getCollectedUsages();
      }
    );

    expect(usages[0].servicer).toBe('openai');
  });

  it('other properties are proxied through', async () => {
    const model = {
      provider: 'openrouter',
      modelId: 'openai/gpt-4.1',
      someOtherMethod: vi.fn().mockReturnValue('test'),
      doGenerate: vi.fn(),
      doStream: vi.fn(),
    };

    const tracked = withBillingTracking(model);
    expect(tracked.provider).toBe('openrouter');
    expect(tracked.modelId).toBe('openai/gpt-4.1');
    expect(tracked.someOtherMethod()).toBe('test');
  });
});

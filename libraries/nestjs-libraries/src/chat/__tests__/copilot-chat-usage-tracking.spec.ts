import { describe, it, expect, vi, afterEach } from 'vitest';
import { withCopilotChatUsageTracking } from '../billing.middleware';
import { runWithContext, getCollectedUsages } from '../async.storage';

// ---------------------------------------------------------------------------
// Usage capture for /copilot/chat.
//
// The adapter reaches the model through `openai.beta.chat.completions.stream()`
// and never sets `stream_options`, so without the injection below the upstream
// response carries no `usage` at all and nothing can be billed. These tests pin
// both halves: the injection, and the capture of what comes back.
// ---------------------------------------------------------------------------

type Listener = (payload: any) => void;

/** Minimal stand-in for openai v4's ChatCompletionStream. */
function createFakeStream() {
  const listeners: Record<string, Listener[]> = {};
  return {
    on(event: string, listener: Listener) {
      (listeners[event] ||= []).push(listener);
      return this;
    },
    emit(event: string, payload?: any) {
      (listeners[event] ?? []).forEach((l) => l(payload));
    },
    listenerCount(event: string) {
      return (listeners[event] ?? []).length;
    },
  };
}

function createFakeClient() {
  const stream = vi.fn(() => createFakeStream());
  // `other` props at each level assert the proxy reads through rather than
  // swallowing everything that is not on the intercepted path.
  const client = {
    apiKey: 'or-test',
    beta: {
      betaMarker: 'beta',
      chat: {
        chatMarker: 'chat',
        completions: {
          completionsMarker: 'completions',
          stream,
          create: vi.fn(),
        },
      },
    },
  };
  return { client, stream };
}

const OPTS = { provider: 'openrouter', model: 'openai/gpt-4.1' };

afterEach(() => {
  delete process.env.COPILOT_CHAT_STREAM_USAGE;
});

describe('withCopilotChatUsageTracking', () => {
  it('injects stream_options.include_usage, which the adapter never sets', () => {
    const { client, stream } = createFakeClient();
    const tracked = withCopilotChatUsageTracking(client, OPTS);

    tracked.beta.chat.completions.stream({
      model: 'openai/gpt-4.1',
      messages: [],
    });

    expect(stream).toHaveBeenCalledTimes(1);
    expect(stream.mock.calls[0][0]).toMatchObject({
      model: 'openai/gpt-4.1',
      stream_options: { include_usage: true },
    });
  });

  it('lets a caller-supplied stream_options win', () => {
    const { client, stream } = createFakeClient();
    const tracked = withCopilotChatUsageTracking(client, OPTS);

    tracked.beta.chat.completions.stream({
      model: 'm',
      stream_options: { include_usage: false },
    });

    expect(stream.mock.calls[0][0].stream_options).toEqual({
      include_usage: false,
    });
  });

  it('collects the reported usage into the ALS context', () => {
    const { client } = createFakeClient();
    const tracked = withCopilotChatUsageTracking(client, OPTS);

    const collected = runWithContext(
      { requestId: 'r1', auth: { id: 'org' }, usages: [] },
      () => {
        const stream: any = tracked.beta.chat.completions.stream({
          model: 'openai/gpt-4.1',
          messages: [],
        });
        stream.emit('totalUsage', {
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
        });
        return getCollectedUsages();
      }
    );

    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      servicer: 'openrouter',
      provider: 'openai',
      model: 'gpt-4.1',
      type: 'text',
      billing_mode: 'per_token',
      method: 'copilot_chat',
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
      },
    });
  });

  it('sums one usage record per stream call', () => {
    const { client } = createFakeClient();
    const tracked = withCopilotChatUsageTracking(client, OPTS);

    const collected = runWithContext(
      { requestId: 'r1', auth: { id: 'org' }, usages: [] },
      () => {
        for (const tokens of [10, 20, 30]) {
          const stream: any = tracked.beta.chat.completions.stream({ model: 'm' });
          stream.emit('totalUsage', {
            prompt_tokens: tokens,
            completion_tokens: 1,
            total_tokens: tokens + 1,
          });
        }
        return getCollectedUsages();
      }
    );

    expect(collected.map((u) => u.usage.prompt_tokens)).toEqual([10, 20, 30]);
  });

  it('falls back to the configured model when the call omits one', () => {
    const { client } = createFakeClient();
    const tracked = withCopilotChatUsageTracking(client, OPTS);

    const collected = runWithContext(
      { requestId: 'r1', auth: { id: 'org' }, usages: [] },
      () => {
        const stream: any = tracked.beta.chat.completions.stream({ messages: [] });
        stream.emit('totalUsage', { prompt_tokens: 1, completion_tokens: 1 });
        return getCollectedUsages();
      }
    );

    expect(collected[0].model).toBe('gpt-4.1');
  });

  it('treats a missing usage field as zero rather than NaN', () => {
    const { client } = createFakeClient();
    const tracked = withCopilotChatUsageTracking(client, OPTS);

    const collected = runWithContext(
      { requestId: 'r1', auth: { id: 'org' }, usages: [] },
      () => {
        const stream: any = tracked.beta.chat.completions.stream({ model: 'm' });
        stream.emit('totalUsage', {});
        return getCollectedUsages();
      }
    );

    expect(collected[0].usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it('does not register an error listener, which would suppress the SDK rejection', () => {
    const { client } = createFakeClient();
    const tracked = withCopilotChatUsageTracking(client, OPTS);

    const stream: any = tracked.beta.chat.completions.stream({ model: 'm' });

    expect(stream.listenerCount('totalUsage')).toBe(1);
    expect(stream.listenerCount('error')).toBe(0);
  });

  it('reads every off-path property straight through', () => {
    const { client } = createFakeClient();
    const tracked: any = withCopilotChatUsageTracking(client, OPTS);

    expect(tracked.apiKey).toBe('or-test');
    expect(tracked.beta.betaMarker).toBe('beta');
    expect(tracked.beta.chat.chatMarker).toBe('chat');
    expect(tracked.beta.chat.completions.completionsMarker).toBe('completions');
    expect(tracked.beta.chat.completions.create).toBe(
      client.beta.chat.completions.create
    );
  });

  it('records the usage even with no ALS context, without throwing', () => {
    const { client } = createFakeClient();
    const tracked = withCopilotChatUsageTracking(client, OPTS);

    const stream: any = tracked.beta.chat.completions.stream({ model: 'm' });

    expect(() =>
      stream.emit('totalUsage', { prompt_tokens: 1, completion_tokens: 1 })
    ).not.toThrow();
  });

  it('calls stream() with its real owner as `this`', () => {
    // openai v4's `stream` is a method on the completions resource and uses
    // `this` internally, so a proxy that forwards it unbound would break it.
    const completions = {
      completionsMarker: 'completions',
      stream(_params: any) {
        return { seenThis: (this as any).completionsMarker, on: () => undefined };
      },
    };
    const tracked: any = withCopilotChatUsageTracking(
      { beta: { chat: { completions } } },
      OPTS
    );

    expect(tracked.beta.chat.completions.stream({ model: 'm' }).seenThis).toBe(
      'completions'
    );
  });

  it('wraps the real nested openai v4 client the adapter is handed', async () => {
    // Shape check only — no request is made. Guards against the proxy path
    // drifting away from what `OpenAIAdapter.process()` actually walks.
    const { createCopilotOpenRouterClient } = await import(
      '../copilot-openai-client'
    );
    const real = createCopilotOpenRouterClient('or-test-key');
    const tracked: any = withCopilotChatUsageTracking(real, OPTS);

    expect(typeof tracked.beta.chat.completions.stream).toBe('function');
    expect(tracked.apiKey).toBe('or-test-key');
    expect(tracked.baseURL).toBe('https://openrouter.ai/api/v1');
  });

  describe('COPILOT_CHAT_STREAM_USAGE kill switch', () => {
    it('leaves params untouched and collects nothing when set to false', () => {
      process.env.COPILOT_CHAT_STREAM_USAGE = 'false';
      const { client, stream } = createFakeClient();
      const tracked = withCopilotChatUsageTracking(client, OPTS);

      const collected = runWithContext(
        { requestId: 'r1', auth: { id: 'org' }, usages: [] },
        () => {
          const s: any = tracked.beta.chat.completions.stream({
            model: 'm',
            messages: [],
          });
          // No listener is attached, so a usage report would go nowhere anyway.
          expect(s.listenerCount('totalUsage')).toBe(0);
          return getCollectedUsages();
        }
      );

      expect(stream.mock.calls[0][0]).toEqual({ model: 'm', messages: [] });
      expect(stream.mock.calls[0][0].stream_options).toBeUndefined();
      expect(collected).toHaveLength(0);
    });

    it('stays enabled for any other value, including unset', () => {
      for (const value of [undefined, 'true', 'TRUE', '', 'yes']) {
        if (value === undefined) {
          delete process.env.COPILOT_CHAT_STREAM_USAGE;
        } else {
          process.env.COPILOT_CHAT_STREAM_USAGE = value;
        }
        const { client, stream } = createFakeClient();
        withCopilotChatUsageTracking(client, OPTS).beta.chat.completions.stream({
          model: 'm',
        });

        expect(stream.mock.calls[0][0].stream_options).toEqual({
          include_usage: true,
        });
      }
    });

    it('reads the switch per call rather than capturing it at wrap time', () => {
      const { client, stream } = createFakeClient();
      const tracked = withCopilotChatUsageTracking(client, OPTS);

      tracked.beta.chat.completions.stream({ model: 'a' });
      process.env.COPILOT_CHAT_STREAM_USAGE = 'false';
      tracked.beta.chat.completions.stream({ model: 'b' });

      expect(stream.mock.calls[0][0].stream_options).toEqual({
        include_usage: true,
      });
      expect(stream.mock.calls[1][0].stream_options).toBeUndefined();
    });
  });

  it('reaches the real SDK stream() with include_usage injected', async () => {
    // The end-to-end assertion: params that arrive at the openai v4 boundary,
    // through the same nesting OpenAIAdapter walks. The SDK method is stubbed on
    // the real resource object, so no request leaves the process.
    const { createCopilotOpenRouterClient } = await import(
      '../copilot-openai-client'
    );
    const real: any = createCopilotOpenRouterClient('or-test-key');
    const completions = real.beta.chat.completions;
    const sdkStream = vi.fn(() => createFakeStream());
    completions.stream = sdkStream;

    const tracked: any = withCopilotChatUsageTracking(real, OPTS);
    tracked.beta.chat.completions.stream({
      model: 'openai/gpt-4.1',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(sdkStream).toHaveBeenCalledTimes(1);
    expect(sdkStream.mock.calls[0][0]).toMatchObject({
      model: 'openai/gpt-4.1',
      stream: true,
      stream_options: { include_usage: true },
    });
  });
});

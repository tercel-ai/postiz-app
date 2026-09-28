import { collectUsage, getContext } from './async.storage';
import {
  AiUsageInfo,
  parseModelId,
} from '@gitroom/nestjs-libraries/openai/openai.service';

function buildUsageInfo(
  provider: string,
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  // Which code path produced the call. Recorded on the usage so an
  // `ai_copywriting` BillingRecord says whether it came from the Agent page
  // (`agent_chat`) or the site-wide Copilot runtime (`copilot_chat`).
  method = 'agent_chat'
): AiUsageInfo {
  const servicer = provider.includes('openrouter') ? 'openrouter' : 'openai';
  const { provider: parsedProvider, model } = parseModelId(modelId, servicer);

  return {
    servicer,
    provider: parsedProvider,
    model,
    type: 'text',
    billing_mode: 'per_token',
    method,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/**
 * Wraps a LanguageModelV2 with a Proxy that intercepts doGenerate/doStream
 * to capture token usage into the current AsyncLocalStorage context.
 */
export function withBillingTracking<T extends { provider: string; modelId: string }>(
  model: T
): T {
  return new Proxy(model, {
    get(target, prop, receiver) {
      if (prop === 'doGenerate') {
        return async (...args: any[]) => {
          const result = await (target as any).doGenerate(...args);
          if (result?.usage) {
            const promptTokens = result.usage.promptTokens
              ?? result.usage.inputTokens
              ?? result.usage.prompt_tokens
              ?? 0;
            const completionTokens = result.usage.completionTokens
              ?? result.usage.outputTokens
              ?? result.usage.completion_tokens
              ?? 0;
            collectUsage(
              buildUsageInfo(
                target.provider,
                target.modelId,
                promptTokens,
                completionTokens
              )
            );
          }
          return result;
        };
      }

      if (prop === 'doStream') {
        return async (...args: any[]) => {
          const result = await (target as any).doStream(...args);
          if (!result?.stream) {
            return result;
          }

          // Capture ALS store reference NOW — TransformStream.transform runs
          // in a different async context where AsyncLocalStorage is lost.
          const ctxSnapshot = getContext();

          const originalStream = result.stream;
          const transformStream = new TransformStream({
            transform(chunk: any, controller: any) {
              if (chunk?.type === 'finish' && chunk?.usage) {
                const promptTokens = chunk.usage.promptTokens
                  ?? chunk.usage.inputTokens
                  ?? chunk.usage.prompt_tokens
                  ?? 0;
                const completionTokens = chunk.usage.completionTokens
                  ?? chunk.usage.outputTokens
                  ?? chunk.usage.completion_tokens
                  ?? 0;
                const usageInfo = buildUsageInfo(
                  target.provider,
                  target.modelId,
                  promptTokens,
                  completionTokens
                );
                // Write directly to captured store — collectUsage() would
                // fail here because ALS context is lost in TransformStream.
                if (ctxSnapshot?.usages) {
                  ctxSnapshot.usages.push(usageInfo);
                } else {
                  // Fallback: try ALS (works if Node.js propagates context)
                  collectUsage(usageInfo);
                }
              }
              controller.enqueue(chunk);
            },
          });

          return {
            ...result,
            stream: originalStream.pipeThrough(transformStream),
          };
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

// ---------------------------------------------------------------------------
// CopilotKit OpenAIAdapter (/copilot/chat)
// ---------------------------------------------------------------------------

/** The nesting the adapter walks: `openai.beta.chat.completions.stream(...)`. */
const ADAPTER_STREAM_PATH = ['beta', 'chat', 'completions', 'stream'] as const;

/**
 * Escape hatch for the `stream_options` injection below.
 *
 * `stream_options` is standard in the OpenAI API and OpenRouter forwards it, but
 * this injection sits on the request path of an endpoint whose whole job is to
 * answer users — and a provider (or a self-hosted gateway) that rejects unknown
 * parameters would turn "we don't bill this" into "this doesn't work". Set
 * `COPILOT_CHAT_STREAM_USAGE=false` and restart to stop asking for usage:
 * requests go back to their pre-billing shape, and nothing is charged.
 */
function usageInjectionEnabled(): boolean {
  return (
    (process.env.COPILOT_CHAT_STREAM_USAGE ?? 'true').toLowerCase().trim() !==
    'false'
  );
}

/**
 * Proxy `root` so that the method reached by `path` is replaced with
 * `wrap(original, owner)`. Every other property reads straight through, and the
 * wrapped method is handed its real owner so `this` still works.
 */
function interceptNestedMethod(
  root: any,
  path: readonly string[],
  wrap: (original: (...args: any[]) => any, owner: any) => (...args: any[]) => any
): any {
  const [head, ...tail] = path;
  return new Proxy(root, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== head || value == null) {
        return value;
      }
      if (tail.length === 0) {
        return typeof value === 'function' ? wrap(value, target) : value;
      }
      return interceptNestedMethod(value, tail, wrap);
    },
  });
}

/**
 * Wraps the OpenAI client handed to `@copilotkit/runtime`'s `OpenAIAdapter` so
 * every completion it streams reports its token usage into the current
 * AsyncLocalStorage context.
 *
 * Two things make this necessary rather than a nice-to-have:
 *
 *  1. `withBillingTracking` above cannot be used here. It proxies a
 *     LanguageModelV2 (`doGenerate`/`doStream`) — the AI SDK shape Mastra uses on
 *     `/copilot/agent`. `OpenAIAdapter` drives a raw OpenAI client instead, so it
 *     has no such methods to intercept.
 *  2. `OpenAIAdapter` does NOT pass `stream_options`, and an OpenAI-compatible
 *     streaming response omits `usage` unless asked. Without injecting
 *     `include_usage` here there is simply no usage to read, at any layer.
 *
 * The client must be one we constructed (see `copilot-openai-client.ts`) — the
 * adapter's own default client is built inside its constructor and never passes
 * through here.
 */
export function withCopilotChatUsageTracking<T extends object>(
  client: T,
  opts: { provider: string; model: string; method?: string }
): T {
  const method = opts.method ?? 'copilot_chat';

  return interceptNestedMethod(
    client,
    ADAPTER_STREAM_PATH,
    (originalStream, owner) =>
      (params: any, ...rest: any[]) => {
        if (!usageInjectionEnabled()) {
          return originalStream.call(owner, params, ...rest);
        }

        const paramsWithUsage = {
          ...params,
          // Caller-supplied stream_options win: this only fills in the field the
          // adapter never sets.
          stream_options: { include_usage: true, ...(params?.stream_options ?? {}) },
        };

        // Snapshot the store NOW. The 'totalUsage' listener runs from a later
        // async continuation inside the SDK, where — as the doStream case above
        // already showed — the ALS context is not reliably still attached.
        const ctxSnapshot = getContext();

        const stream = originalStream.call(owner, paramsWithUsage, ...rest);

        // Only 'totalUsage' is observed. Deliberately NOT 'error': in openai v4
        // an 'error' listener suppresses the unhandled rejection the SDK raises
        // when nobody handles the failure, which would silently change how
        // CopilotKit surfaces upstream errors.
        if (typeof stream?.on === 'function') {
          stream.on('totalUsage', (usage: any) => {
            const info = buildUsageInfo(
              opts.provider,
              paramsWithUsage.model ?? opts.model,
              usage?.prompt_tokens ?? 0,
              usage?.completion_tokens ?? 0,
              method
            );
            if (ctxSnapshot?.usages) {
              ctxSnapshot.usages.push(info);
            } else {
              collectUsage(info);
            }
          });
        }

        return stream;
      }
  ) as T;
}

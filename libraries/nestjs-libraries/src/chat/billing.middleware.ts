import { collectUsage, getContext } from './async.storage';
import {
  AiUsageInfo,
  parseModelId,
} from '@gitroom/nestjs-libraries/openai/openai.service';

function buildUsageInfo(
  provider: string,
  modelId: string,
  promptTokens: number,
  completionTokens: number
): AiUsageInfo {
  const servicer = provider.includes('openrouter') ? 'openrouter' : 'openai';
  const { provider: parsedProvider, model } = parseModelId(modelId, servicer);

  return {
    servicer,
    provider: parsedProvider,
    model,
    type: 'text',
    billing_mode: 'per_token',
    method: 'agent_chat',
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
              if (chunk?.type === 'finish') {
                // Debug: log actual chunk structure to diagnose token=0 issues
                console.log(
                  `[BillingTracking] finish chunk: usage=${JSON.stringify(chunk.usage)} | model=${target.modelId}`
                );
              }
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

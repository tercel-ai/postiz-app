import { collectUsage } from './async.storage';
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
            collectUsage(
              buildUsageInfo(
                target.provider,
                target.modelId,
                result.usage.promptTokens ?? 0,
                result.usage.completionTokens ?? 0
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

          const originalStream = result.stream;
          const transformStream = new TransformStream({
            transform(chunk: any, controller: any) {
              if (chunk?.type === 'finish' && chunk?.usage) {
                collectUsage(
                  buildUsageInfo(
                    target.provider,
                    target.modelId,
                    chunk.usage.promptTokens ?? 0,
                    chunk.usage.completionTokens ?? 0
                  )
                );
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

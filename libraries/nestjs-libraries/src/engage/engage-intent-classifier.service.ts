import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { INTENT_LABELS, IntentLabel } from './engage-intent.constants';

type ClassifyResult = {
  intentTags: string[];
  primaryIntent: string;
  intentScore: number;
};

type ZeroShotPipeline = (
  text: string,
  labels: string[],
  opts?: { multi_label?: boolean }
) => Promise<{ labels: string[]; scores: number[] }>;

@Injectable()
export class EngageIntentClassifierService implements OnModuleInit {
  private readonly logger = new Logger(EngageIntentClassifierService.name);
  private classifier: ZeroShotPipeline | null = null;

  // Two separate code paths — never mix a key from one provider with the
  // base URL of the other. OpenRouter speaks OpenAI wire format, not Anthropic.
  private readonly _useOpenRouter = !!process.env.OPENROUTER_API_KEY;
  private readonly _openRouterClient: OpenAI | null = this._useOpenRouter
    ? new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY!,
        baseURL: 'https://openrouter.ai/api/v1',
      })
    : null;
  private readonly _anthropicClient: Anthropic | null = !this._useOpenRouter
    ? new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_API_KEY ?? '',
      })
    : null;

  async onModuleInit() {
    try {
      // Dynamic import so webpack/tsc don't bundle it statically.
      // Model files (~44MB) are downloaded on first call and cached in
      // ~/.cache/huggingface/ — subsequent starts are instant.
      const { pipeline } = await import('@xenova/transformers');
      this.classifier = await pipeline(
        'zero-shot-classification',
        'Xenova/nli-deberta-v3-small',
        { quantized: true }
      ) as unknown as ZeroShotPipeline;
      this.logger.log('Intent classifier loaded: Xenova/nli-deberta-v3-small');
    } catch (err) {
      this.logger.warn(
        `Failed to load local NLI model (${(err as Error).message}). ` +
          'All classifications will fall back to Claude Haiku.'
      );
    }
  }

  async classify(text: string): Promise<ClassifyResult> {
    if (this.classifier) {
      return this._localClassify(text);
    }
    return this._claudeFallbackClassify(text);
  }

  async classifyWithFallback(text: string): Promise<ClassifyResult> {
    // If onModuleInit failed to load the local model, _localClassify returns
    // intentScore=0 for every post → every post would silently escalate to
    // Claude Haiku, inverting the spec's "<15% fallback" expectation into
    // 100% Claude calls. Short-circuit straight to Claude so the cost is at
    // least observable per call (and logged on classifier-unavailable).
    if (!this.classifier) {
      if (!this._loggedUnavailable) {
        this.logger.warn(
          'Local NLI classifier unavailable — all classifyWithFallback calls will go to Claude Haiku.'
        );
        this._loggedUnavailable = true;
      }
      return this._claudeFallbackClassify(text);
    }
    const local = await this._localClassify(text);
    if (local.intentScore >= 0.45) return local;
    return this._claudeFallbackClassify(text);
  }

  private _loggedUnavailable = false;

  async classifyBatch(
    posts: Array<{ id: string; content: string }>,
    concurrency = 4
  ): Promise<Record<string, ClassifyResult>> {
    const results: Record<string, ClassifyResult> = {};
    for (let i = 0; i < posts.length; i += concurrency) {
      const batch = posts.slice(i, i + concurrency);
      // Isolate per-item failures: one corrupt post must not reject the whole
      // chunk (e.g. a malformed string that crashes the local NLI pipeline).
      // Use classifyWithFallback so low-confidence local predictions (< 0.45)
      // still escalate to Haiku.
      const settled = await Promise.allSettled(
        batch.map((p) =>
          this.classifyWithFallback(p.content).then((r) => ({ id: p.id, ...r }))
        )
      );
      settled.forEach((s, idx) => {
        if (s.status === 'fulfilled') {
          results[s.value.id] = {
            intentTags: s.value.intentTags,
            primaryIntent: s.value.primaryIntent,
            intentScore: s.value.intentScore,
          };
        } else {
          const failedId = batch[idx].id;
          this.logger.warn(
            `classifyBatch: item ${failedId} failed — ${(s.reason as Error)?.message ?? s.reason}`
          );
          results[failedId] = {
            intentTags: ['discussion'],
            primaryIntent: 'discussion',
            intentScore: 0,
          };
        }
      });
    }
    return results;
  }

  private async _localClassify(text: string): Promise<ClassifyResult> {
    if (!this.classifier) {
      return {
        intentTags: ['discussion'],
        primaryIntent: 'discussion',
        intentScore: 0,
      };
    }
    const result = await this.classifier(text.slice(0, 512), [
      ...INTENT_LABELS,
    ], { multi_label: true });

    const intentTags = (result.labels as string[]).filter(
      (_, i) => (result.scores as number[])[i] > 0.4
    );
    const primaryIntent = result.labels[0] as string;
    const intentScore = result.scores[0] as number;

    return {
      intentTags: intentTags.length > 0 ? intentTags : [primaryIntent],
      primaryIntent,
      intentScore,
    };
  }

  private async _claudeFallbackClassify(text: string): Promise<ClassifyResult> {
    const prompt = `Classify this post's intent. Labels: ${INTENT_LABELS.join(', ')}.\n\n"${text.slice(0, 400)}"`;

    try {
      let rawResult: { intentTags: string[]; primaryIntent: string; intentScore: number } | null = null;

      if (this._useOpenRouter && this._openRouterClient) {
        const model = process.env.OPENROUTER_INTENT_MODEL ?? 'anthropic/claude-haiku-4.5';
        const response = await this._openRouterClient.chat.completions.create({
          model,
          max_tokens: 128,
          messages: [
            {
              role: 'system',
              content: `You are an intent classifier. Respond with JSON only: {"intentTags":["<label>",...],"primaryIntent":"<label>","intentScore":<0-1>}. Valid labels: ${INTENT_LABELS.join(', ')}.`,
            },
            { role: 'user', content: prompt },
          ],
        },
        {
          headers: {
            'HTTP-Referer': 'https://postiz.com',
            'X-Title': 'Postiz Engage',
          },
        });
        const content = response.choices[0]?.message?.content ?? '';
        try {
          rawResult = JSON.parse(content);
        } catch {
          // non-JSON response — fall through to default
        }
      } else if (this._anthropicClient) {
        const model = 'claude-haiku-4-5-20251001';
        const msg = await this._anthropicClient.messages.create({
          model,
          max_tokens: 128,
          tools: [
            {
              name: 'set_intent',
              input_schema: {
                type: 'object' as const,
                properties: {
                  intentTags: { type: 'array', items: { type: 'string' } },
                  primaryIntent: { type: 'string' },
                  intentScore: { type: 'number' },
                },
                required: ['intentTags', 'primaryIntent', 'intentScore'],
              },
            },
          ],
          tool_choice: { type: 'tool', name: 'set_intent' },
          messages: [{ role: 'user', content: prompt }],
        });
        const toolUse = msg.content.find((b) => b.type === 'tool_use');
        if (toolUse && toolUse.type === 'tool_use') {
          rawResult = toolUse.input as typeof rawResult;
        }
      }

      if (rawResult) {
        const validSet = new Set<string>(INTENT_LABELS);
        const intentTags = (rawResult.intentTags ?? []).filter((t) => validSet.has(t)) as IntentLabel[];
        const primaryIntent = validSet.has(rawResult.primaryIntent)
          ? rawResult.primaryIntent
          : (intentTags[0] ?? 'discussion');
        return {
          intentTags: intentTags.length > 0 ? intentTags : ['discussion' as IntentLabel],
          primaryIntent,
          intentScore: typeof rawResult.intentScore === 'number' ? rawResult.intentScore : 0,
        };
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.logger.warn(`Intent classifier fallback failed: ${msg.slice(0, 200)}`);
    }

    return { intentTags: ['discussion'], primaryIntent: 'discussion', intentScore: 0 };
  }
}

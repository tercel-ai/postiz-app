import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import {
  buildOriginalPostXml,
  ORIGINAL_POST_INJECTION_NOTICE,
  ReferencePostFields,
} from '@gitroom/nestjs-libraries/engage/prompt-source-envelope';
import { checkReferenceSimilarity } from '@gitroom/nestjs-libraries/engage/reference-similarity';
import {
  X_WEIGHTED_CHAR_LIMIT,
  REDDIT_TARGET_CHAR_LIMIT,
  normalizeEngagePlatform,
  assertDraftWithinPlatformLimit,
} from '@gitroom/nestjs-libraries/engage/engage-draft-length';

// docs/engage/reference-post-generation.md §6. Generates an ORIGINAL post
// inspired by a reference EngageOpportunity — not a reply to it. Reuses the
// same injection-isolation envelope as engage-draft.service.ts (see
// prompt-source-envelope.ts) but deliberately does NOT reuse its "reply to
// the post" relevance instructions, and adds an output-side similarity gate
// that reply generation has no need for.

export interface ReferencePostUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  // Which path actually served this call (Anthropic direct vs OpenRouter) —
  // audit-only: AiPricingService.calculateCost prices by `type` (text) alone,
  // not by provider/model, so this never changes what gets charged.
  provider: string;
  model: string;
}

export interface ReferencePostGenerationResult {
  text: string;
  // One entry per model call made for this generation (initial + the
  // similarity corrective retry, if it happened) — the caller must bill for
  // all of them, not just the last. See reference-post-generation.md §7.1.
  usages: ReferencePostUsage[];
}

/**
 * Base for a failed generation that still made real, billable model calls
 * before failing. `usages` carries every attempt that actually completed, so
 * the caller (EngageService.generateReferencePost) can still bill for them —
 * see §7.1: "bills for every model call this generation made". Losing this on
 * throw would mean a paid Anthropic call that happened to fail on the LAST
 * attempt (similarity gate, transient error) is never charged for at all.
 */
export class ReferencePostGenerationError extends Error {
  constructor(
    message: string,
    readonly usages: ReferencePostUsage[],
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ReferencePostGenerationError';
  }
}

export class TooSimilarToReferenceError extends ReferencePostGenerationError {
  constructor(usages: ReferencePostUsage[]) {
    super(
      'Generated post reused too much of the reference post, even after a corrective retry.',
      usages
    );
    this.name = 'TooSimilarToReferenceError';
  }
}

// 1 initial attempt + 1 corrective retry if the similarity gate rejects the
// first draft — see reference-post-generation.md §6 step 2.
const MAX_ATTEMPTS = 2;

export type ReferencePostTone = 'personal' | 'company';

@Injectable()
export class EngageReferencePostService {
  private readonly logger = new Logger(EngageReferencePostService.name);

  // Same provider-selection shape as EngageDraftService — kept as a separate
  // instance/config rather than sharing one, since the two services already
  // diverge in prompt content and may diverge in model choice later.
  private readonly useOpenRouter = !!process.env.OPENROUTER_API_KEY;
  private readonly openRouterModel =
    process.env.OPENROUTER_TEXT_MODEL ?? 'anthropic/claude-sonnet-4-6';
  private readonly openRouterFallbackModel =
    process.env.OPENROUTER_TEXT_FALLBACK_MODEL ?? 'openrouter/auto';

  private readonly openRouterClient: OpenAI | null = this.useOpenRouter
    ? new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY!,
        baseURL: 'https://openrouter.ai/api/v1',
      })
    : null;

  private readonly anthropicClient: Anthropic | null = !this.useOpenRouter
    ? new Anthropic({
        apiKey:
          process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_API_KEY ?? '',
      })
    : null;

  async generate(
    reference: ReferencePostFields,
    targetPlatform: string,
    tone: ReferencePostTone,
    outputLength: number | undefined,
    signal?: AbortSignal
  ): Promise<ReferencePostGenerationResult> {
    const platform = normalizeEngagePlatform(targetPlatform);
    const limit =
      outputLength ??
      (platform === 'reddit' ? REDDIT_TARGET_CHAR_LIMIT : X_WEIGHTED_CHAR_LIMIT);
    const systemPrompt = this._buildSystemPrompt(platform, tone, limit);
    const userPrompt = this._buildUserPrompt(reference);

    const usages: ReferencePostUsage[] = [];
    let attemptSystemPrompt = systemPrompt;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) return { text: '', usages };

      let text: string;
      let usage: ReferencePostUsage | null;
      try {
        ({ text, usage } = await this._callModel(
          attemptSystemPrompt,
          userPrompt,
          signal
        ));
      } catch (err) {
        // A prior attempt in this same call already succeeded (real,
        // billable spend) before this one failed — do not let the caller
        // lose that usage just because the LAST attempt errored (abort,
        // transient API failure, etc.). See ReferencePostGenerationError.
        if (usages.length) {
          throw new ReferencePostGenerationError(
            'Reference-post model call failed after an earlier attempt in the same generation had already succeeded.',
            usages,
            err
          );
        }
        throw err;
      }
      if (usage) usages.push(usage);

      const similarity = checkReferenceSimilarity(
        text,
        reference.postContent ?? ''
      );
      if (!similarity.tooSimilar) {
        try {
          assertDraftWithinPlatformLimit(platform, text, outputLength);
        } catch (err) {
          throw new ReferencePostGenerationError(
            err instanceof Error ? err.message : String(err),
            usages,
            err
          );
        }
        return { text, usages };
      }

      this.logger.warn(
        `Reference-post draft too similar to source (overlap=${similarity.overlapRatio.toFixed(
          2
        )}, verbatimRun=${similarity.hasLongVerbatimRun}); ${
          attempt === MAX_ATTEMPTS - 1 ? 'no retries left' : 'retrying'
        }.`
      );

      if (attempt === MAX_ATTEMPTS - 1) {
        throw new TooSimilarToReferenceError(usages);
      }

      attemptSystemPrompt = `${systemPrompt}

Your previous draft reused too much of the reference post's own wording (shared phrases and sentence structure). Rewrite it with entirely new phrasing of your own — keep only the topic and general angle from the reference, and do not reuse any of its sentences or distinctive phrases.`;
    }

    // Unreachable — every path in the loop above returns or throws.
    throw new TooSimilarToReferenceError(usages);
  }

  private _buildSystemPrompt(
    platform: string,
    tone: ReferencePostTone,
    limit: number
  ): string {
    const toneInstruction =
      tone === 'company'
        ? 'Write in a professional brand voice suitable for a company account.'
        : 'Write in a natural, first-person personal voice.';
    const charLimit =
      platform === 'x'
        ? `under ${limit} Twitter-weighted characters (CJK/emoji count as 2, URLs as 23)`
        : `up to about ${limit} characters`;

    return `You are a social media copywriter. Write an ORIGINAL ${platform} post INSPIRED BY a reference post — you are not replying to it, and the reference's author will never see this post.
${toneInstruction}
Read the reference only for its topic, angle, and structure.

Hard requirement — do not copy: write a genuinely original post in your own words. Do not paraphrase-copy, closely reword, or reuse the reference's sentences, distinctive phrases, or structure. Reusing another person's wording is a copyright problem for the person publishing this post, not just a style issue.

Platform constraint: keep the post ${charLimit}.
Write in the same language as the reference post unless it explicitly asks for another language.

${ORIGINAL_POST_INJECTION_NOTICE}

Only output the post text — no preface, no meta-commentary, no quotation of the reference.`;
  }

  private _buildUserPrompt(reference: ReferencePostFields): string {
    return `${buildOriginalPostXml(reference)}

Write a new, original post inspired by this one's topic and angle. Do not reply to it and do not reword it — write something new.`;
  }

  private async _callModel(
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal
  ): Promise<{ text: string; usage: ReferencePostUsage | null }> {
    if (this.useOpenRouter && this.openRouterClient) {
      return this._callViaOpenRouter(systemPrompt, userPrompt, signal);
    }
    if (this.anthropicClient) {
      return this._callViaAnthropic(systemPrompt, userPrompt, signal);
    }
    throw new Error(
      'No LLM provider configured. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY.'
    );
  }

  private async _callViaAnthropic(
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal
  ): Promise<{ text: string; usage: ReferencePostUsage | null }> {
    const response = await this.anthropicClient!.messages.create(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      },
      { signal }
    );

    const text = response.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim();

    const usage = response.usage
      ? {
          promptTokens: response.usage.input_tokens ?? 0,
          completionTokens: response.usage.output_tokens ?? 0,
          totalTokens:
            (response.usage.input_tokens ?? 0) +
            (response.usage.output_tokens ?? 0),
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
        }
      : null;

    return { text, usage };
  }

  private async _callViaOpenRouter(
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal
  ): Promise<{ text: string; usage: ReferencePostUsage | null }> {
    const call = (model: string) =>
      this.openRouterClient!.chat.completions.create(
        {
          model,
          max_tokens: 500,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        },
        { signal }
      );

    let response;
    let modelUsed = this.openRouterModel;
    try {
      response = await call(this.openRouterModel);
    } catch (error) {
      const isRegionBlocked =
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        error.status === 403 &&
        error instanceof Error &&
        error.message.toLowerCase().includes('not available in your region');

      if (
        !isRegionBlocked ||
        this.openRouterFallbackModel === this.openRouterModel
      ) {
        throw error;
      }

      this.logger.warn(
        `OpenRouter model ${this.openRouterModel} is unavailable in this region; retrying with ${this.openRouterFallbackModel}.`
      );
      modelUsed = this.openRouterFallbackModel;
      response = await call(this.openRouterFallbackModel);
    }

    const content = response.choices[0]?.message?.content;
    const text = Array.isArray(content)
      ? content
          .map((part) => ('text' in part ? part.text : ''))
          .join('')
          .trim()
      : (content ?? '').trim();

    const usage = response.usage
      ? {
          promptTokens: response.usage.prompt_tokens ?? 0,
          completionTokens: response.usage.completion_tokens ?? 0,
          totalTokens: response.usage.total_tokens ?? 0,
          provider: 'openrouter',
          model: modelUsed,
        }
      : null;

    return { text, usage };
  }
}

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
import {
  requiresMention,
  containsRequiredMention,
  buildBrandInstruction,
  buildMandatoryBrandBlock,
} from '@gitroom/nestjs-libraries/engage/engage-brand-instruction';
import { VALID_STRATEGIES } from '@gitroom/nestjs-libraries/engage/dtos/engage.dto';

// docs/engage/reference-post-generation.md §6. Generates an ORIGINAL post
// inspired by a reference EngageOpportunity — not a reply to it. Reuses the
// same injection-isolation envelope and brand-instruction logic as
// engage-draft.service.ts, but deliberately does NOT reuse its per-strategy
// prompt TEXT (REFERENCE_POST_STRATEGY_PROMPTS below is its own reworded set
// — the reply-draft wording is framed around responding to the post, e.g.
// QUESTION_LED literally says "Reply with one genuine question", which reads
// as a non-sequitur on a standalone original post that never addresses
// anyone), and adds an output-side similarity gate reply generation has no
// need for.
//
// The target platform is always the reference opportunity's OWN platform
// (reference.platform) — not a client-supplied value. See §3: the caller
// picks WHICH of their own accounts on that platform to eventually save to
// (SaveGeneratedPostDto.integrationId), not which platform to write for.

// Typed against VALID_STRATEGIES rather than Record<string, string>: adding a
// strategy to that list without adding its prompt here is then a compile
// error, instead of silently falling back to EXPERT_ANSWER at runtime for
// the new key. (engage-draft.service.ts's own STRATEGY_PROMPTS predates this
// and is still loosely typed.)
const REFERENCE_POST_STRATEGY_PROMPTS: Record<
  (typeof VALID_STRATEGIES)[number],
  string
> = {
  EXPERT_ANSWER:
    'Write with expert, step-by-step insight on the topic. Share actionable frameworks. Be specific and concrete.',
  DATA_BACKED:
    "Ground the post in a concrete number or data point related to the topic — you may build on a number from the reference, expressed in your own words — and say what it implies. Beyond that, only suggest what's worth checking or what it's consistent with; never assert a specific unstated fact. When unsure, frame it as a question, not a claim.",
  EMPATHY_LED:
    "Open by naming the specific feeling or frustration this topic evokes, grounded in a concrete detail — not a generic 'that's rough'. Only after that, pivot to one concrete insight of your own. If your opener is analysis or advice instead of a feeling, it fails.",
  CONTRARIAN:
    "Open by naming the topic's common, expected take — then push back on it with your own reasoning (skip this angle if there's no real common take to push against). Make your own claim in your own words; don't quote or directly reference the reference post itself.",
  QUESTION_LED:
    "Open the post with one genuine, open question that springs from a specific angle on the topic. State it with at most one short clause of framing, and never state or hint at the answer (no 'usually it's...'). Skip generic openers like 'Have you considered' or 'What if'; ask it the way a sharp, curious person would.",
  QUICK_TAKE:
    "Fire off ONE single-sentence quip (one period, about 25 words max) that takes a specific, sharp angle on the topic and flips expectations. It's a joke or a jab, not a diagnosis: no 'the real problem/waste is', no advice, no second sentence. A generic gripe that could sit under any post on the topic does not count.",
  AMPLIFY:
    "Agree with the topic's general thrust in a few words, then add the one underrated angle that pushes it further. Keep it to two short sentences and don't drift into a generic truism — skip stock connectives like 'the part people miss is' or 'the catch is'.",
};

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
    reference: ReferencePostFields & { platform: string },
    strategy: string,
    brandStrength: number,
    mentions: string[] | undefined,
    outputLength: number | undefined,
    signal?: AbortSignal
  ): Promise<ReferencePostGenerationResult> {
    const platform = normalizeEngagePlatform(reference.platform);
    const limit =
      outputLength ??
      (platform === 'reddit' ? REDDIT_TARGET_CHAR_LIMIT : X_WEIGHTED_CHAR_LIMIT);
    const requiredMentions = requiresMention(brandStrength, mentions);
    const systemPrompt = this._buildSystemPrompt(
      platform,
      strategy,
      brandStrength,
      mentions,
      limit
    );
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

      const missingMention =
        requiredMentions.length > 0 &&
        !containsRequiredMention(text, requiredMentions);
      const similarity = checkReferenceSimilarity(
        text,
        reference.postContent ?? ''
      );

      if (!similarity.tooSimilar && !missingMention) {
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

      if (!similarity.tooSimilar && missingMention) {
        // Otherwise-valid post, just missing the brand — ship it with a
        // warning rather than burning a retry/credits on a hard failure,
        // same posture as engage-draft.service.ts's own mention handling.
        this.logger.warn(
          `Reference-post draft omitted the required brand mention (${requiredMentions.join(
            ', '
          )}); delivering it anyway.`
        );
        assertDraftWithinPlatformLimit(platform, text, outputLength);
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
    strategy: string,
    brandStrength: number,
    mentions: string[] | undefined,
    limit: number
  ): string {
    // The DTO's @IsIn(VALID_STRATEGIES) already rejects anything else at the
    // controller boundary; this fallback only covers internal callers that
    // bypass the DTO, matching engage-draft.service.ts's same posture.
    const strategyInstruction =
      REFERENCE_POST_STRATEGY_PROMPTS[
        strategy as (typeof VALID_STRATEGIES)[number]
      ] ?? REFERENCE_POST_STRATEGY_PROMPTS.EXPERT_ANSWER;
    const brandInstruction = buildBrandInstruction(
      brandStrength,
      mentions,
      'post'
    );
    const requiredMentions = requiresMention(brandStrength, mentions);
    const mandatoryBrandBlock = requiredMentions.length
      ? `\n${buildMandatoryBrandBlock(requiredMentions, 'post')}\n`
      : '';
    const charLimit =
      platform === 'x'
        ? `under ${limit} Twitter-weighted characters (CJK/emoji count as 2, URLs as 23)`
        : `up to about ${limit} characters`;

    return `You are a social media copywriter. Write an ORIGINAL ${platform} post INSPIRED BY a reference post — you are not replying to it, and the reference's author will never see this post.
${strategyInstruction}
${brandInstruction}

Hard requirement — do not copy: write a genuinely original post in your own words. Do not paraphrase-copy, closely reword, or reuse the reference's sentences, distinctive phrases, or structure. Reusing another person's wording is a copyright problem for the person publishing this post, not just a style issue.
${mandatoryBrandBlock}
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

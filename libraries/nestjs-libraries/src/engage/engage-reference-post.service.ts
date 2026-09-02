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
import {
  DEFAULT_REFERENCE_POST_THREAD_PARTS,
  REFERENCE_POST_MAX_THREAD_PARTS,
  resolveSourceAdaptation,
  SourceAdaptation,
  VALID_STRATEGIES,
} from '@gitroom/nestjs-libraries/engage/dtos/engage.dto';

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

// The SOURCE-ADAPTATION axis (reference-post-generation.md §6.3): how much of
// the reference's own shape carries over. Orthogonal to strategy above —
// strategy picks the voice, this picks the distance from the source.
//
// Every mode sits UNDER the same do-not-copy requirement and the same
// output-side similarity gate; none of them licenses reusing the reference's
// wording. PRESERVE_STRUCTURE preserves the ORDER OF IDEAS, never sentences —
// which is also why it trips the similarity gate more often than the others,
// and correctly so.
//
// Keyed off VALID_SOURCE_ADAPTATIONS so a new mode without a prompt is a
// compile error rather than a silent fallback.
const REFERENCE_POST_SOURCE_ADAPTATION_PROMPTS: Record<SourceAdaptation, string> = {
  PRESERVE_STRUCTURE:
    "Follow the reference's information order: cover the same beats in the same sequence and keep its overall shape (hook → detail → takeaway, list, story arc — whatever it uses). Same skeleton, none of its phrasing: every sentence must be written from scratch in your own words. Keeping its structure is NOT permission to keep its sentences.",
  REFRAME:
    "Keep the reference's core point, but rebuild it: your own opening, your own order of ideas, your own structure. A reader should recognize the same underlying claim — not the same post.",
  FRESH_ANGLE:
    "Take only the topic and what makes it resonate. Come at it from a different angle than the reference does — a different aspect, audience, moment or question — and do not restate its argument or mirror its structure. The reference is a starting point, not a template.",
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
  // The whole post as one string — thread parts joined by a blank line.
  // Identical to `parts[0]` for a single post, so this stays the field a
  // caller can always render.
  text: string;
  // One entry per POST in the chain, in publish order: `[anchor]` for a
  // single post, `[anchor, ...follow-ups]` for a thread. Each entry becomes
  // its own `Post` row (parentPostId chain), so each is length-checked
  // against the platform ceiling on its own.
  parts: string[];
  // One entry per model call made for this generation (initial + the
  // similarity corrective retry, if it happened) — the caller must bill for
  // all of them, not just the last. See reference-post-generation.md §7.1.
  usages: ReferencePostUsage[];
}

/**
 * Everything but the reference itself. An options object rather than the
 * positional list this used to take: `thread`/`maxThreadParts` would have
 * made it seven positional arguments, four of them optional.
 */
export interface ReferencePostGenerateOptions {
  strategy: string;
  brandStrength: number;
  /**
   * How closely the post may follow the reference. Absent or unrecognized
   * falls back to DEFAULT_SOURCE_ADAPTATION via `resolveSourceAdaptation` —
   * the same resolver the caller bills by, so the two can never disagree
   * about which mode ran.
   */
  sourceAdaptation?: SourceAdaptation;
  mentions?: string[];
  outputLength?: number;
  /**
   * Produce a native thread instead of a single post. Whether the platform
   * CAN chain one is the caller's call (isThreadCapablePlatform) — this
   * service only writes what it is asked for, and a platform gate here would
   * be a second, driftable copy of that rule.
   */
  thread?: boolean;
  /** Follow-up parts beyond the anchor; clamped to [1, REFERENCE_POST_MAX_THREAD_PARTS]. */
  maxThreadParts?: number;
  signal?: AbortSignal;
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

// Delimiter the model puts between thread parts. A bracketed sentinel rather
// than the usual `---`/`1/5` conventions precisely because those DO occur
// inside real post text (a markdown rule, a "1/5" the author wrote) — this
// cannot, so splitting on it can never cut a post in half.
const THREAD_PART_SEPARATOR = '[[PART]]';

// Output budget per post. 500 tokens comfortably covers one post on any
// platform this generates for; a thread multiplies it by the number of posts
// asked for so the last part is never truncated mid-sentence.
const MAX_TOKENS_PER_POST = 500;

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
    options: ReferencePostGenerateOptions
  ): Promise<ReferencePostGenerationResult> {
    const { strategy, brandStrength, mentions, outputLength, signal } = options;
    const sourceAdaptation = resolveSourceAdaptation(options.sourceAdaptation);
    const platform = normalizeEngagePlatform(reference.platform);
    const limit =
      outputLength ??
      (platform === 'reddit' ? REDDIT_TARGET_CHAR_LIMIT : X_WEIGHTED_CHAR_LIMIT);
    // Follow-up parts beyond the anchor, so the chain is 1 + this. Clamped
    // here as well as at the DTO: internal callers bypass the DTO, and an
    // unclamped value would set the model's token budget below.
    const maxThreadParts = options.thread
      ? Math.min(
          Math.max(
            Math.floor(options.maxThreadParts ?? DEFAULT_REFERENCE_POST_THREAD_PARTS),
            1
          ),
          REFERENCE_POST_MAX_THREAD_PARTS
        )
      : 0;
    const maxParts = maxThreadParts + 1;
    const requiredMentions = requiresMention(brandStrength, mentions);
    const systemPrompt = this._buildSystemPrompt(
      platform,
      strategy,
      sourceAdaptation,
      brandStrength,
      mentions,
      limit,
      maxThreadParts
    );
    const userPrompt = this._buildUserPrompt(reference, maxThreadParts);
    const maxTokens = MAX_TOKENS_PER_POST * maxParts;

    const usages: ReferencePostUsage[] = [];
    let attemptSystemPrompt = systemPrompt;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) return { text: '', parts: [], usages };

      let raw: string;
      let usage: ReferencePostUsage | null;
      try {
        ({ text: raw, usage } = await this._callModel(
          attemptSystemPrompt,
          userPrompt,
          maxTokens,
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

      const parts = this._splitThreadParts(raw, maxParts);
      // Both gates below judge the WHOLE post — a thread that scatters the
      // reference's own sentences across its parts is exactly as much of a
      // copy as one that reproduces them in a single post, and a brand
      // mention anywhere in the chain is a brand mention.
      const text = parts.join('\n\n');

      const missingMention =
        requiredMentions.length > 0 &&
        !containsRequiredMention(text, requiredMentions);
      const similarity = checkReferenceSimilarity(
        text,
        reference.postContent ?? ''
      );

      // ONE delivery path for "similarity gate passed", whether or not the
      // brand mention made it in. These used to be two branches with two
      // separate length checks, and only the first wrapped its failure in a
      // ReferencePostGenerationError — so an over-long draft that ALSO
      // missed its mandatory mention threw a bare Error, the caller's
      // `instanceof ReferencePostGenerationError` guard skipped billing, and
      // a model call that really happened was never charged for.
      if (!similarity.tooSimilar) {
        if (missingMention) {
          // Otherwise-valid post, just missing the brand — ship it with a
          // warning rather than burning a retry/credits on a hard failure,
          // same posture as engage-draft.service.ts's own mention handling.
          this.logger.warn(
            `Reference-post draft omitted the required brand mention (${requiredMentions.join(
              ', '
            )}); delivering it anyway.`
          );
        }
        try {
          this._assertPartsWithinPlatformLimit(platform, parts, outputLength);
        } catch (err) {
          throw new ReferencePostGenerationError(
            err instanceof Error ? err.message : String(err),
            usages,
            err
          );
        }
        return { text, parts, usages };
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

      // The corrective has to push away from the reference's WORDING without
      // contradicting the adaptation the caller asked for: telling a
      // PRESERVE_STRUCTURE request to "keep only the topic" would silently
      // turn it into a FRESH_ANGLE one on the retry.
      attemptSystemPrompt = `${systemPrompt}

Your previous draft reused too much of the reference post's own wording (shared phrases and sentence structure). Rewrite it with entirely new phrasing of your own. ${
        sourceAdaptation === 'PRESERVE_STRUCTURE'
          ? 'You may still follow the same order of ideas, but not one of its sentences or distinctive phrases may survive — re-express every beat from scratch.'
          : 'Keep only the topic and general angle from the reference, and do not reuse any of its sentences or distinctive phrases.'
      }`;
    }

    // Unreachable — every path in the loop above returns or throws.
    throw new TooSimilarToReferenceError(usages);
  }

  /**
   * Split a model response into the chain's posts. Single-post mode passes
   * maxParts=1 and gets `[whole response]` — the separator is stripped there
   * too, so a model that threads when it was not asked to degrades into one
   * post rather than leaking `[[PART]]` into published text.
   *
   * Over-long chains are TRUNCATED, not rejected: the parts are ordered, so
   * dropping the tail leaves a coherent (if shorter) thread, and failing a
   * generation that is already paid for over one extra part is the worse
   * trade. Same posture as the operation plan's _normalizeThreads.
   */
  private _splitThreadParts(raw: string, maxParts: number): string[] {
    const parts = raw
      .split(THREAD_PART_SEPARATOR)
      .map((part) => part.trim())
      .filter(Boolean);

    if (!parts.length) return [raw.trim()];
    if (maxParts === 1) {
      if (parts.length > 1) {
        this.logger.warn(
          `Reference-post generation returned ${parts.length} thread parts for a single-post request; joining them into one post.`
        );
      }
      return [parts.join('\n\n')];
    }
    if (parts.length > maxParts) {
      this.logger.warn(
        `Reference-post thread returned ${parts.length} parts, over the ${maxParts}-post ceiling; dropping the last ${
          parts.length - maxParts
        }.`
      );
      return parts.slice(0, maxParts);
    }
    return parts;
  }

  /**
   * Every part is its own published post, so every part faces the platform
   * ceiling on its own — the same hard gate a single post gets, not a budget
   * shared across the chain.
   */
  private _assertPartsWithinPlatformLimit(
    platform: string,
    parts: string[],
    outputLength: number | undefined
  ): void {
    parts.forEach((part, index) => {
      try {
        assertDraftWithinPlatformLimit(platform, part, outputLength);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          parts.length > 1
            ? `${message} (thread part ${index + 1} of ${parts.length})`
            : message
        );
      }
    });
  }

  private _buildSystemPrompt(
    platform: string,
    strategy: string,
    sourceAdaptation: SourceAdaptation,
    brandStrength: number,
    mentions: string[] | undefined,
    limit: number,
    maxThreadParts: number
  ): string {
    // The DTO's @IsIn(VALID_STRATEGIES) already rejects anything else at the
    // controller boundary; this fallback only covers internal callers that
    // bypass the DTO, matching engage-draft.service.ts's same posture.
    const strategyInstruction =
      REFERENCE_POST_STRATEGY_PROMPTS[
        strategy as (typeof VALID_STRATEGIES)[number]
      ] ?? REFERENCE_POST_STRATEGY_PROMPTS.EXPERT_ANSWER;
    const adaptationInstruction =
      REFERENCE_POST_SOURCE_ADAPTATION_PROMPTS[sourceAdaptation];
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
    const threadBlock = maxThreadParts
      ? `
Thread: write this as a native ${platform} thread — a first (anchor) post plus up to ${maxThreadParts} follow-up posts that publish as a reply chain beneath it, ${
          maxThreadParts + 1
        } posts at most in total. Separate every post with a line containing exactly ${THREAD_PART_SEPARATOR} and nothing else. Use only as many follow-ups as the topic genuinely earns — never pad to reach the maximum, and every part must add something the previous ones did not. The anchor has to stand on its own as a hook, and EACH post — anchor and follow-ups alike — must independently fit the platform constraint below.
`
      : '';
    // The blanket do-not-copy clause names STRUCTURE among the things not to
    // reuse, which flatly contradicts a PRESERVE_STRUCTURE request — the
    // model would be told to keep the shape and to drop it in the same
    // prompt. Under that mode the prohibition narrows to wording (which is
    // the part that actually carries the copyright exposure) and says why,
    // so the carve-out cannot be read as a general softening.
    const doNotCopyClause =
      sourceAdaptation === 'PRESERVE_STRUCTURE'
        ? "Hard requirement — do not copy: write a genuinely original post in your own words. Do not paraphrase-copy, closely reword, or reuse the reference's sentences or distinctive phrases. Following its structure is required of you above; that covers the ORDER of its ideas ONLY, never its wording. Reusing another person's wording is a copyright problem for the person publishing this post, not just a style issue."
        : "Hard requirement — do not copy: write a genuinely original post in your own words. Do not paraphrase-copy, closely reword, or reuse the reference's sentences, distinctive phrases, or structure. Reusing another person's wording is a copyright problem for the person publishing this post, not just a style issue.";
    const outputInstruction = maxThreadParts
      ? `Only output the post text, with ${THREAD_PART_SEPARATOR} between posts — no preface, no numbering like "1/5", no meta-commentary, no quotation of the reference.`
      : 'Only output the post text — no preface, no meta-commentary, no quotation of the reference.';

    return `You are a social media copywriter. Write an ORIGINAL ${platform} post INSPIRED BY a reference post — you are not replying to it, and the reference's author will never see this post.
${strategyInstruction}
Relationship to the reference: ${adaptationInstruction}
${brandInstruction}

${doNotCopyClause}
${mandatoryBrandBlock}${threadBlock}
Platform constraint: keep ${
      maxThreadParts ? 'EACH post of the thread' : 'the post'
    } ${charLimit}.
Write in the same language as the reference post unless it explicitly asks for another language.

${ORIGINAL_POST_INJECTION_NOTICE}

${outputInstruction}`;
  }

  private _buildUserPrompt(
    reference: ReferencePostFields,
    maxThreadParts: number
  ): string {
    return `${buildOriginalPostXml(reference)}

Write a new, original ${
      maxThreadParts ? 'thread' : 'post'
    } inspired by this one, following the relationship to the reference stated above. Do not reply to it and do not reword it — write something new.`;
  }

  private async _callModel(
    systemPrompt: string,
    userPrompt: string,
    maxTokens: number,
    signal?: AbortSignal
  ): Promise<{ text: string; usage: ReferencePostUsage | null }> {
    if (this.useOpenRouter && this.openRouterClient) {
      return this._callViaOpenRouter(systemPrompt, userPrompt, maxTokens, signal);
    }
    if (this.anthropicClient) {
      return this._callViaAnthropic(systemPrompt, userPrompt, maxTokens, signal);
    }
    throw new Error(
      'No LLM provider configured. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY.'
    );
  }

  private async _callViaAnthropic(
    systemPrompt: string,
    userPrompt: string,
    maxTokens: number,
    signal?: AbortSignal
  ): Promise<{ text: string; usage: ReferencePostUsage | null }> {
    const response = await this.anthropicClient!.messages.create(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens,
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
    maxTokens: number,
    signal?: AbortSignal
  ): Promise<{ text: string; usage: ReferencePostUsage | null }> {
    const call = (model: string) =>
      this.openRouterClient!.chat.completions.create(
        {
          model,
          max_tokens: maxTokens,
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

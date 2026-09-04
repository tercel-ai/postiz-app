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
  resolveSourceAdaptation,
  resolveThreadPostCount,
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
  // How many trailing thread parts were discarded for overrunning the
  // platform ceiling after the shortening retry. Absent/0 on the normal
  // path. `parts` is already the truncated chain; this exists so the caller
  // can TELL the user their thread came back shorter than it was written.
  droppedParts?: number;
  // How many posts were ASKED for (`maxThreadParts`, so it compares directly
  // against `parts.length`), present only when the chain came back shorter.
  // That count is exact, but two things can still
  // undershoot it: a model that writes fewer posts even after the corrective
  // retry, and a too-long tail part dropped by the length gate. Neither is
  // worth throwing away an already-billed generation over, so the short chain
  // ships — and this field is what lets the caller say it is short rather
  // than quietly handing back a thread nobody asked for.
  requestedParts?: number;
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
  /**
   * TOTAL posts in the chain, the anchor INCLUDED. Read only when `thread` is
   * set, and — despite the name, which is kept for the clients already
   * sending it — an EXACT count rather than a ceiling. Clamped to
   * [1, REFERENCE_POST_MAX_THREAD_PARTS] by resolveThreadPostCount, since
   * internal callers bypass the DTO's own bounds.
   */
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

// 1 initial attempt + ONE corrective retry, total — deliberately tighter than
// engage-draft.service.ts's 3, because every attempt is a paid model call and
// this endpoint bills per token.
//
// The retry is SHARED by all three correctives (similarity, exact part count,
// length ceiling), so whichever problem surfaces first spends it and the
// others get no second chance. That is a real cost and it is accepted: of the
// three, only similarity hard-fails without its retry — a short part count
// ships the shorter chain with `requestedParts` set, and an over-long tail is
// truncated to its valid prefix, both of which still deliver a usable post.
//
// `canRetry` below keys off the attempt index, so no corrective is ever set
// on an attempt that will not run — that part stays correct at any value.
// RAISING THIS ABOVE 2 IS NOT: `promptWithCorrective` appends its corrective
// to the BASE prompt, which is only sound while at most one corrective can
// ever be issued. At 3+, a second corrective silently discards the first —
// and a count or length retry dropping the anti-plagiarism corrective hands
// the model back the exact prompt it already copied under, with the
// similarity retry spent. Make the correctives accumulate before raising it.
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
    // Total posts in the chain — 1 when no thread was asked for, so every
    // `threadPosts > 1` below reads as "this is a thread". Named for what it
    // holds rather than after the option it comes from, since `maxThreadParts`
    // is neither a max nor a count of parts any more. Clamped here as well as
    // at the DTO: internal callers bypass the DTO, and an unclamped value
    // would set the model's token budget as well as its instructions.
    const threadPosts = options.thread ? resolveThreadPostCount(options) : 1;
    const requiredMentions = requiresMention(brandStrength, mentions);
    const systemPrompt = this._buildSystemPrompt(
      platform,
      strategy,
      sourceAdaptation,
      brandStrength,
      mentions,
      limit,
      threadPosts
    );
    const userPrompt = this._buildUserPrompt(
      reference,
      threadPosts,
      platform,
      limit
    );
    const maxTokens = MAX_TOKENS_PER_POST * threadPosts;

    const usages: ReferencePostUsage[] = [];
    let attemptSystemPrompt = systemPrompt;
    // Correctives ACCUMULATE; they do not replace one another. Each is
    // written for a different failure and stays true for the rest of the
    // generation, so rebuilding from `systemPrompt` alone was actively
    // harmful: a similarity corrective was dropped the moment a later attempt
    // came up short on posts or long on characters, handing the model back
    // the very prompt it had already plagiarised under — with its similarity
    // retry now spent, so the next copy failed the whole (already-billed)
    // generation outright.
    // Exactly one corrective is ever issued (the shared retry allows a single
    // `continue`), so it is simply appended to the base prompt.
    const promptWithCorrective = (corrective: string) =>
      `${systemPrompt}\n\n${corrective}`;
    // Independent budgets, mirroring engage-draft.service.ts's own
    // lengthRetryUsed / mentionRetryUsed pair. Sharing one attempt counter
    // meant a similarity retry spent the ONLY chance a later length overrun
    // would have had (and the reverse) — two unrelated problems competing for
    // the same budget, so whichever surfaced first got the fix and the other
    // failed the whole generation on its very first occurrence.
    let similarityRetryUsed = false;
    let lengthRetryUsed = false;
    let partCountRetryUsed = false;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // A corrective may only be issued when its own retry is unspent AND
      // there is a further attempt to actually run it in. The second half is
      // not redundant: without it, a corrective set on the FINAL attempt
      // `continue`d into nothing — the loop simply ended and fell through to
      // the throw after it, reporting that line's error (historically
      // "too similar") no matter which problem was really left unfixed, after
      // billing the caller for every attempt. Keying off the attempt index
      // instead of a separate counter keeps this correct at any MAX_ATTEMPTS.
      const canRetry = (retryUsed: boolean) =>
        !retryUsed && attempt < MAX_ATTEMPTS - 1;
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

      const parts = this._splitThreadParts(raw, threadPosts);
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

      // Similarity first: a draft that plagiarises the reference is not worth
      // length-checking, and its corrective rewrite changes the text anyway.
      if (similarity.tooSimilar) {
        this.logger.warn(
          `Reference-post draft too similar to source (overlap=${similarity.overlapRatio.toFixed(
            2
          )}, verbatimRun=${similarity.hasLongVerbatimRun}); ${
            canRetry(similarityRetryUsed) ? 'retrying' : 'no retries left'
          }.`
        );
        if (!canRetry(similarityRetryUsed)) {
          throw new TooSimilarToReferenceError(usages);
        }
        similarityRetryUsed = true;
        // The corrective has to push away from the reference's WORDING without
        // contradicting the adaptation the caller asked for: telling a
        // PRESERVE_STRUCTURE request to "keep only the topic" would silently
        // turn it into a FRESH_ANGLE one on the retry.
        attemptSystemPrompt = promptWithCorrective(`Your previous draft reused too much of the reference post's own wording (shared phrases and sentence structure). Rewrite it with entirely new phrasing of your own. ${
          sourceAdaptation === 'PRESERVE_STRUCTURE'
            ? 'You may still follow the same order of ideas, but not one of its sentences or distinctive phrases may survive — re-express every beat from scratch.'
            : 'Keep only the topic and general angle from the reference, and do not reuse any of its sentences or distinctive phrases.'
        } The hard length limit stated above still applies to the rewrite — reaching for new phrasing is not a reason to run longer.`);
        continue;
      }

      // Exact part count. _splitThreadParts has already truncated an OVER-long
      // chain, so the only way to be wrong here is SHORT: the model deciding a
      // 5-post thread has said everything it has to say in 3. That used to be
      // allowed — `maxThreadParts` was a ceiling and the prompt told the model
      // to use only as many parts as the topic earned — which made the count a
      // caller passed look like it did nothing. It gets its own corrective,
      // run before the length gate because a rewrite replaces the text the
      // length gate would have been checking.
      if (threadPosts > 1 && parts.length < threadPosts) {
        if (canRetry(partCountRetryUsed)) {
          partCountRetryUsed = true;
          this.logger.warn(
            `Reference-post thread came back as ${parts.length} of the ${threadPosts} posts requested; retrying with a part-count corrective.`
          );
          // Says WHERE the extra posts come from. Told only "write 5 posts",
          // a model that already considers the topic finished pads with
          // restatement — the exact failure the old "never pad" wording was
          // written to prevent. Splitting existing material finer is the way
          // to hit the count without inventing filler.
          attemptSystemPrompt = promptWithCorrective(`Your previous draft was only ${parts.length} post(s). This thread must be EXACTLY ${threadPosts} posts, separated by ${THREAD_PART_SEPARATOR}. Do not pad with restatement, filler, or a summary post: go back to the material and break it down further — more concrete steps, examples, caveats, or specifics — so that each of the ${threadPosts} posts carries something the others do not. The hard length limit stated above still applies to every post.`);
          continue;
        }
        // No retry available — either it was already spent on this problem,
        // or another corrective took the shared budget first. The draft
        // itself is fine: a coherent, already-billed thread that simply runs
        // shorter than asked. Ship it and report the shortfall
        // (requestedParts below) rather than failing the generation over a
        // post that would have been filler anyway.
        this.logger.warn(
          `Reference-post thread stayed at ${parts.length} of the ${threadPosts} posts requested with no retry left; delivering the shorter thread.`
        );
      }

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

      const overrun = this._findOverLengthPart(platform, parts, outputLength);
      if (!overrun) {
        return {
          text,
          parts,
          usages,
          ...(parts.length < threadPosts ? { requestedParts: threadPosts } : {}),
        };
      }

      // Length is retryable, exactly like similarity. The system prompt states
      // the per-post ceiling and the model mostly respects it — but "mostly"
      // across a four-post thread is four independent chances to overshoot,
      // and failing outright threw away a complete, already-billed draft over
      // a single long part.
      if (canRetry(lengthRetryUsed)) {
        lengthRetryUsed = true;
        this.logger.warn(
          `Reference-post draft exceeded the platform ceiling (${overrun.message}); retrying with a shortening corrective.`
        );
        // Cut CONTENT, not typography: a model told only "make it shorter"
        // strips spaces after punctuation and mashes words together to squeeze
        // under the count, which passes the check and reads terribly. "Do not
        // truncate mid-thought" is the same guard the reply path uses.
        attemptSystemPrompt = promptWithCorrective(`Your previous draft was too long: ${overrun.message} Rewrite it so EVERY post independently fits the platform constraint stated above, with room to spare. Do not truncate mid-thought. Cut or condense actual content — never compress by removing spaces, dropping punctuation, or abbreviating words. ${
          threadPosts > 1
            ? `Keep the thread at EXACTLY ${threadPosts} posts — make a post say less rather than merging two posts or spilling overflow into an extra one.`
            : 'Keep it to a single post.'
        }`);
        continue;
      }

      // Retried and still over. A thread is a linear argument, so the salvage
      // is to KEEP A PREFIX: drop the offending part and everything after it.
      // Dropping only the offending part would leave the ones after it
      // referring back to a beat the reader never saw. index 0 is the anchor —
      // there is no prefix to keep and no post at all without it, so that one
      // still fails.
      if (overrun.index > 0) {
        const kept = parts.slice(0, overrun.index);
        this.logger.warn(
          `Reference-post thread truncated to ${kept.length} of ${parts.length} parts: ${overrun.message}`
        );
        return {
          text: kept.join('\n\n'),
          parts: kept,
          usages,
          droppedParts: parts.length - kept.length,
          // Always set on this path: `kept` is a strict prefix, so it is
          // shorter than the chain that was generated and therefore shorter
          // than the count asked for.
          requestedParts: threadPosts,
        };
      }
      throw new ReferencePostGenerationError(
        overrun.message,
        usages,
        overrun.error
      );
    }

    // Unreachable: `canRetry` is false on the final attempt, so every gate
    // above takes its terminal branch (return, ship-short, truncate, or
    // throw) rather than continuing. Kept as a defensive backstop, and
    // deliberately NOT TooSimilarToReferenceError — naming one specific
    // failure here is what made the old fallthrough misreport a length
    // problem as plagiarism.
    throw new ReferencePostGenerationError(
      'Reference-post generation exhausted its attempt budget without reaching a terminal outcome.',
      usages
    );
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
  private _findOverLengthPart(
    platform: string,
    parts: string[],
    outputLength: number | undefined
  ): { index: number; message: string; error: Error } | null {
    for (let index = 0; index < parts.length; index++) {
      try {
        assertDraftWithinPlatformLimit(platform, parts[index], outputLength);
      } catch (err) {
        const base = err instanceof Error ? err.message : String(err);
        const message =
          parts.length > 1
            ? `${base} (thread part ${index + 1} of ${parts.length})`
            : base;
        return { index, message, error: new Error(message) };
      }
    }
    return null;
  }

  /**
   * ONE phrasing of the length rule, shared by every place that states it: the
   * opening hard constraint, the mid-prompt restatement, the closing reminder,
   * and the user message. Four copies that could drift apart would be four
   * chances to tell the model something subtly different about the single rule
   * it most needs to get right.
   *
   * The safety margin is engage-draft.service.ts's, for the same measured
   * reason: asked for "under 250" the model returns 251–294. X gets its margin
   * structurally (a 260 target under a 280 ceiling) so it keeps the full target
   * and is only TOLD to leave room; on every other platform the requested
   * length IS the ceiling, so the prompted target shrinks to 85%.
   */
  private _describeLengthConstraint(
    platform: string,
    limit: number,
    threadPosts: number
  ): { charLimit: string; lengthScope: string } {
    const SAFETY_MARGIN = 0.85;
    const marginTarget = Math.round(limit * SAFETY_MARGIN);
    return {
      charLimit:
        platform === 'x'
          ? `under ${limit} Twitter-weighted characters (CJK/emoji count as 2, URLs as 23 — leave a safety margin)`
          : platform === 'reddit'
            ? `under ${marginTarget} characters (a firm limit; aim a little under, never over)`
            : `up to ${marginTarget} characters`,
      lengthScope: threadPosts > 1 ? 'EACH post of the thread' : 'the post',
    };
  }

  private _buildSystemPrompt(
    platform: string,
    strategy: string,
    sourceAdaptation: SourceAdaptation,
    brandStrength: number,
    mentions: string[] | undefined,
    limit: number,
    threadPosts: number
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
    const { charLimit, lengthScope } = this._describeLengthConstraint(
      platform,
      limit,
      threadPosts
    );
    const brandReminder = requiredMentions.length
      ? ` and must name ${requiredMentions.map((m) => `"${m}"`).join(' or ')}`
      : '';
    // EXACTLY n, not "up to n". The instruction that used to live here ("use
    // only as many follow-ups as the topic genuinely earns — never pad")
    // handed the length of the thread to the model, so the number the caller
    // passed only ever set an unreachable ceiling. Padding is still forbidden
    // — but the fix for "this topic does not fill 5 posts" is now to cut the
    // material finer, not to return 2.
    const threadBlock =
      threadPosts > 1
        ? `
Thread: write this as a native ${platform} thread of EXACTLY ${threadPosts} posts — a first (anchor) post plus exactly ${
            threadPosts - 1
          } follow-up posts that publish as a reply chain beneath it. Not more, not fewer. Separate every post with a line containing exactly ${THREAD_PART_SEPARATOR} and nothing else. Every post must carry something the others do not: to reach ${threadPosts}, break the material down further — separate steps, examples, caveats, specifics — rather than padding with restatement, filler, or a summary post. The anchor has to stand on its own as a hook, and EACH post — anchor and follow-ups alike — must independently fit the length constraint stated at the top; a thread is not a licence to spend more characters per post.
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
    const outputInstruction =
      threadPosts > 1
        ? `Only output the post text, with ${THREAD_PART_SEPARATOR} between posts — exactly ${
            threadPosts - 1
          } separators for ${threadPosts} posts, and no preface, no numbering like "1/${threadPosts}", no meta-commentary, no quotation of the reference.`
        : 'Only output the post text — no preface, no meta-commentary, no quotation of the reference.';

    // Length is stated FIRST, restated mid-prompt, and repeated last — the same
    // head/tail sandwich engage-draft.service.ts uses, because it is the one
    // rule whose violation is fatal: an over-long post is rejected outright and
    // costs the whole generation, while every other instruction here degrades
    // gracefully. Saying it once in the middle of a long prompt is exactly
    // where an instruction gets lost.
    return `You are a social media copywriter. Write an ORIGINAL ${platform} post INSPIRED BY a reference post — you are not replying to it, and the reference's author will never see this post.

HARD LENGTH LIMIT — THIS OUTRANKS EVERY OTHER INSTRUCTION BELOW: keep ${lengthScope} ${charLimit}. If the strategy, the brand mention, or finishing a thought would push a post past it, cut the content instead${
      threadPosts > 1
        ? ' — cut what a post SAYS, never the number of posts, which is fixed below'
        : ''
    }. A post that overruns is thrown away entirely, so a shorter post that fits always beats a better one that does not.

${strategyInstruction}
Relationship to the reference: ${adaptationInstruction}
${brandInstruction}

${doNotCopyClause}
${mandatoryBrandBlock}${threadBlock}
Platform constraint (restated because it is the one that fails hardest): keep ${lengthScope} ${charLimit}.
Write in the same language as the reference post unless it explicitly asks for another language.

${ORIGINAL_POST_INJECTION_NOTICE}

${outputInstruction}

IMPORTANT: ${lengthScope} must stay ${charLimit}${brandReminder}. Check the length of every post before you answer; if one is over, cut content and rewrite it — never truncate mid-thought.`;
  }

  private _buildUserPrompt(
    reference: ReferencePostFields,
    threadPosts: number,
    platform: string,
    limit: number
  ): string {
    const { charLimit, lengthScope } = this._describeLengthConstraint(
      platform,
      limit,
      threadPosts
    );
    // The user message is the LAST thing the model reads before answering, so
    // the length rule is repeated here as well as at both ends of the system
    // prompt. The reference post sits between them and is often much longer
    // than the limit — an unrepeated constraint competes with that example.
    return `${buildOriginalPostXml(reference)}

Write a new, original ${
      threadPosts > 1 ? `thread of exactly ${threadPosts} posts` : 'post'
    } inspired by this one, following the relationship to the reference stated above. Do not reply to it and do not reword it — write something new.

Length is the hard constraint: keep ${lengthScope} ${charLimit}, regardless of how long the reference post above is.`;
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

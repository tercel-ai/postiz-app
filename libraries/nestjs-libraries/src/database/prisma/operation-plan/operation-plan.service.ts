import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  ServiceUnavailableException,
} from '@nestjs/common';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { OperationPlan } from '@prisma/client';
import { OperationPlanRepository } from './operation-plan.repository';
import { AiseeClient, AiseeBusinessType, AiseeTaskDetail } from '../ai-pricing/aisee.client';
import { AiseeCreditService } from '../ai-pricing/aisee-credit.service';
import { SettingsService } from '../settings/settings.service';
import { OpenaiService, AiUsageInfo } from '@gitroom/nestjs-libraries/openai/openai.service';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';
import {
  resolveRedditTargets,
  MonitoredRedditChannel,
  RedditTargetResolverDeps,
} from './reddit-target-resolver';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { postTitleFromTheme } from './theme-title';
import { weightedLength, textSlicer } from '@gitroom/helpers/utils/count.length';
import { socialIntegrationList } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';

dayjs.extend(utc);

// planPayload.engagePolicies[].keywordTargets shape (project-scoped-post-
// engage-design.md §3.4: "Record<keywordId, number>", per-platform daily
// target; an empty object means no per-keyword breakdown to report here).
interface EngagePolicy {
  platform: string;
  themeTitle?: string;
  enabled: boolean;
  targetRepliesPerDay?: number;
  dailyTargets?: Array<{ date: string; target: number }>;
  keywordTargets?: Record<string, number>;
}

// A generated policy after its keywordTargets LIST (the generation-schema shape,
// forced by OpenAI Structured Outputs' no-dynamic-keys rule) has been folded
// into the Record shape that gets persisted and returned.
type PersistedEngagePolicy = {
  platform: string;
  themeTitle: string;
  targetRepliesPerDay: number;
  dailyTargets: Array<{ date: string; target: number }>;
  enabled: boolean;
  keywordTargets: Record<string, number>;
};

// One entry per calendar day in [startsAt, endsAt]; each day is an array with
// one item PER PLATFORM (a plan can span x/linkedin/instagram, each with its
// own policy). Keyword pacing stays as explicit fields (not compact
// "actual/target" strings) so API consumers do not parse presentation text.
export type ReplyPacingByDay = Record<string, Array<{
  platform: string;
  themeTitle?: string;
  // The aggregate reply target for THIS platform on THIS day — the policy's
  // `dailyTargets` override when one exists, else `targetRepliesPerDay`.
  targetRepliesPerDay?: number;
  // Distinct replies sent on THIS platform on THIS day — same unit ("one reply
  // = one") and scope as targetRepliesPerDay / the send-time daily-target gate.
  // NOT the sum of keywords[].actualReplies: those count per (reply × matched
  // keyword), so one reply matching three keywords adds 3 there but 1 here.
  actualReplies: number;
  keywords: Array<{
    keywordId: string;
    keyword: string;
    actualReplies: number;
    targetReplies: number;
  }>;
}>>;

export interface CreateOperationPlanInput {
  taskId: string;
  startAt: string;
  endAt: string;
  platforms: string[];
  // Optional curated Engage keyword set. Non-empty → used verbatim; omitted or
  // empty → fall back to the task's product_snapshot.keywords.
  keywords?: string[];
}

// Output budget for plan generation. A ~30-day plan carries publish-ready
// content per day per platform, so the completion is long; the provider's
// default cap truncates it into invalid JSON.
const OPERATION_PLAN_MAX_TOKENS = 32000;

// Budget for the coverage-backfill call (_backfillMissingPlatformCoverage) —
// at most one contentItem per requested platform, so this stays far below the
// main generation's budget.
const OPERATION_PLAN_BACKFILL_MAX_TOKENS = 4000;

// Bound the background generation call. The SDK default (600s timeout, 2 retries,
// retried on timeout → ~30min worst case) is too loose now that generation runs
// off the request lifecycle: a stuck request older than the sweeper's staleMs
// would be re-driven concurrently. Worst case here is (maxRetries + 1) × timeout
// = 2 × 8min = 16min, kept safely below the default staleMs (20min).
const OPERATION_PLAN_GEN_TIMEOUT_MS = Number(process.env.OPERATION_PLAN_GEN_TIMEOUT_MS) || 480_000;
const OPERATION_PLAN_GEN_MAX_RETRIES = Number(process.env.OPERATION_PLAN_GEN_MAX_RETRIES ?? 1);

// Heuristic-only timing for the GENERATING progress estimate surfaced by
// getOverview. Generation is a single non-streaming LLM call covering every
// day at once (see _generatePlanArtifacts) — there is no real per-day
// completion signal to report — so this just interpolates elapsed wall time
// against a rough expected duration, tuned so a typical plan reaches ~95%
// around the time a real generation call finishes.
//
// The per-day rate is a LEARNED value (OPERATION_PLAN_PROGRESS_MS_PER_DAY_KEY,
// below): every successful generation feeds its actual
// (completeGeneration time - createdAt) / durationDays back in via an
// exponential moving average (_recordObservedGenerationDuration), so the
// estimate tracks real model/output-size drift instead of staying fixed at
// a value tuned once. This constant is only the seed/fallback before any
// generation has reported in.
const OPERATION_PLAN_PROGRESS_BASE_MS = 6_000;
const OPERATION_PLAN_PROGRESS_PER_DAY_MS_DEFAULT = 1_700;
// Weight given to each new observation in the EMA — responsive enough to
// track real drift within a handful of generations without one slow/fast
// outlier swinging the estimate wildly.
const OPERATION_PLAN_PROGRESS_EMA_ALPHA = 0.3;
// How long the in-memory copy of the learned per-day rate is trusted before
// re-reading Settings — avoids a DB round trip on every getOverview poll
// while still picking up another instance's update within a bounded time.
const OPERATION_PLAN_PROGRESS_CACHE_TTL_MS = 60_000;
// Cap below 100% while still GENERATING: a row past this point is more likely
// stuck than about to finish, and only the terminal status should ever claim
// completion.
const OPERATION_PLAN_PROGRESS_MAX_RATIO = 0.95;

// ── Settings keys (admin-editable; seeded on boot so they appear in the UI) ──
export const OPERATION_PLAN_MAX_DURATION_DAYS_KEY = 'operation_plan.max_duration_days';
export const OPERATION_PLAN_ALLOWED_PLATFORMS_KEY = 'operation_plan.allowed_platforms';
export const OPERATION_PLAN_PLATFORM_CADENCE_KEY = 'operation_plan.platform_cadence';
export const OPERATION_PLAN_MAX_THREAD_PARTS_KEY = 'operation_plan.max_thread_parts';
// Not really "admin-editable" in spirit (see the seed description below) —
// the service keeps it up to date itself. Seeded like the others purely so
// it's visible in the admin Settings UI for observability.
export const OPERATION_PLAN_PROGRESS_MS_PER_DAY_KEY = 'operation_plan.progress_ms_per_day';

// The LLM is only ever told a content item's DATE must fall in [startAt, endAt]
// (see the generation prompt) — nothing steers the clock time, so it's free to
// (and in practice tends to) cluster on round numbers, producing a plan whose
// posts all fire at the same time of day. This jitter is applied once per
// content item at MATERIALIZATION time (never re-rolled — see
// materializePlanPosts), independent of the LLM entirely.
export const OPERATION_PLAN_PUBLISH_TIME_JITTER_MINUTES_KEY =
  'operation_plan.publish_time_jitter_minutes';

// Ceiling for the persisted/returned failure reason. Long enough for a full
// validation sentence, short enough that a provider dumping a payload into its
// error message cannot bloat the row or every getOverview poll.
const OPERATION_PLAN_ERROR_MESSAGE_MAX = 500;

const DEFAULT_MAX_DURATION_DAYS = 30;
const DEFAULT_MAX_THREAD_PARTS = 3;
// ±30 min: enough to break up same-clock-time clustering without meaningfully
// drifting from the slot the plan (or the LLM) intended. 0 disables jitter.
const DEFAULT_PUBLISH_TIME_JITTER_MINUTES = 30;

// An allowlist that can only NARROW the platform set, never widen it: a plan
// platform must still resolve to a connected Integration (twice — here and at
// materialization), so listing e.g. "medium" would NOT make Medium publishable.
// Empty/absent = no extra restriction (every connected platform is allowed).
const DEFAULT_ALLOWED_PLATFORMS: string[] = [];

// Per-platform publishing rhythm fed to the generator as INPUT, so it stops
// guessing content counts. Free-form strings on purpose — this mirrors the
// human "platform playbook" (frequency + how strongly AI systems cite that
// channel), which is editorial guidance, not a machine rule.
type PlatformCadence = { cadence?: string; citationWeight?: string; notes?: string };
const DEFAULT_PLATFORM_CADENCE: Record<string, PlatformCadence> = {
  x: {
    cadence: '1 post per weekday, lighter on weekends; 1-2 threads per week',
    citationWeight: 'medium — Grok reads X directly; threads split into data points are more quotable',
  },
  linkedin: {
    cadence: '3-4 posts per week',
    citationWeight: 'medium — B2B authority signal',
  },
  instagram: {
    cadence: '3-5 posts per week',
    citationWeight: 'low — rarely cited as a text source',
  },
  reddit: {
    cadence: '2-3 self-posts per week across relevant subreddits',
    citationWeight: 'high — Reddit threads are a top retrieval source for AI search engines',
  },
  medium: {
    cadence: '1-2 articles per week',
    citationWeight: 'medium — long-form articles get indexed and quoted',
  },
  devto: {
    cadence: '1-2 articles per week',
    citationWeight: 'medium — strong reach for developer topics via tag feeds',
  },
  hackernews: {
    cadence: '1-2 submissions per week',
    citationWeight: 'medium — high visibility when a submission lands; lead with substance, overt promotion is punished',
  },
  quora: {
    cadence: '2-3 answers per week',
    citationWeight: 'medium — Q&A format maps directly onto AI answer retrieval',
  },
};

// Last-resort rhythm for a requested platform with neither an admin-configured
// nor a built-in cadence entry. The playbook must cover EVERY requested
// platform: an absent entry reads as "no volume" to the model, and that is
// exactly how whole platforms used to end up with zero generated content.
const GENERIC_PLATFORM_CADENCE: PlatformCadence = { cadence: '2-3 posts per week' };

const DEFAULT_CONTENT_LIMIT = 3000;

// Hard per-platform content ceiling for generated posts — content over this can
// never publish (the plan would materialize DRAFT Posts doomed to fail at
// release). The SINGLE SOURCE OF TRUTH is each provider's own `maxLength()` (the
// exact ceiling the publisher enforces), so this never drifts as providers are
// added/changed and it automatically covers every provider AND its variants
// (linkedin-page, mastodon-custom, instagram-standalone inherit their base's
// maxLength). Unknown/unregistered platform → DEFAULT_CONTENT_LIMIT. X's
// maxLength takes an isTwitterPremium flag; we omit it → the conservative
// non-premium 280, measured with twitter-text WEIGHTED counting (every URL
// counts as 23 regardless of real length; CJK/emoji count 2), matching
// EngageDraftService's ceiling and _contentLength() below.
const hardLimitFor = (platform: string): number =>
  socialIntegrationList.find((p) => p.identifier === platform)?.maxLength() ??
  DEFAULT_CONTENT_LIMIT;

// What we INSTRUCT the model to stay within — deliberately BELOW the hard
// ceiling, and the gap is the whole point.
//
// The model treats a stated budget as a soft aim and DRIFTS past it: with 240
// declared (twice — prompt head and tail), measured runs came back at 0/13 over
// 240 (max 239) and 7/16 over 240 (max 260). The 40-char gap to X's real 280 is
// sized to absorb that drift, and it did: 0/29 posts exceeded 280.
//
// So do NOT "tidy" this by making the target the hard limit (a 260-char post is
// perfectly publishable — rejecting it would throw away an entire paid
// generation over nothing), and do NOT close the gap by raising the target to
// 280 (drift would then land above X's real ceiling and the plan WOULD fail).
// Same soft-target/hard-ceiling split as EngageDraftService (260/280).
//
// Only X needs a hand-tuned soft target. For every other platform the soft
// budget is its hard limit, but CAPPED at MAX_CONTENT_TARGET so a platform with
// a huge ceiling (facebook 63206, blog providers 100000, listmonk 100000000)
// does not invite a novel — a marketing-plan post stays concise. The cap equals
// the largest real target under the previous hardcoded table (linkedin 3000),
// so the six originally-tuned platforms are unchanged.
const MAX_CONTENT_TARGET = 3000;
const PLATFORM_CONTENT_TARGETS: Record<string, number> = {
  x: 240,
};
const targetFor = (platform: string): number =>
  Math.min(
    PLATFORM_CONTENT_TARGETS[platform] ?? hardLimitFor(platform),
    MAX_CONTENT_TARGET
  );

// Whether a platform can publish a native thread — sourced from the provider's
// `comment` capability (the SAME flag the publisher checks via isCommentable),
// so this can never drift from what actually publishes. A platform without
// `comment` (thread would silently not chain) must never be threaded.
const threadCapablePlatforms = (platforms: string[]): string[] =>
  platforms.filter(
    (platform) =>
      !!socialIntegrationList.find((p) => p.identifier === platform)?.comment
  );

const GeneratedPlanSchema = z.object({
  goal: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    // Realistic post-campaign target score (0-100). baselineScore is injected
    // by the backend from the source analysis, not produced by the LLM.
    targetScore: z.number().min(0).max(100),
  }).strict(),
  contentItems: z.array(z.object({
    contentId: z.string().min(1),
    utcDate: z.string().datetime(),
    themeKey: z.string().min(1),
    themeTitle: z.string().min(1),
    platforms: z.array(z.object({
      id: z.string().uuid(),
      platform: z.string().min(1),
      content: z.string().min(1),
      // Reddit ONLY: the target community the post should go to (bare name, no
      // `r/` prefix). Reddit's submit API requires a subreddit — unlike X, a
      // content-only post cannot publish. The backend VALIDATES this against
      // Reddit's public API before materializing (resolveRedditTargets): an
      // invalid/dead subreddit drops the Reddit post. When the project already
      // monitors Reddit channels those override this value, so it is best-effort.
      // null for every non-Reddit platform (per the Structured-Outputs
      // "required + nullable, never optional" rule noted on `media`).
      subreddit: z.string().nullable(),
      // Reddit ONLY: how the post should be FILED in the target community, for
      // subreddits that gate submissions on it (r/MachineLearning rejects a post
      // with no flair AND a title carrying no [R]/[N]/[P]/[D] tag).
      //
      // Both are proposals, never authority: nothing outside a logged-in Reddit
      // session can enumerate a subreddit's real flairs or tag list, so these are
      // reconciled downstream against what Reddit actually offers — an invented
      // flairLabel simply fails to match and the choice falls to the user.
      // null for every non-Reddit platform, and for Reddit posts going to a
      // community with no such rule (per the Structured-Outputs "required +
      // nullable, never optional" rule noted on `media`).
      flairLabel: z.string().nullable(),
      titleTag: z.string().nullable(),
      // Dev.to ONLY: up to 4 topic tags. Unlike Reddit's subreddit these are not
      // required to publish, but dev.to's distribution runs almost entirely
      // through tag feeds — an untagged article reaches little beyond the
      // author's own followers, so a tagless dev.to post is a wasted one. The
      // backend normalizes and caps these (normalizeDevtoTags); null for every
      // non-dev.to platform, per the Structured-Outputs "required + nullable,
      // never optional" rule noted on `media`.
      tags: z.array(z.string()).nullable(),
      // OpenAI Structured Outputs constraints (both learned the hard way — a
      // violation is a 400 from the provider, not a local error):
      //  1. every field must be REQUIRED; optionality is `.nullable()`, never
      //     `.optional()` (a bare `.optional()` makes zodResponseFormat throw).
      //  2. only a fixed set of string `format`s is allowed (date-time, time,
      //     date, duration, email, hostname, ipv4, ipv6, uuid) — `.url()` emits
      //     `format: "uri"`, which is REJECTED. Keep it a plain string.
      media: z.array(
        z.object({ url: z.string().min(1), altText: z.string().nullable() }).strict()
      ).nullable(),
      // Optional native thread. `content` above is the anchor/first post; this
      // holds posts 2..N as an ORDERED reply-chain (X thread / Reddit follow-up
      // comments). null or empty = a single post — the model decides whether a
      // thread helps and how long it runs (see the THREADS prompt section).
      // Each part is its own Post row and must independently fit the platform
      // budget; each needs a fresh UUID `id` (stable across materialize re-runs,
      // so it is generated by the model and stored in the payload, NOT minted at
      // materialize time). Nullable, not optional, per the Structured-Outputs
      // constraint noted on `media`.
      thread: z.array(
        z.object({
          id: z.string().uuid(),
          content: z.string().min(1),
          media: z.array(
            z.object({ url: z.string().min(1), altText: z.string().nullable() }).strict()
          ).nullable(),
        }).strict()
      ).nullable(),
    }).strict()).min(1),
  }).strict()),
  engagePolicies: z.array(z.object({
    platform: z.string().min(1),
    themeTitle: z.string().min(1),
    // The DEFAULT daily reply target — used for any date not overridden by
    // `dailyTargets` below.
    targetRepliesPerDay: z.number().int().min(0),
    // Per-day overrides keyed by concrete UTC date (YYYY-MM-DD). This is what
    // makes "weekday 5 / weekend 3" expressible — a single scalar could not.
    // Deliberately dated, NOT week-numbered: the week is derivable from the
    // date + the plan's startsAt, so storing it would duplicate state.
    // `.date()` emits JSON-schema `format: "date"`, which OpenAI Structured
    // Outputs accepts (unlike `uri`).
    dailyTargets: z.array(z.object({
      date: z.string().date(),
      target: z.number().int().min(0),
    }).strict()),
    // A LIST, not a Record: OpenAI Structured Outputs rejects dynamic-key
    // objects (`z.record()` emits `additionalProperties: {...}` with no fixed
    // `properties`, which is invalid_json_schema). The service folds this list
    // into the persisted `Record<EngageKeyword.id, number>` shape.
    keywordTargets: z.array(z.object({
      keyword: z.string().min(1),
      target: z.number().int().min(0),
    }).strict()),
    enabled: z.boolean(),
  }).strict()),
  warnings: z.array(z.string()),
}).strict();

// Everything the generation step needs, resolved synchronously up front so it
// can run either inline (dry-run preview) or in the background job (real path)
// off the same inputs. `task` carries the source analysis; `effectiveKeywords`
// and `platformPlaybook` are the already-resolved generator inputs.
interface PlanGenerationContext {
  start: Date;
  end: Date;
  durationDays: number;
  platforms: string[];
  task: AiseeTaskDetail;
  baselineScore: number | null;
  effectiveKeywords: string[];
  platformPlaybook: Record<string, PlatformCadence>;
  // Admin-configurable thread ceiling, resolved up front (in create's awaited
  // section, alongside platformPlaybook) so _generatePlanArtifacts stays free of
  // a settings read before the LLM call.
  maxThreadParts: number;
}

// The generated-and-validated plan plus its display summary — the shared output
// of _generatePlanArtifacts, consumed by both the preview and the persist path.
interface PlanArtifacts {
  generation: { data: z.infer<typeof GeneratedPlanSchema>; usage: AiUsageInfo };
  // Every LLM usage this generation incurred — the main call plus each shrink
  // call (possibly on a different model). Billed as a multi-item transaction so
  // shrink tokens are never dropped.
  usages: AiUsageInfo[];
  planData: {
    title: string;
    description: string;
    baselineScore: number | null;
    targetScore: number;
  };
}

@Injectable()
export class OperationPlanService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OperationPlanService.name);
  // In-memory copy of the learned progress ms-per-day rate; see
  // OPERATION_PLAN_PROGRESS_CACHE_TTL_MS for why this is cached at all.
  private _progressMsPerDayCache: { value: number; loadedAt: number } | null = null;

  constructor(
    private _repo: OperationPlanRepository,
    private _aiseeClient?: AiseeClient,
    private _creditService?: AiseeCreditService,
    private _settingsService?: SettingsService,
    private _openaiService?: OpenaiService,
    // Optional (like the others) so unit tests can construct the service with
    // fewer deps. Used only on the real persist path to map generated
    // keywordTargets from keyword TEXT to EngageKeyword.id (get-or-create).
    private _engageRepository?: EngageRepository,
    // Optional for the same reason. Used only to align freshly materialized
    // DRAFT posts with the project's publish time windows — see
    // _materializePlanPosts.
    private _postsService?: PostsService
  ) {}

  /**
   * Materialize a READY plan's posts, then align the resulting DRAFTs with the
   * project's publish time windows.
   *
   * The alignment rides here rather than inside materializePlanPosts because
   * the two answer different questions: materialization turns the payload into
   * rows (and must stay a pure, idempotent function of the payload), while
   * alignment reads live project configuration that has nothing to do with the
   * plan. Keeping them separate is also what lets the commit path run the
   * alignment a second time, against a window that may have changed since.
   *
   * Best-effort: a plan that generated successfully must not be reported as
   * failed because its schedule could not be tidied.
   */
  private async _materializePlanPosts(plan: OperationPlan, planPayload: unknown) {
    await this._repo.materializePlanPosts(
      plan,
      planPayload,
      await this._resolvePublishTimeJitterMinutes()
    );
    // No projectId means no per-project windows to align against — the whole
    // publishing configuration is project-scoped.
    if (!this._postsService || !plan.projectId) return;
    try {
      await this._postsService.alignPlanDraftPublishDates(
        plan.organizationId,
        plan.projectId,
        plan.id
      );
    } catch (err) {
      this.logger.warn(
        `Publish-window alignment failed for plan ${plan.id} (posts keep their generated times): ` +
          OperationPlanService.failureReason(err)
      );
    }
  }

  // Seed the admin-editable knobs so they exist as rows (with description +
  // default) and therefore show up in the admin Settings UI. Insert-if-absent
  // only — never clobber an operator's configured value — and never let a
  // settings failure block boot.
  async onApplicationBootstrap(): Promise<void> {
    if (!this._settingsService) return;
    const seeds: Array<{ key: string; value: unknown; type: string; description: string }> = [
      {
        key: OPERATION_PLAN_MAX_DURATION_DAYS_KEY,
        value: DEFAULT_MAX_DURATION_DAYS,
        type: 'number',
        description:
          'Maximum operation-plan length in whole days. A longer requested range is rejected with DURATION_EXCEEDS_MAX.',
      },
      {
        key: OPERATION_PLAN_ALLOWED_PLATFORMS_KEY,
        value: DEFAULT_ALLOWED_PLATFORMS,
        type: 'json',
        description:
          'Allowlist of platforms an operation plan may use, e.g. ["x","linkedin"]. Empty = no extra restriction. ' +
          'This can only NARROW the set: a platform must still have a connected integration, so listing a channel ' +
          'without one (e.g. "medium") does NOT make it publishable.',
      },
      {
        key: OPERATION_PLAN_PLATFORM_CADENCE_KEY,
        value: DEFAULT_PLATFORM_CADENCE,
        type: 'json',
        description:
          'Per-platform publishing rhythm fed to the plan generator, e.g. ' +
          '{"x":{"cadence":"1 post/weekday","citationWeight":"medium","notes":"..."}}. ' +
          'Steers how much content it writes per platform instead of letting it guess.',
      },
      {
        key: OPERATION_PLAN_MAX_THREAD_PARTS_KEY,
        value: DEFAULT_MAX_THREAD_PARTS,
        type: 'number',
        description:
          'Maximum follow-up posts in a generated thread (the anchor is separate, so the ' +
          'full chain is 1 + this). A ceiling so the generator cannot spin up a huge thread; ' +
          'the prompt states it and over-long threads are truncated. 0 disables threads.',
      },
      {
        key: OPERATION_PLAN_PUBLISH_TIME_JITTER_MINUTES_KEY,
        value: DEFAULT_PUBLISH_TIME_JITTER_MINUTES,
        type: 'number',
        description:
          'Random ± minutes applied to each generated post\'s publish time at materialization, ' +
          'so a plan does not fire every post at the same clock time day after day (the generator ' +
          'is only told a DATE range, never a time-of-day, so it tends to cluster on round numbers). ' +
          'Applied once per post, never re-rolled on re-materialize. 0 disables jitter.',
      },
      {
        key: OPERATION_PLAN_PROGRESS_MS_PER_DAY_KEY,
        value: OPERATION_PLAN_PROGRESS_PER_DAY_MS_DEFAULT,
        type: 'number',
        description:
          'Learned ms-per-day rate behind the GENERATING progress estimate in getOverview ' +
          '(planId).progress. Auto-updated via a moving average after every successful ' +
          'generation — not meant to be hand-tuned; editing it just seeds the next average.',
      },
    ];
    for (const seed of seeds) {
      try {
        const existing = await this._settingsService.get(seed.key);
        if (existing === null || existing === undefined) {
          await this._settingsService.set(seed.key, seed.value, {
            type: seed.type,
            description: seed.description,
            defaultValue: seed.value,
          });
        }
      } catch (err) {
        this.logger.error(`Failed to seed default setting ${seed.key}:`, err);
      }
    }
  }

  async create(
    organizationId: string,
    projectId: string,
    input: CreateOperationPlanInput,
    options: { dryRun?: boolean } = {}
  ) {
    if (!this._aiseeClient || !this._creditService || !this._settingsService || !this._openaiService) {
      throw new ServiceUnavailableException({
        code: 'OPERATION_PLAN_UNAVAILABLE',
        message: 'Operation plan generation is unavailable',
      });
    }
    const { start, end, durationDays, platforms } = await this._validateInput(
      organizationId,
      input
    );
    const taskLookup = await this._aiseeClient.getTaskDetail(input.taskId);
    if ('reason' in taskLookup) {
      if (taskLookup.reason === 'unavailable') {
        throw new ServiceUnavailableException({
          code: 'AISEE_UNAVAILABLE',
          message: 'The analysis service is unavailable',
        });
      }
      throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
    }
    const ownerUserId = await this._creditService.resolveOwnerUserId(organizationId);
    const task = taskLookup.task;
    if (task.productId !== projectId || task.userId !== ownerUserId) {
      throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
    }
    const readyStatuses = new Set(['completed', 'complete', 'success', 'succeeded', 'done']);
    const usableResult =
      typeof task.result === 'string'
        ? task.result.trim().length > 0
        : Array.isArray(task.result)
          ? task.result.length > 0
          : !!task.result && typeof task.result === 'object' && Object.keys(task.result).length > 0;
    if (!readyStatuses.has(task.status.toLowerCase()) || !usableResult) {
      throw new ConflictException({ code: 'TASK_NOT_READY', message: 'Task is not ready' });
    }

    // A task may now own MULTIPLE plans — one per distinct parameter set. This
    // POST endpoint always CREATES a new plan; it only short-circuits to an
    // existing one for idempotency, i.e. when EVERY parameter (project, window,
    // platforms) matches an already-persisted plan (retry-safety, no double
    // bill). A request whose parameters differ finds no match here and falls
    // through to generate a brand-new plan that coexists with the earlier ones.
    // (Previously a task was capped at one plan and a differing-parameter request
    // was rejected with TASK_ALREADY_PLANNED — that guard has been removed.)
    const existingPlans = await this._repo.findManyByTaskId(organizationId, input.taskId);
    const existing = existingPlans.find(
      (plan) =>
        plan.projectId === projectId &&
        plan.startsAt.getTime() === start.getTime() &&
        plan.endsAt.getTime() === end.getTime() &&
        [...plan.platforms].sort().join('\0') === [...platforms].sort().join('\0')
    );
    if (existing) {
      // Dry-run must stay read-only: surface the already-persisted plan as a
      // preview without reconciling billing or (re)materializing any Post.
      if (options.dryRun) {
        return { ...this._toRecord(existing), dryRun: true };
      }
      if (existing.status === 'BILLING_PENDING') {
        return this._reconcilePending(existing);
      }
      if (existing.status === 'READY') {
        await this._materializePlanPosts(existing, existing.planPayload);
      }
      return this._toRecord(existing);
    }

    if (!(await this._creditService.hasCredits(organizationId))) {
      throw new HttpException({
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        code: 'INSUFFICIENT_CREDIT',
        message: 'Insufficient credits',
      }, HttpStatus.PAYMENT_REQUIRED);
    }

    // Generation inputs, resolved synchronously so both the dry-run preview and
    // the background job run off identical data:
    //   - baselineScore: aggregate total_score of the source task (0-100), fed
    //     to the generator to anchor a realistic targetScore and stored on
    //     `data` for display. Nested under result.result; falls back to a
    //     top-level total_score.
    //   - effectiveKeywords: the Engage keyword set (curated → analyzer →
    //     snapshot; see _resolveEffectiveKeywords).
    //   - platformPlaybook: admin-configured publishing rhythm for the
    //     requested platforms (see _buildPlatformPlaybook).
    const baselineScore = this._extractBaselineScore(task.result);
    const effectiveKeywords = this._resolveEffectiveKeywords(task, input.keywords);
    const platformPlaybook = await this._buildPlatformPlaybook(platforms);
    const maxThreadParts = await this._resolveMaxThreadParts();
    const ctx: PlanGenerationContext = {
      start,
      end,
      durationDays,
      platforms,
      task,
      baselineScore,
      effectiveKeywords,
      platformPlaybook,
      maxThreadParts,
    };

    // Dry-run/preview: generate + validate SYNCHRONOUSLY and return the plan
    // WITHOUT persisting, billing, or materializing any Post. Lets callers
    // eyeball the plan (and its estimated token usage) before committing credits
    // + DB rows. Everything here is read-only except the LLM generation call
    // itself (real token cost to us, but NO user-credit deduction).
    if (options.dryRun) {
      const { generation, planData, usages } = await this._generatePlanArtifacts(projectId, ctx);
      // Preview the SAME linkedin personal/page resolution materializePlanPosts
      // applies for real, so what a caller sees here matches what actually
      // publishes once this plan is submitted (a dry-run for an org with only a
      // linkedin-page integration would otherwise always show 'linkedin').
      const previewContentItems = await this._resolveLinkedinForPreview(
        organizationId,
        generation.data.contentItems
      );
      return {
        id: null as string | null,
        projectId,
        taskId: input.taskId,
        sourceTaskVersion: task.version ?? undefined,
        campaignId: randomUUID(),
        durationDays,
        platforms,
        generatorVersion: 'operation-plan-v1',
        status: 'PREVIEW',
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        data: planData,
        contentItems: previewContentItems,
        // Preview keeps keyword TEXT keys (no EngageKeyword rows are created).
        engagePolicies: this._foldKeywordTargets(
          generation.data.engagePolicies,
          (keyword) => keyword
        ),
        warnings: generation.data.warnings ?? [],
        dryRun: true,
        // Total tokens across the main generation AND every shrink call, so the
        // preview estimate reflects the true cost (the real bill prices each
        // usage per its own model; this summed view is a client-facing estimate).
        estimatedUsage: this._sumUsages(usages),
      };
    }

    // Real path: persist a GENERATING stub NOW so we can return the plan id
    // immediately, then generate + bill in the background. Callers poll the
    // returned id for status transitions (GENERATING → BILLING_PENDING → READY).
    const plan = await this._repo.create({
      organizationId,
      projectId,
      taskId: input.taskId,
      sourceTaskVersion: task.version,
      platforms,
      generatorVersion: 'operation-plan-v1',
      campaignId: randomUUID(),
      startsAt: start,
      endsAt: end,
      status: 'GENERATING',
      // Stub payloads — filled in by _generateAndBill once generation finishes
      // (planPayload is NON-nullable, so it cannot be left unset).
      planPayload: {},
      data: {},
      sourceResultHash: createHash('sha256').update(JSON.stringify(task.result)).digest('hex'),
    });

    // Fire-and-forget: generation + billing run off the request lifecycle. A
    // failure is logged and (for stuck rows) retried by the generation sweeper;
    // it must never reject into the caller. Mirrors EngageService's
    // triggerImmediateScan(...).catch(...) pattern.
    this._generateAndBill(plan.id, organizationId, projectId, input, ctx).catch((error) =>
      this.logger.error(
        `Operation plan background generation failed for plan ${plan.id}:`,
        error instanceof Error ? error.stack : error
      )
    );

    // Return immediately with the persisted stub (status GENERATING, id present).
    return { ...this._toRecord(plan) };
  }

  // Generate the plan via the LLM, validate it, and build the display summary.
  // Shared by the dry-run preview and the background persist path so the (large)
  // generation prompt lives in exactly one place. Read-only apart from the
  // billed generation call; throws on an invalid/over-budget plan.
  private async _generatePlanArtifacts(
    projectId: string,
    ctx: PlanGenerationContext
  ): Promise<PlanArtifacts> {
    const { start, end, durationDays, platforms, task, baselineScore, effectiveKeywords, platformPlaybook, maxThreadParts } = ctx;

    // Every UTC day the plan may address, enumerated. Given startAt/endAt as
    // instants alone the model drifts past the end of the range when it maps the
    // final (partial) week onto a full one — it emitted 2026-08-23 for a range
    // ending 2026-08-21 — and those dates are unusable as per-day overrides.
    // Handing it the closed list removes the arithmetic. Bounded by the
    // admin-configurable max duration (default 30 days).
    const rangeDates = Array.from({ length: durationDays }, (_, index) =>
      dayjs.utc(start).startOf('day').add(index, 'day').format('YYYY-MM-DD')
    );

    // Per-platform length budget, stated TWICE in the prompt (opening + closing).
    // The first live run ignored a single mid-prompt mention and produced 20/20
    // unpublishable posts; repeating the constraint at both ends is what makes
    // long-output models actually hold the line.
    const limitLines = platforms.map(
      (p) =>
        `    • ${p}: max ${targetFor(p)} characters` +
        (p === 'x'
          ? ` (X WEIGHTED counting: every URL counts as 23 characters regardless of its real length; CJK characters and emoji count as 2 each. X's own ceiling is ${hardLimitFor('x')} — ${targetFor('x')} is your budget, so you have margin.)`
          : '')
    );

    // Which requested platforms can actually publish a thread (provider `comment`
    // capability). Feeds the prompt so the model never threads an unsupported
    // platform; _normalizeThreads strips any it does anyway.
    const threadable = threadCapablePlatforms(platforms);
    const threadableForPrompt = threadable.length ? threadable.join(', ') : 'none';
    // Admin-configurable thread ceiling (ctx.maxThreadParts, from Settings via
    // create); stated in the prompt and hard-enforced by _normalizeThreads. When
    // 0 (or no platform supports threads) instruct the model to omit threads.
    const threadsEnabled = maxThreadParts > 0 && threadable.length > 0;

    const generation = await this._openaiService!.generateStructuredText(
      [
        'You are an operations planner. Generate a practical, UTC-dated operation plan from the supplied analysis result for a single project. Use ONLY the requested platforms, and keep every content utcDate within the requested [startAt, endAt] range.',
        '',
        '### CHARACTER LIMITS — THE #1 CONSTRAINT (repeated at the end; obey both) ###',
        'Every `contentItems[].platforms[].content` MUST fit its platform budget. Over-budget content is REJECTED and the whole plan fails. Count BEFORE you write, and write to the budget — do not draft long and hope.',
        ...limitLines,
        '',
        '### PLATFORM COVERAGE — EVERY REQUESTED PLATFORM ###',
        `Every platform in \`platforms\` (${platforms.join(', ')}) MUST receive content: at least one contentItems platform entry inside the range, with its volume guided by that platform's platformPlaybook cadence. NEVER leave a requested platform with zero posts — a plan missing ANY requested platform is REJECTED and the whole generation fails, exactly like an over-budget post. Score-driven weighting (below) shifts volume BETWEEN platforms; it never removes one.`,
        '',
        'GOAL',
        '- Produce a `goal` object: a short campaign `title`; a 1-2 sentence `description` of the strategy; and a `targetScore` (0-100) — a REALISTIC analysis score achievable by endAt. targetScore MUST be >= the provided baselineScore and <= 100; scale the uplift to the range length and to how much headroom the weakest dimensions have (do not promise 90 in two weeks from a low baseline).',
        '',
        'WEEK STRUCTURE',
        '- Treat the range as ISO calendar weeks w1..wN (w1 and the final week may be partial). Give each week a coherent phase and progress them foundation -> distribution -> density -> consolidation as the range length allows.',
        '- Encode the week+phase ONLY in themeKey as a stable token (e.g. "w1:foundations") — do NOT invent new fields. themeTitle MUST stay a clean, publish-ready title with NO week or phase prefix (never "W1 - ", "Week 1:", "Foundations: " and the like): it is submitted VERBATIM as the post title on platforms like Reddit, and the week is already carried by themeKey and the post date.',
        '',
        'CADENCE',
        '- Derive content counts from the actual dates, never a fixed template. Weight activity toward workdays (Mon-Fri) over weekends (Sat-Sun): more/heavier items on weekdays, lighter on weekends.',
        // The playbook covers EVERY requested platform (_buildPlatformPlaybook
        // falls back to built-in/generic entries), so this instruction is
        // unconditional — and "lean into higher-citation channels" is volume
        // steering only, bounded by the PLATFORM COVERAGE rule above.
        '- FOLLOW the per-platform playbook in `platformPlaybook` (posting frequency + how strongly AI systems cite that channel). It is the team\'s configured rhythm — match its cadence rather than inventing your own volume. FIRST ensure EVERY requested platform gets at least one contentItem (see PLATFORM COVERAGE above — this is a hard gate, not a suggestion). THEN, once every platform has its minimum, you may weight ADDITIONAL volume toward the higher-citation channels. Never let "lean into higher-citation" override the minimum-coverage rule.',
        '- For each requested platform set `targetRepliesPerDay` to a sustainable WEEKDAY-level reply count — it is the default for any day you do not override.',
        '- Then express the weekday/weekend rhythm concretely in `dailyTargets`: one { date, target } per date that should differ from the default (typically the weekends — a lower target). Every `date` MUST be copied VERBATIM from the `range.dates` list supplied in the payload (UTC "YYYY-MM-DD") — that list is the complete set of days this plan covers, so do NOT compute dates yourself, do NOT extend a partial final week past the last entry, and do NOT repeat a date. A date outside that list is discarded and the day silently keeps the default. Omit a date to leave it at `targetRepliesPerDay`. Return an empty list only if every day genuinely has the same target.',
        '',
        'SCORE-DRIVEN SELECTION',
        '- Read the analysis result and prioritise the weakest / lowest-scoring dimensions and platforms (largest gap to target = highest priority); do NOT spread effort evenly. Bias each theme toward closing a specific weak spot and reflect that gap in themeTitle. "Uneven" means shifting ADDITIONAL volume across platforms AFTER every platform has its minimum one post — it NEVER means dropping a requested platform to zero (see PLATFORM COVERAGE above).',
        '',
        'CONTENT RULES',
        '- Each content item: a stable machine themeKey plus a human-readable themeTitle. Each platform entry: a UUID id (used as the materialized Post.id), the platform, and concise publish-ready content. themeTitle materializes VERBATIM into Post.title (so keep it clean and publish-ready — no week/phase prefix); themeKey is kept as Post.settings.themeKey.',
        '',
        '- CROSS-PLATFORM SHARING: a single `contentItem` SHOULD carry multiple platforms when the theme applies to all of them. For example, a data-story theme can have `platforms: [{platform:"x", ...}, {platform:"linkedin", ...}, {platform:"medium", ...}]` — one item, three platforms, each with content adapted to that platform\'s audience and format. This is MORE efficient than creating separate items per platform (fewer contentItems = lower token cost, better coherence). Prefer consolidating related platforms under one contentItem rather than splitting them. Every contentItem MUST still have at least one platform entry; a theme that only fits one platform stays single-platform. The platformPlaybook cadence drives how many contentItems each platform appears in — match those frequencies, not just the total post count.',
        '- TITLE vs BODY: on reddit, hackernews, medium and devto the themeTitle is submitted SEPARATELY as the post/story title, so `content` is the BODY ONLY. NEVER open `content` with the title (or a heading/bold restatement of it) — the platform would display the title twice. Start directly with the body text.',
        '- Respect the character budgets declared at the top (and repeated below). This is a hard gate, not a style note.',
        '- Write PLAIN TEXT for X: no Markdown. `**bold**`, headings and backticks are NOT rendered — they appear literally as asterisks. Plain prose, line breaks and simple bullets ("•") only.',
        '- Hashtags: a hashtag ENDS at the first space, so a multi-word tag silently breaks — "#MCP protocol" renders as the tag "#MCP" followed by the loose word "protocol". Never hashtag a multi-word keyword: either write it as plain prose (preferred — keywords belong in the sentence, not bolted on as tags) or close it up into one word ("#MCPprotocol"). Use at most 1-2 hashtags, and only single-word ones.',
        '- Prefer content AI systems can cite: concrete data points and answer-style framing. For owned/blog channels, reference the project\'s own canonical URL. "Build-in-public" (sharing real, specific progress/metrics) tends to be the most citable. Keep copy concise and publish-ready.',
        '- REDDIT TARGETING: for every `reddit` platform entry, set `subreddit` to the single most relevant EXISTING, ACTIVE, PUBLIC subreddit for this content (bare name, no "r/" prefix, e.g. "webdev"). Pick a real community you are confident exists and accepts text (self) posts on this topic — the backend verifies it against Reddit and DROPS the post if the subreddit is missing, private, link-only, or inactive, so a wrong guess wastes the post. For EVERY non-reddit platform entry, set `subreddit` to null.',
        '- REDDIT POST RULES: many communities REJECT a submission that is not filed correctly, and the rejection is silent until publish time. For every `reddit` platform entry, if the chosen subreddit is one you know gates posts this way, set `flairLabel` to the post flair it expects, worded as that community words it ("Discussion", "Research", "Project"), and set `titleTag` to the bracketed tag it requires in the title ("[D]", "[R]", "[P]", "[N]"). r/MachineLearning, for example, requires BOTH. Choose the one that genuinely matches the content — a Q&A or open-ended discussion is NOT research, and mis-filing gets a post removed by the subreddit\'s bots. Set either field to null when you are not confident the community requires it (a needless tag on a subreddit that does not use them looks like spam), and set BOTH to null for EVERY non-reddit platform entry.',
        '- REDDIT SELF-PROMOTION / SPAM GUARDRAILS (a prior post was removed for this — treat as a hard rule): NEVER include the project\'s own URL, name, or "I built X, check it out" framing in `content` for a `reddit` platform entry — most subreddits auto-remove or ban for self-promotion regardless of who owns the link. Write the post as a genuine third-person discussion, question, or lesson-learned on the topic instead of an announcement of a product/service/account. Give it a clear, specific title and a substantive body — vague titles, empty bodies, or emoji-only content get removed as low-effort. Do not repeat near-duplicate posts across subreddits or cram in multiple external links (reads as spam and risks a permanent ban); at most one non-promotional supporting link, only when it genuinely helps the discussion. Never reproduce leaked or copyrighted material verbatim — discussing that something leaked is fine, posting the leaked content itself is not.',
        '- DEV.TO TAGGING: for every `devto` platform entry, set `tags` to 1-4 topic tags. Dev.to distributes almost entirely through tag feeds, so an untagged article is close to invisible — treat this as required even though the API does not enforce it. Each tag must be a SINGLE lowercase alphanumeric token with no spaces, hyphens or "#" ("webdev", "javascript", "ai", "buildinpublic"); a multi-word topic must be closed up or dropped. Prefer large, established dev.to tags over invented niche ones — a tag nobody follows is the same as no tag. For EVERY non-devto platform entry, set `tags` to null.',
        '',
        'THREADS (multi-part posts)',
        ...(threadsEnabled
          ? [
              `- ONLY these requested platforms support threads: ${threadableForPrompt}. For EVERY other platform, \`thread\` MUST be null — a thread there cannot publish and will be discarded.`,
              '- On a supported platform a platform entry MAY expand into a native thread via `platforms[].thread`: an ORDERED list of follow-up posts that publish as a reply-chain beneath the main `content` (on X a tweet thread; on Reddit the self-post followed by top-level comments). `content` is ALWAYS the first/anchor post; `thread` holds posts 2..N in reading order.',
              `- YOU decide, per platform, whether a thread earns its place and how long it runs, up to a HARD MAX of ${maxThreadParts} follow-up parts (${maxThreadParts + 1} posts total including the anchor); anything beyond ${maxThreadParts} is dropped. Use a thread ONLY when the theme genuinely needs the room: a multi-step how-to, a data story with several distinct points, a narrative build-up, or a detailed argument. Keep announcements, single hooks, questions and short updates as ONE post — set \`thread\` to null or an empty list. Never pad to hit the max; every part must add something new.`,
              '- Threads suit X far more than Reddit (Reddit rewards one longer self-post over many comments). Lean toward threading on x; default to a single post elsewhere unless the content clearly benefits.',
              '- EVERY thread part is its own post and MUST independently fit the platform character budget declared above — the SAME hard gate as the anchor. Give each part a fresh UUID `id` (distinct from every other id in the plan).',
            ]
          : [
              '- Threads are DISABLED for this plan. Set `thread` to null on EVERY platform entry — do not generate any follow-up parts.',
            ]),
        '',
        'ENGAGE POLICIES',
        '- Each policy needs a human-readable themeTitle and keywordTargets: a LIST of { keyword, target } where `keyword` is the VERBATIM keyword text and `target` is that keyword\'s daily reply count. The sum of all `target` values must not exceed targetRepliesPerDay. Use ONLY keywords from the provided `keywords` list — do not invent keywords outside it, and do not repeat a keyword. The backend maps each keyword to its EngageKeyword id on save. If `keywords` is empty, return an empty keywordTargets list. Omit legacy keyword text arrays and daily hard caps.',
        '',
        'Use warnings[] to flag any infeasibility (range too short for the intended cadence, a requested platform with weak supply, etc.).',
        '',
        '### FINAL REMINDER — CHARACTER LIMITS + PLATFORM COVERAGE (same rules as the top) ###',
        'Before returning, re-check EVERY content string against its budget:',
        ...limitLines,
        'Any single over-budget string fails the entire plan. If a post does not fit, CUT it down — shorten the prose, drop a bullet, or drop a link. Never exceed the budget.',
        '',
        `Also re-check that EVERY platform listed below appears in at least one \`contentItems[].platforms[].platform\` — a plan that silently skips a platform is REJECTED. The requested platforms are: ${platforms.join(', ')}.`,
      ].join('\n'),
      JSON.stringify({
        projectId,
        range: { startAt: start.toISOString(), endAt: end.toISOString(), durationDays, dates: rangeDates },
        platforms,
        platformPlaybook,
        keywords: effectiveKeywords,
        baselineScore,
        analysisResult: task.result,
        productSnapshot: task.productSnapshot,
        sourceUrl: task.url,
      }),
      GeneratedPlanSchema,
      'operation_plan',
      // A multi-week plan (content for every day x platform + engage policies)
      // is a large structured output; the provider's default cap truncates it
      // mid-JSON. Budget generously — plan generation is a one-off, billed call.
      OPERATION_PLAN_MAX_TOKENS,
      // Explicit bound so a stuck provider request can't outlive the sweeper's
      // staleMs and get re-driven concurrently.
      { timeoutMs: OPERATION_PLAN_GEN_TIMEOUT_MS, maxRetries: OPERATION_PLAN_GEN_MAX_RETRIES }
    );
    // Strip threads on unsupported platforms and cap thread length BEFORE
    // shrinking/validating, so we neither shrink parts we are about to drop nor
    // fail a paid generation over a runaway or misplaced thread.
    this._normalizeThreads(generation.data, platforms, maxThreadParts);
    // Shorten any over-ceiling content to fit BEFORE validating, so a single
    // over-budget string can't throw away the whole (paid) generation. Each
    // shrink is its own LLM call — collect their usage so it gets billed too.
    const shrinkUsages = await this._enforceContentLimits(generation.data);

    // Top up any platform the main call left at zero posts before validation
    // gets a chance to reject the whole plan over it (see
    // _backfillMissingPlatformCoverage). Its own content also needs
    // normalizing/shrinking, and its usage is billed alongside everything else.
    const missingPlatforms = this._missingPlatformCoverage(generation.data, platforms);
    if (missingPlatforms.length) {
      const backfill = await this._backfillMissingPlatformCoverage(
        projectId,
        ctx,
        missingPlatforms,
        generation.data.contentItems
      );
      if (backfill) {
        generation.data.contentItems.push(...backfill.contentItems);
        shrinkUsages.push(backfill.usage);
        this._normalizeThreads(generation.data, platforms, maxThreadParts);
        shrinkUsages.push(...(await this._enforceContentLimits(generation.data)));
      }
    }
    // Drop unusable per-day Engage overrides (out-of-range / repeated dates)
    // before validation, so a stray date cannot throw away a paid generation.
    this._normalizeEngagePolicyDates(generation.data, start, end, projectId);
    this._validateGeneratedPlan(generation.data, platforms, start, end);

    // Plan-level goal summary for the `data` column. targetScore is clamped to
    // [baselineScore, 100] as a guard against the LLM promising a score below
    // the baseline or above the ceiling.
    const targetScore = Math.min(
      100,
      Math.max(baselineScore ?? 0, generation.data.goal.targetScore)
    );
    const planData = {
      title: generation.data.goal.title,
      description: generation.data.goal.description,
      baselineScore,
      targetScore,
    };
    // The full LLM cost of this generation: the main structured-output call plus
    // every shrink call. Billing and the dry-run estimate both consume this so no
    // token is dropped.
    const usages: AiUsageInfo[] = [generation.usage, ...shrinkUsages];
    return { generation, planData, usages };
  }

  // Reduce a thrown error to one short, user-safe sentence for `errorMessage`.
  // The validation/provider message ONLY — never a stack, never a cause chain —
  // capped so a runaway provider payload cannot bloat the row or the overview
  // response. Exported as a static for direct unit testing.
  static failureReason(error: unknown): string {
    let raw: unknown;
    if (error instanceof HttpException) {
      const response = error.getResponse();
      raw =
        typeof response === 'string'
          ? response
          : (response as { message?: unknown })?.message ?? response;
    } else if (error instanceof Error) {
      raw = error.message;
    } else {
      raw = error;
    }
    const text =
      typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? raw.join('; ')
          : JSON.stringify(raw ?? null);
    const trimmed = (text || 'Unknown error').trim();
    return trimmed.length > OPERATION_PLAN_ERROR_MESSAGE_MAX
      ? `${trimmed.slice(0, OPERATION_PLAN_ERROR_MESSAGE_MAX - 1)}…`
      : trimmed;
  }

  // A failed deduction's `error` arrives straight off AiseeClient and has three
  // shapes: an orchestrator business message ("insufficient credits" — exactly
  // what the user needs to read), a transport message, and — for any non-2xx —
  // `HTTP <status>: <raw body>`, where the body is the ENTIRE upstream response
  // (an HTML 502 page from a proxy, a traceback from aisee-core). That third
  // shape must not reach the plan page: it is unbounded, so it would also
  // bypass the cap every other reason goes through. Collapse it to the status
  // alone — the full body is already logged by the client — and reduce the
  // other two the same way as any other failure reason.
  private static billingFailureReason(error?: string | null): string | null {
    if (!error) {
      return null;
    }
    const http = /^HTTP (\d{3}):/.exec(error);
    return http
      ? `Credit deduction failed (billing service returned HTTP ${http[1]})`
      : OperationPlanService.failureReason(error);
  }

  // Background job for the real (non-dry-run) path: generate the plan, fold its
  // keyword targets to EngageKeyword ids, write them onto the GENERATING stub
  // row (→ BILLING_PENDING), then run billing VERBATIM (→ READY, materialize
  // posts). Idempotent on the plan id, so the generation sweeper can re-drive a
  // stuck row through the same method. Never throws: generation failures mark the
  // row FAILED, billing failures fall through to BILLING_PENDING/BILLING_FAILED
  // for the reconciliation service to retry.
  //
  // Generation duration is NOT stored as a column; it is derivable as
  // (updatedAt - createdAt) on a terminal row: createdAt is stamped when the
  // GENERATING stub is persisted and updatedAt when this job reaches
  // READY/FAILED. Nothing updates the row after a terminal status
  // (materializePlanPosts touches only Post rows; the sweeper/reconciliation
  // touch only GENERATING/BILLING_PENDING rows), so the delta is stable. Caveat:
  // for a row recovered by the sweeper or by billing reconciliation, the delta
  // also includes the wait before recovery, not just active generation time.
  private async _generateAndBill(
    planId: string,
    organizationId: string,
    projectId: string,
    input: CreateOperationPlanInput,
    ctx: PlanGenerationContext
  ): Promise<void> {
    let artifacts: PlanArtifacts;
    try {
      artifacts = await this._generatePlanArtifacts(projectId, ctx);
    } catch (error) {
      this.logger.error(
        `Operation plan generation failed for plan ${planId}:`,
        error instanceof Error ? error.stack : error
      );
      // Persist WHY it failed, not just that it did: generation runs in the
      // background, so the plan page polling getOverview is the only place the
      // user can learn that (say) a platform came back empty or the provider
      // timed out. Without this the page can only say "failed" and the reason
      // lives in a server log nobody reading the page can see.
      await this._repo.updateStatus(planId, {
        status: 'FAILED',
        errorCode: 'GENERATION_FAILED',
        errorMessage: OperationPlanService.failureReason(error),
      });
      // Generation failure never bills, so Aisee gets no signal from the
      // credit-deduct confirm callback (which covers success). Push the terminal
      // failure directly so the product's plan status does not stay "generating".
      this._aiseeClient?.notifyOperationPlanStatus(projectId, planId, 'failed');
      return;
    }
    const { generation, planData, usages } = artifacts;

    // Reddit posts are unpublishable without a subreddit (unlike X). Resolve one
    // per generated Reddit post — reuse the project's monitored channels, else
    // validate the LLM's proposal against Reddit's public API — attaching a
    // publishing header and dropping posts with no valid target. Done BEFORE the
    // payload is persisted so every materialize path (main/idempotent/sweeper)
    // reads the already-resolved result. Failure here must not fail the paid
    // generation: on error, Reddit posts fall through unresolved and are dropped
    // at materialize by the reddit-target guard.
    try {
      await this._resolveAndAttachRedditTargets(
        organizationId,
        projectId,
        generation.data.contentItems
      );
    } catch (error) {
      this.logger.error(
        `Reddit target resolution failed for plan ${planId} (Reddit posts will be dropped):`,
        error instanceof Error ? error.stack : error
      );
    }

    // Read back the stub for its persisted campaignId/generatorVersion so the
    // payload matches the row (and so a sweeper-resumed row reuses its originals).
    const stub = await this._repo.getById(planId, organizationId);

    // Map each policy's keywordTargets from keyword TEXT (what the LLM produced)
    // to EngageKeyword.id (get-or-create), so downstream pacing/overview can key
    // by EngageKeyword.id as the design requires (§3.4).
    const engagePolicies = await this._mapKeywordTargetsToIds(
      organizationId,
      projectId,
      generation.data.engagePolicies
    );
    const planPayload = {
      ...generation.data,
      engagePolicies,
      campaignId: stub.campaignId,
      generatorVersion: stub.generatorVersion,
      // The analyzed project's own canonical URL, stamped onto the persisted
      // payload so materializePlanPosts can fill hackernews's link-post `url`
      // deterministically from projectId rather than trusting the LLM to
      // reproduce it verbatim (see operation-plan.repository.ts).
      sourceUrl: ctx.task.url ?? null,
      durationDays: ctx.durationDays,
    };
    const plan = await this._repo.completeGeneration(planId, {
      planPayload,
      data: planData,
      status: 'BILLING_PENDING',
    });
    // Feed this generation's actual duration into the learned progress
    // estimate. Fire-and-forget: purely cosmetic, never worth delaying or
    // failing billing over (the method already catches its own errors).
    void this._recordObservedGenerationDuration(
      Date.now() - stub.createdAt.getTime(),
      ctx.durationDays
    );

    let billed;
    try {
      billed = await this._creditService!.deductUsageAndConfirm(
        {
          userId: organizationId,
          taskId: `operation_plan:${plan.id}`,
          businessType: AiseeBusinessType.OPERATION_PLAN,
          description: `Generate operation plan for project ${projectId}`,
          relatedId: plan.id,
          // Passed through to Aisee on BOTH the deduct and the confirm callback,
          // so aisee-core can write this plan's id/status into the product result
          // off the credit event (no separate operation-plan callback needed).
          // plan_status is derived from the confirm `status` — success→ready,
          // failed→failed — not carried here (this dict is built pre-billing and
          // can't know the outcome yet). `bizType` gates it: only operation-plan
          // billing carries it, so post/agent billing stays untouched.
          data: {
            bizType: 'operation_plan',
            projectId,
            planId: plan.id,
            sourceTaskId: input.taskId,
          },
        },
        // The full LLM cost: main generation + every shrink call, each priced by
        // its own model and billed as one multi-item transaction.
        usages
      );
    } catch (error) {
      // Confirmation may have succeeded remotely even when the response was lost.
      // Keep BILLING_PENDING so reconciliation can retry the idempotent billing
      // task — but say why, or a plan sitting in BILLING_PENDING looks like a
      // hang with no trace of the call that failed.
      this.logger.warn(
        `Billing call for plan ${plan.id} did not complete (staying BILLING_PENDING for reconciliation): ` +
        OperationPlanService.failureReason(error)
      );
      return;
    }
    if (billed.deduction && !billed.deduction.success && !billed.deduction.skipped) {
      this.logger.error(
        `Credit deduction rejected for plan ${plan.id}: ${billed.deduction.error ?? 'no reason given'}`
      );
      await this._repo.updateStatus(plan.id, {
        status: 'BILLING_FAILED',
        errorCode: 'CREDIT_DEDUCTION_FAILED',
        // Usually "insufficient credits" — exactly the thing the user can act on.
        errorMessage: OperationPlanService.billingFailureReason(billed.deduction.error),
      });
      return;
    }
    const creditAmount = billed.costItems.length
      ? billed.costItems.reduce((sum, item) => sum + Number(item.amount), 0).toFixed(6)
      : '0.000000';
    const readyPlan = await this._repo.updateStatus(plan.id, {
      status: 'READY',
      billingTransactionId: billed.deduction?.transactionId ?? null,
      creditAmount,
      errorCode: null,
      errorMessage: null,
    });
    await this._materializePlanPosts(readyPlan, planPayload);
  }

  // Engage keyword set for the plan's reply policies, by priority:
  //   1. caller-curated `inputKeywords` (verbatim, when non-empty)
  //   2. the AI-analyzed `result.code_web_analyzer.keywords` (semantic,
  //      analysis-derived — preferred over the SEO/brand snapshot tags)
  //   3. `product_snapshot.keywords` (short SEO/brand tags, last-resort)
  // The generator keys keywordTargets from this exact list (mapped to
  // EngageKeyword.id on the persist path).
  private _resolveEffectiveKeywords(
    task: AiseeTaskDetail,
    inputKeywords?: string[]
  ): string[] {
    const analyzerKeywords = this._asKeywordArray(
      (task.result as { code_web_analyzer?: { keywords?: unknown } })
        ?.code_web_analyzer?.keywords
    );
    const snapshotKeywords = this._asKeywordArray(
      (task.productSnapshot as { keywords?: unknown })?.keywords
    );
    return inputKeywords && inputKeywords.length
      ? inputKeywords
      : analyzerKeywords.length
        ? analyzerKeywords
        : snapshotKeywords;
  }

  // Admin-configured publishing rhythm for the requested platforms (P2-10). Fed
  // to the generator as input so content counts follow the team's real playbook
  // instead of the model's guess. EVERY requested platform gets an entry —
  // admin-configured value first, then the built-in default, then a generic
  // rhythm — because the prompt tells the model to follow the playbook rather
  // than invent volume, so a platform absent from it reads as "no volume" and
  // used to come back with zero content (the plan must cover every requested
  // platform; see PLATFORM COVERAGE in the generation prompt).
  private async _buildPlatformPlaybook(
    platforms: string[]
  ): Promise<Record<string, PlatformCadence>> {
    const cadenceConfig = await this._getPlatformCadence();
    const hasGuidance = (entry?: PlatformCadence): entry is PlatformCadence =>
      !!entry && !!(entry.cadence || entry.citationWeight || entry.notes);
    return platforms.reduce<Record<string, PlatformCadence>>((all, platform) => {
      const configured = cadenceConfig[platform];
      all[platform] = hasGuidance(configured)
        ? configured
        : DEFAULT_PLATFORM_CADENCE[platform] ?? GENERIC_PLATFORM_CADENCE;
      return all;
    }, {});
  }

  // Dry-run mirror of materializePlanPosts' linkedin resolution (personal
  // profile vs company page): prefer a connected `linkedin` integration,
  // falling back to `linkedin-page` only when the org has no personal
  // integration. Kept as a plain map over the generated payload (no Post
  // rows exist yet in a dry-run) so the preview's `platform` field matches
  // what materialization would actually attach an integration to.
  private async _resolveLinkedinForPreview(
    organizationId: string,
    contentItems: z.infer<typeof GeneratedPlanSchema>['contentItems']
  ): Promise<z.infer<typeof GeneratedPlanSchema>['contentItems']> {
    if (!contentItems.some((item) => item.platforms.some((post) => post.platform === 'linkedin'))) {
      return contentItems;
    }
    const connected = new Set(await this._repo.getConnectedPlatforms(organizationId));
    const resolvePlatform = (platform: string): string =>
      platform === 'linkedin' && !connected.has('linkedin') && connected.has('linkedin-page')
        ? 'linkedin-page'
        : platform;
    return contentItems.map((item) => ({
      ...item,
      platforms: item.platforms.map((post) => ({ ...post, platform: resolvePlatform(post.platform) })),
    }));
  }

  private async _validateInput(organizationId: string, input: CreateOperationPlanInput) {
    if (!input.taskId || !Array.isArray(input.platforms) || !input.platforms.length) {
      throw new BadRequestException('taskId and at least one platform are required');
    }
    if (!input.startAt?.endsWith('Z') || !input.endAt?.endsWith('Z')) {
      throw new BadRequestException('startAt and endAt must be UTC ISO 8601 instants');
    }
    const start = new Date(input.startAt);
    const end = new Date(input.endAt);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
      throw new BadRequestException('endAt must be after startAt');
    }
    if (start <= new Date()) throw new BadRequestException('startAt must be in the future');
    const durationDays = dayjs.utc(end).startOf('day').diff(dayjs.utc(start).startOf('day'), 'day') + 1;
    const maxDays =
      (await this._settingsService!.get<number>(OPERATION_PLAN_MAX_DURATION_DAYS_KEY)) ??
      DEFAULT_MAX_DURATION_DAYS;
    if (durationDays > maxDays) {
      throw new BadRequestException({ code: 'DURATION_EXCEEDS_MAX', maxDays });
    }
    // linkedin has two backing integration types — a personal profile
    // (`linkedin`) and a company page (`linkedin-page`) — but content
    // generation always targets a single canonical `linkedin` slot; the
    // generated posts, `hardLimitFor`/`targetFor` (both keyed by provider
    // identifier), the model prompt, and the admin cadence table all only
    // know about `linkedin`. materializePlanPosts resolves which actual
    // integration (personal vs page) to publish through, based on what the
    // org has connected. Normalizing `linkedin-page` -> `linkedin` here means
    // a caller can never make the generator see both as independent
    // platforms and produce duplicate LinkedIn content for the same plan.
    const platforms = [
      ...new Set(
        input.platforms
          .map((value) => value.trim())
          .filter(Boolean)
          .map((platform) => (platform === 'linkedin-page' ? 'linkedin' : platform))
      ),
    ];
    // Publishing is by platform (a plugin reads Post.settings.__type), NOT by an
    // OAuth integration, so a platform need not have a connected account at plan
    // time — materializePlanPosts creates the Post with a null integrationId and
    // the plugin picks it up by platform. The admin allowlist below is therefore
    // the only platform gate.
    const allowed = this._asKeywordArray(
      await this._settingsService!.get(OPERATION_PLAN_ALLOWED_PLATFORMS_KEY)
    ).map((platform) => (platform === 'linkedin-page' ? 'linkedin' : platform));
    if (allowed.length) {
      const allowSet = new Set(allowed);
      const disallowed = platforms.filter((platform) => !allowSet.has(platform));
      if (disallowed.length) {
        throw new BadRequestException({
          code: 'PLATFORM_NOT_ALLOWED',
          message:
            `Platform(s) ${disallowed.join(', ')} are not permitted for operation plans ` +
            `(allowed: ${allowed.join(', ')}).`,
          platforms: disallowed,
          allowed,
        });
      }
    }
    return { start, end, durationDays, platforms };
  }

  // Shorten any generated content over its platform ceiling instead of failing
  // the whole (paid) plan. Two-stage:
  //   1. Preferred (opt-in via OPERATION_SHRINK_MODEL): a cheap-model LLM
  //      rewrite to the SOFT target, which keeps the post coherent. The LLM does
  //      not guarantee the limit, so its output is re-checked.
  //   2. Guarantee: a mechanical, weighted-aware trim (textSlicer) of whatever is
  //      still over the HARD ceiling — or of the original when the LLM is
  //      disabled/fails. Since materialized posts are DRAFTs pending human
  //      approval, a boundary trim is a safe last resort.
  // Mutates the plan in place so the shortened text is what persists.
  // Resolve the max thread length from Settings (admin-editable via aisee-manage
  // → 运营计划), falling back to the default. Mirrors _resolve of maxDays: a
  // non-finite/negative value is ignored. 0 is honoured (disables threads —
  // every thread is then truncated to empty and dropped).
  private async _resolveMaxThreadParts(): Promise<number> {
    const raw = await this._settingsService?.get<number>(
      OPERATION_PLAN_MAX_THREAD_PARTS_KEY
    );
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : DEFAULT_MAX_THREAD_PARTS;
  }

  /** Resolve the publish-time jitter (± minutes) from Settings. Mirrors _resolveMaxThreadParts. */
  private async _resolvePublishTimeJitterMinutes(): Promise<number> {
    const raw = await this._settingsService?.get<number>(
      OPERATION_PLAN_PUBLISH_TIME_JITTER_MINUTES_KEY
    );
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : DEFAULT_PUBLISH_TIME_JITTER_MINUTES;
  }

  // Enforce the two thread invariants the schema deliberately does NOT (no
  // maxItems / no per-platform conditional in Structured Outputs, and hard-
  // failing a paid generation is the wrong call): a thread is only kept on a
  // thread-capable platform, and never longer than `maxThreadParts`. Both are
  // corrected in place (null-out / truncate) with a warning, mirroring how
  // _enforceContentLimits shortens over-budget content rather than rejecting it.
  private _normalizeThreads(
    plan: z.infer<typeof GeneratedPlanSchema>,
    requestedPlatforms: string[],
    maxThreadParts: number
  ): void {
    const threadable = new Set(threadCapablePlatforms(requestedPlatforms));
    for (const item of plan.contentItems) {
      for (const platformItem of item.platforms) {
        const thread = platformItem.thread;
        if (!thread?.length) {
          continue;
        }
        if (!threadable.has(platformItem.platform)) {
          this.logger.warn(
            `Operation plan ${item.contentId} generated a ${thread.length}-part thread for ` +
            `"${platformItem.platform}", which does not support threads; dropping it.`
          );
          platformItem.thread = null;
          continue;
        }
        if (thread.length > maxThreadParts) {
          this.logger.warn(
            `Operation plan ${item.contentId} (${platformItem.platform}) generated ${thread.length} ` +
            `thread parts, over the ${maxThreadParts} max; truncating.`
          );
          // 0 → empty array; normalize to null so downstream treats it as no thread.
          platformItem.thread = maxThreadParts > 0 ? thread.slice(0, maxThreadParts) : null;
        }
      }
    }
  }

  // Engage `dailyTargets` are per-day OVERRIDES of targetRepliesPerDay, keyed by
  // a concrete UTC date. The model reliably gets the rhythm right but not always
  // the calendar: it emits a date just past endAt (a weekend it rounded the
  // final week up to), repeats one, or attaches a non-integer target. Such an
  // entry has no day in this plan to apply to, so it is DROPPED here — the day
  // simply keeps `targetRepliesPerDay` — instead of failing the whole paid
  // generation in _validateGeneratedPlan. Same repair-before-validate contract as
  // _normalizeThreads / _enforceContentLimits; the validator's identical checks
  // stay as a backstop.
  private _normalizeEngagePolicyDates(
    plan: z.infer<typeof GeneratedPlanSchema>,
    start: Date,
    end: Date,
    projectId: string
  ): void {
    const firstDay = dayjs.utc(start).startOf('day');
    const lastDay = dayjs.utc(end).startOf('day');
    for (const policy of plan.engagePolicies) {
      if (!policy.dailyTargets?.length) {
        continue;
      }
      const seen = new Set<string>();
      const kept: NonNullable<typeof policy.dailyTargets> = [];
      const dropped: string[] = [];
      for (const entry of policy.dailyTargets) {
        // Plain regex + isValid, matching _validateGeneratedPlan — this file
        // only loads dayjs's `utc` plugin, not `customParseFormat`.
        const day = dayjs.utc(entry.date);
        const usable =
          /^\d{4}-\d{2}-\d{2}$/.test(entry.date) &&
          day.isValid() &&
          !day.isBefore(firstDay) &&
          !day.isAfter(lastDay) &&
          !seen.has(entry.date) &&
          Number.isInteger(entry.target) &&
          entry.target >= 0;
        if (!usable) {
          dropped.push(`${entry.date}=${entry.target}`);
          continue;
        }
        seen.add(entry.date);
        kept.push(entry);
      }
      if (dropped.length) {
        // This warning is the ONLY trace that an override was discarded — the
        // drop is invisible in the API response by design — so it has to say
        // WHICH plan lost it, or it is unanswerable in a shared log stream.
        this.logger.warn(
          `Operation plan (project ${projectId}) Engage policy "${policy.platform}" generated ` +
          `${dropped.length} unusable dailyTargets (${dropped.join(', ')}) for range ` +
          `[${firstDay.format('YYYY-MM-DD')}, ${lastDay.format('YYYY-MM-DD')}]; dropping them.`
        );
      }
      policy.dailyTargets = kept;
    }
  }

  // Returns the AI usage of every shrink call it fired, so the caller can bill
  // those tokens alongside the main generation (a plan can trigger many shrink
  // calls — one per over-budget anchor / thread part).
  private async _enforceContentLimits(
    plan: z.infer<typeof GeneratedPlanSchema>
  ): Promise<AiUsageInfo[]> {
    // Shrink model: a dedicated override, else reuse OPENROUTER_INTENT_MODEL —
    // the same cheap/fast model the engage intent classifier already uses
    // (defaults to Haiku). Neither set → LLM shrink is off (mechanical only).
    const shrinkModel =
      process.env.OPERATION_SHRINK_MODEL || process.env.OPENROUTER_INTENT_MODEL;
    const usages: AiUsageInfo[] = [];
    for (const item of plan.contentItems) {
      for (const platformItem of item.platforms) {
        // The anchor post, then every thread part — each is an independent post
        // subject to the SAME per-platform ceiling, so shrink them all.
        const anchor = await this._shrinkContentToLimit(
          platformItem.platform,
          platformItem.content,
          `${item.contentId} (${platformItem.platform})`,
          shrinkModel
        );
        platformItem.content = anchor.content;
        if (anchor.usage) usages.push(anchor.usage);
        for (const [index, part] of (platformItem.thread ?? []).entries()) {
          const shrunk = await this._shrinkContentToLimit(
            platformItem.platform,
            part.content,
            `${item.contentId} (${platformItem.platform} thread #${index + 1})`,
            shrinkModel
          );
          part.content = shrunk.content;
          if (shrunk.usage) usages.push(shrunk.usage);
        }
      }
    }
    return usages;
  }

  // Shrink a single content string to its platform ceiling: LLM shrink when a
  // model is configured, then a guaranteed mechanical trim as the backstop.
  // Returns the original untouched (and null usage) when it already fits, and the
  // shrink call's `usage` whenever an LLM call was made — so the caller can bill
  // those tokens. `label` is only for the warning log.
  private async _shrinkContentToLimit(
    platform: string,
    original: string,
    label: string,
    shrinkModel: string | undefined
  ): Promise<{ content: string; usage: AiUsageInfo | null }> {
    const limit = hardLimitFor(platform);
    if (this._contentLength(platform, original) <= limit) {
      return { content: original, usage: null };
    }

    let content = original;
    let usage: AiUsageInfo | null = null;
    if (shrinkModel && this._openaiService) {
      const target = targetFor(platform);
      try {
        const shrunk = await this._openaiService.shrinkToLimit(original, target, {
          model: shrinkModel,
          timeoutMs: OPERATION_PLAN_GEN_TIMEOUT_MS,
          maxRetries: OPERATION_PLAN_GEN_MAX_RETRIES,
        });
        content = shrunk.post;
        // Bill the shrink tokens even if the result still needs a mechanical
        // trim below — the LLM call was made and consumed tokens regardless.
        usage = shrunk.usage;
      } catch (error) {
        this.logger.warn(
          `Operation plan shrink for ${label} failed; ` +
          `falling back to mechanical trim. ${error instanceof Error ? error.message : error}`
        );
        content = original;
      }
    }

    // Guarantee the ceiling — the LLM may overshoot or be disabled.
    if (this._contentLength(platform, content) > limit) {
      content = this._trimToLimit(platform, content, limit);
    }

    this.logger.warn(
      `Operation plan content ${label} exceeded the ${limit} limit; shortened to fit.`
    );
    return { content, usage };
  }

  // Top up coverage for platforms the main generation call left at zero posts,
  // BEFORE _validateGeneratedPlan gets a chance to reject the whole (paid) plan
  // over it. A wide platform set with low weekly cadences (linkedin/medium/
  // devto/hackernews/quora) squeezed into a short range is exactly the case
  // where the model is most likely to skip one despite the PLATFORM COVERAGE
  // instruction — betting the entire generation on nailing every platform in
  // one shot is fragile.
  //
  // Instead of generating from scratch, this method passes the ALREADY-GENERATED
  // content (the anchor/thread posts from the platforms that DID get content,
  // typically x and reddit) as REFERENCE material and asks the model to ADAPT
  // them for the missing platforms. Adaptation is cheaper, more coherent, and
  // keeps the plan's messaging consistent across channels. The model picks the
  // best-matching existing contentItem(s) for each missing platform and rewrites
  // them for that platform's audience, format, and length budget.
  private async _backfillMissingPlatformCoverage(
    projectId: string,
    ctx: PlanGenerationContext,
    missingPlatforms: string[],
    existingContent: z.infer<typeof GeneratedPlanSchema>['contentItems']
  ): Promise<{
    contentItems: z.infer<typeof GeneratedPlanSchema>['contentItems'];
    usage: AiUsageInfo;
  } | null> {
    const { start, end, task, baselineScore, platformPlaybook } = ctx;
    const limitLines = missingPlatforms.map(
      (p) =>
        `    • ${p}: max ${targetFor(p)} characters` +
        (p === 'x'
          ? ` (X WEIGHTED counting: every URL counts as 23 characters regardless of its real length; CJK characters and emoji count as 2 each.)`
          : '')
    );
    const backfillPlaybook = Object.fromEntries(
      missingPlatforms.map((p) => [p, platformPlaybook[p]]).filter(([, v]) => v)
    );
    // Extract just the theme-and-content core of the already-generated items,
    // stripped of UUIDs and platform details — just enough for the model to
    // understand the messaging and adapt it. This keeps the backfill prompt
    // compact (reference, not duplication) and avoids confusing the model
    // with platform-specific fields it should NOT copy verbatim.
    const referenceContent = existingContent.map((item) => ({
      contentId: item.contentId,
      utcDate: item.utcDate,
      themeKey: item.themeKey,
      themeTitle: item.themeTitle,
      platforms: item.platforms.map((p) => ({
        platform: p.platform,
        content: p.content.slice(0, 500), // enough to capture the message
        thread: p.thread?.map((t) => t.content.slice(0, 300)),
        subreddit: p.subreddit,
        tags: p.tags,
      })),
    }));
    const BackfillSchema = z.object({
      contentItems: GeneratedPlanSchema.shape.contentItems.element.array().min(1),
    }).strict();
    try {
      const generation = await this._openaiService!.generateStructuredText(
        [
          'Below is a content plan that already has posts for some platforms but left the listed platform(s) with ZERO posts. DO NOT invent new themes — ADAPT the existing content below for each missing platform. Pick the best-matching existing contentItem(s) and rewrite their message for the missing platform\'s audience, format, and length budget.',
          '',
          `Missing platform(s): ${missingPlatforms.join(', ')}`,
          '',
          '### EXISTING CONTENT (reference — adapt from these) ###',
          JSON.stringify(referenceContent, null, 2),
          '',
          '### CHARACTER LIMITS — HARD GATE ###',
          'Every `contentItems[].platforms[].content` MUST fit its platform budget. Count BEFORE you write.',
          ...limitLines,
          '',
          '- Generate EXACTLY ONE contentItem per listed missing platform (distinct themeKey/themeTitle per item, dated anywhere inside the given range).',
          '- Each contentItem carries exactly ONE `platforms` entry, for the missing platform it corresponds to. Set `thread` to null on every entry — no multi-part threads here.',
          '- ADAPT, don\'t copy: the same message expressed for a different audience and format. For example, an X thread about a data insight becomes a single LinkedIn post with professional framing, or a longer dev.to article with code examples. Keep the theme and the core point; rewrite the delivery.',
          '- Adapt content to each platform\'s native format: LinkedIn = professional, longer; dev.to = technical, tutorial-style; Medium = narrative, explanatory; Quora = direct answer format; HackerNews = concise, factual, no fluff.',
          '- TITLE vs BODY: on reddit, hackernews, medium and devto the themeTitle is submitted SEPARATELY as the post/story title, so `content` is the BODY ONLY — never open it with the title.',
          '- REDDIT TARGETING: if `reddit` is in the missing list, set `subreddit` to the single most relevant EXISTING, ACTIVE, PUBLIC subreddit (bare name, no "r/"). Set `flairLabel`/`titleTag` when you are confident the community requires them, else null. For every non-reddit entry set all three to null.',
          '- REDDIT SELF-PROMOTION / SPAM GUARDRAILS: if `reddit` is in the missing list, NEVER include the project\'s own URL or "I built X" framing in its `content` — write it as a genuine discussion/question, not an announcement, with a clear title and substantive body (no self-promotion, no spam links, no low-effort/empty content, no leaked material verbatim).',
          '- DEV.TO TAGGING: if `devto` is in the missing list, set `tags` to 1-4 single-word lowercase topic tags. For every non-devto entry set `tags` to null.',
          '- Write PLAIN TEXT for X: no Markdown.',
          '- Follow the per-platform rhythm in `platformPlaybook` for tone/substance.',
        ].join('\n'),
        JSON.stringify({
          projectId,
          range: { startAt: start.toISOString(), endAt: end.toISOString() },
          platforms: missingPlatforms,
          platformPlaybook: backfillPlaybook,
          baselineScore,
          analysisResult: task.result,
          productSnapshot: task.productSnapshot,
          sourceUrl: task.url,
        }),
        BackfillSchema,
        'operation_plan_backfill',
        OPERATION_PLAN_BACKFILL_MAX_TOKENS,
        { timeoutMs: OPERATION_PLAN_GEN_TIMEOUT_MS, maxRetries: OPERATION_PLAN_GEN_MAX_RETRIES }
      );
      return { contentItems: generation.data.contentItems, usage: generation.usage };
    } catch (error) {
      this.logger.warn(
        `Operation plan coverage backfill for ${missingPlatforms.join(', ')} failed; ` +
        `falling back to the coverage rejection. ${error instanceof Error ? error.message : error}`
      );
      return null;
    }
  }

  // Collapse many usage records into one summed AiUsageInfo for a client-facing
  // token ESTIMATE (dry-run). Token counts add up across models; the descriptive
  // model/method fields are taken from the first (main-generation) record. NOT
  // used for billing — the real bill prices each usage per its own model.
  private _sumUsages(usages: AiUsageInfo[]): AiUsageInfo {
    const base = usages[0];
    const sum = usages.reduce(
      (acc, u) => ({
        prompt_tokens: acc.prompt_tokens + (u.usage.prompt_tokens ?? 0),
        completion_tokens: acc.completion_tokens + (u.usage.completion_tokens ?? 0),
        total_tokens: acc.total_tokens + (u.usage.total_tokens ?? 0),
        cached_prompt_tokens:
          (acc.cached_prompt_tokens ?? 0) + (u.usage.cached_prompt_tokens ?? 0),
      }),
      { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_prompt_tokens: 0 }
    );
    return { ...base, usage: sum };
  }

  private _trimToLimit(platform: string, content: string, limit: number): string {
    // X: weighted-aware cut point; other platforms: plain char index.
    const end = platform === 'x' ? textSlicer('x', limit, content).end : limit;
    let trimmed = content.slice(0, end);
    // Avoid a mid-word cut: if we sliced inside a word, back up to the last space.
    if (end < content.length && !/\s/.test(content.charAt(end))) {
      const lastSpace = trimmed.lastIndexOf(' ');
      if (lastSpace > 0) trimmed = trimmed.slice(0, lastSpace);
    }
    return trimmed.trimEnd();
  }

  // Requested platforms with zero posts anywhere in `plan.contentItems`. Shared
  // by the pre-validation backfill attempt (_generatePlanArtifacts) and the
  // hard-reject coverage check below, so both agree on exactly what "missing"
  // means.
  private _missingPlatformCoverage(
    plan: z.infer<typeof GeneratedPlanSchema>,
    requestedPlatforms: string[]
  ): string[] {
    const covered = new Set(
      plan.contentItems.flatMap((item) =>
        item.platforms.map((post) => post.platform)
      )
    );
    return requestedPlatforms.filter((platform) => !covered.has(platform));
  }

  private _validateGeneratedPlan(
    plan: z.infer<typeof GeneratedPlanSchema>,
    requestedPlatforms: string[],
    start: Date,
    end: Date
  ) {
    const allowed = new Set(requestedPlatforms);
    const postIds = new Set<string>();
    // Compare by UTC CALENDAR DAY, not instant: the range is a day-inclusive
    // window (durationDays is a startOf('day') diff + 1), so an item dated
    // `endAt`'s day at any time (e.g. 2026-08-14T10:00Z for endAt
    // 2026-08-14T00:00Z) is in range — an instant comparison would reject it.
    const firstDay = dayjs.utc(start).startOf('day');
    const lastDay = dayjs.utc(end).startOf('day');
    for (const item of plan.contentItems) {
      const day = dayjs.utc(item.utcDate).startOf('day');
      if (day.isBefore(firstDay) || day.isAfter(lastDay)) {
        throw new BadRequestException(
          `Generated plan has content dated ${item.utcDate} outside the requested range ` +
          `[${firstDay.format('YYYY-MM-DD')}, ${lastDay.format('YYYY-MM-DD')}]`
        );
      }
      for (const platformItem of item.platforms) {
        if (!allowed.has(platformItem.platform)) {
          throw new BadRequestException(
            `Generated plan used platform "${platformItem.platform}", which was not requested ` +
            `(allowed: ${requestedPlatforms.join(', ')})`
          );
        }
        const limit = hardLimitFor(platformItem.platform);
        // Validate the anchor and every thread part identically: each becomes
        // its own Post row, so all ids must be globally unique and all content
        // must fit the platform ceiling.
        const parts = [
          { id: platformItem.id, content: platformItem.content, label: item.contentId },
          ...(platformItem.thread ?? []).map((part, index) => ({
            id: part.id,
            content: part.content,
            label: `${item.contentId} thread #${index + 1}`,
          })),
        ];
        for (const part of parts) {
          if (postIds.has(part.id)) {
            throw new BadRequestException(
              `Generated plan reused Post id ${part.id}`
            );
          }
          postIds.add(part.id);
          const length = this._contentLength(platformItem.platform, part.content);
          if (length > limit) {
            throw new BadRequestException(
              `Generated ${platformItem.platform} content for ${part.label} is ${length} ` +
              `characters, over the ${limit} limit — it could never publish`
            );
          }
        }
      }
    }
    // Coverage: every requested platform must have produced at least one post.
    // The request's platform set (already bounded by the admin whitelist) is the
    // contract — a plan that silently skips a platform (the model concentrating
    // everything on x/reddit) must fail loudly here, not materialize partial.
    // (_generatePlanArtifacts already tries to top up any gap via
    // _backfillMissingPlatformCoverage before this runs, so reaching here with a
    // gap means that repair attempt also came up short.)
    const missingPlatforms = this._missingPlatformCoverage(plan, requestedPlatforms);
    if (missingPlatforms.length) {
      throw new BadRequestException(
        `Generated plan produced no content for requested platform(s): ` +
        `${missingPlatforms.join(', ')} — every requested platform must receive at least one post`
      );
    }
    for (const policy of plan.engagePolicies) {
      const keywordTargetTotal = policy.keywordTargets.reduce(
        (sum, item) => sum + item.target,
        0
      );
      if (!allowed.has(policy.platform)) {
        throw new BadRequestException(
          `Generated Engage policy targets platform "${policy.platform}", which was not requested ` +
          `(allowed: ${requestedPlatforms.join(', ')})`
        );
      }
      if (keywordTargetTotal > policy.targetRepliesPerDay) {
        throw new BadRequestException(
          `Generated Engage policy for "${policy.platform}" has keyword targets summing to ` +
          `${keywordTargetTotal}, which exceeds targetRepliesPerDay=${policy.targetRepliesPerDay}`
        );
      }
      // Per-day overrides must land on real days of THIS plan, once each —
      // otherwise the pacing gate would silently never apply them.
      //
      // On the generation path these throws are unreachable: this method's only
      // caller runs _normalizeEngagePolicyDates immediately before it, and that
      // normalizer's `usable` predicate is the exact complement of the four
      // conditions below, so every offending entry has already been dropped.
      // They are kept deliberately, as the invariant's single written statement
      // and as a loud backstop if the normalizer is ever loosened — and because
      // this method is also exercised directly by unit tests. If you change one
      // side, change BOTH: a silent divergence here means either an invalid
      // plan is persisted, or a paid generation starts failing again over a
      // stray date, which is the exact production bug the normalizer exists to
      // prevent.
      const seenDates = new Set<string>();
      for (const { date, target } of policy.dailyTargets ?? []) {
        // Plain regex + isValid instead of dayjs strict parsing — this file only
        // loads the `utc` plugin, not `customParseFormat`.
        const day = dayjs.utc(date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !day.isValid()) {
          throw new BadRequestException(
            `Generated Engage policy for "${policy.platform}" has an invalid dailyTargets date "${date}" (expected YYYY-MM-DD)`
          );
        }
        if (day.isBefore(firstDay) || day.isAfter(lastDay)) {
          throw new BadRequestException(
            `Generated Engage policy for "${policy.platform}" has a dailyTargets date ${date} outside ` +
            `the requested range [${firstDay.format('YYYY-MM-DD')}, ${lastDay.format('YYYY-MM-DD')}]`
          );
        }
        if (seenDates.has(date)) {
          throw new BadRequestException(
            `Generated Engage policy for "${policy.platform}" repeats dailyTargets date ${date}`
          );
        }
        seenDates.add(date);
        if (!Number.isInteger(target) || target < 0) {
          throw new BadRequestException(
            `Generated Engage policy for "${policy.platform}" has an invalid dailyTargets target ${target} for ${date}`
          );
        }
      }
    }
  }

  // Aggregate baseline analysis score (0-100). The aisee payload nests it at
  // result.result.total_score; fall back to a top-level total_score. Rounded to
  // 2 decimals; null when absent/unparseable.
  private _extractBaselineScore(result: unknown): number | null {
    const r = result as
      | { result?: { total_score?: unknown }; total_score?: unknown }
      | null;
    const raw = r?.result?.total_score ?? r?.total_score;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  }

  // X counts weighted characters (twitter-text), not raw length — a URL is 23
  // no matter how long it really is. Every other platform is a plain count.
  private _contentLength(platform: string, content: string): number {
    return platform === 'x' ? weightedLength(content) : content.length;
  }

  // Admin-configured per-platform rhythm. Falls back to the built-in defaults
  // when unset; a malformed Settings value must not break generation, so
  // anything non-object degrades to the defaults rather than throwing.
  private async _getPlatformCadence(): Promise<Record<string, PlatformCadence>> {
    try {
      const raw = await this._settingsService?.get(OPERATION_PLAN_PLATFORM_CADENCE_KEY);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as Record<string, PlatformCadence>;
      }
    } catch (err) {
      this.logger.error(`Failed to read ${OPERATION_PLAN_PLATFORM_CADENCE_KEY}:`, err);
    }
    return DEFAULT_PLATFORM_CADENCE;
  }

  // Coerce an unknown value to a clean string[] (non-empty trimmed strings),
  // else []. Used to read keyword arrays out of the loosely-typed task payload.
  private _asKeywordArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
      : [];
  }

  // Generated policies (keywordTargets as a LIST) → the persisted/preview shape
  // (keywordTargets as a Record). `keyFor` picks each entry's Record key:
  // identity for the dry-run preview (keyword text), or the resolved
  // EngageKeyword.id on the persist path. Entries whose key can't be resolved
  // are dropped; entries collapsing to the same key sum their targets (e.g.
  // "AI"/"ai" normalize to one keyword id).
  private _foldKeywordTargets(
    policies: z.infer<typeof GeneratedPlanSchema>['engagePolicies'],
    keyFor: (keyword: string) => string | undefined
  ): PersistedEngagePolicy[] {
    return policies.map((policy) => {
      const keywordTargets: Record<string, number> = {};
      for (const { keyword, target } of policy.keywordTargets ?? []) {
        const key = keyFor(keyword);
        if (!key) continue;
        keywordTargets[key] = (keywordTargets[key] ?? 0) + target;
      }
      return {
        platform: policy.platform,
        themeTitle: policy.themeTitle,
        targetRepliesPerDay: policy.targetRepliesPerDay,
        dailyTargets: (policy.dailyTargets ?? []).map((d) => ({
          date: d.date,
          target: d.target,
        })),
        enabled: policy.enabled,
        keywordTargets,
      };
    });
  }

  // Persist path: fold the generated keywordTargets list into
  // Record<EngageKeyword.id, number>, creating any keyword that doesn't exist
  // yet. Falls back to text keys when EngageRepository wasn't wired in
  // (unit-test construction).
  // Attach a validated Reddit publishing target to every generated Reddit post,
  // MUTATING `contentItems` in place: each reddit platform entry gains a
  // `redditTarget` header, or is REMOVED when no valid subreddit resolves (a
  // content item left with no platforms is dropped entirely). Tier 1 reuses the
  // project's monitored Reddit channels; Tier 2 validates the LLM's `subreddit`
  // against Reddit's public API and persists newly-discovered subreddits back
  // into the Engage config so the next plan takes the cheap Tier-1 path. No-op
  // without an EngageRepository (unit-test construction) — reddit posts then fall
  // through unresolved and are dropped by materialize's guard.
  /**
   * Dependencies handed to resolveRedditTargets. Overridable so a test can run
   * the resolver WITHOUT reaching the network.
   *
   * The seam exists because resolveRedditTargets probes reddit.com
   * (probeSubreddit -> redditPublicGet) and nothing above it could say
   * otherwise: every service-level test that generated a Reddit post made live
   * calls. That is harmless in OUTCOME — a curated Tier-1 channel is kept
   * whether or not its probe is reachable — but not in LATENCY, and it produced
   * the worst kind of failure to diagnose: green when the file ran alone, timed
   * out under full-suite load on a host that cannot reach reddit.com.
   *
   * Production deliberately passes no `fetchPublic`, so the resolver keeps its
   * real default. Only the transport is overridable; tiering, validation and
   * flair resolution always run for real.
   */
  protected redditResolverDeps(
    organizationId: string
  ): RedditTargetResolverDeps {
    return {
      log: (m) => this.logger.debug(m),
      // What previous publishes observed about each community's posting rules.
      // Guarded by the same `this._engageRepository` null check the caller
      // already made.
      getCapability: (subreddit) =>
        this._engageRepository!.getRedditChannelCapability(organizationId, subreddit),
    };
  }

  private async _resolveAndAttachRedditTargets(
    organizationId: string,
    projectId: string,
    contentItems: z.infer<typeof GeneratedPlanSchema>['contentItems']
  ): Promise<void> {
    // Every reddit platform entry across all content items, with its owning item
    // (so a fully-dropped item can be pruned) and the title Reddit requires.
    const redditEntries = contentItems.flatMap((item) =>
      item.platforms
        .filter((post) => post.platform === 'reddit')
        .map((post) => ({ item, post }))
    );
    if (!redditEntries.length || !this._engageRepository) {
      return;
    }

    const monitored = await this._engageRepository.listMonitoredChannels(
      organizationId,
      projectId
    );
    // listMonitoredChannels already restricts to CHANNEL_SCOPE_PLATFORMS, so a
    // reddit re-test here is a no-op that would also drop a second channel
    // platform the day that set widens.
    const monitoredChannels: MonitoredRedditChannel[] = monitored.map((c) => ({
      channelId: c.channelId,
      channelName: c.channelName,
      audienceSize: c.audienceSize,
      enabled: c.enabled,
    }));

    const { outputs, discovered } = await resolveRedditTargets(
      // Reddit's required post title is the content item's themeTitle (there is
      // no per-platform title field), so it is fed in as the target title here —
      // with any leaked week label stripped so the submitted Reddit title matches
      // the materialized Post.title (see postTitleFromTheme).
      redditEntries.map(({ item, post }, index) => ({
        key: `${post.id}:${index}`,
        llmSubreddit: (post as { subreddit?: string | null }).subreddit ?? null,
        title: postTitleFromTheme(item.themeTitle),
        // Community filing rules (flair + bracketed title tag). The resolver
        // prefixes the tag onto the REDDIT title only — themeTitle is shared
        // with this item's other platform entries and must stay untagged.
        llmFlairLabel: (post as { flairLabel?: string | null }).flairLabel ?? null,
        llmTitleTag: (post as { titleTag?: string | null }).titleTag ?? null,
      })),
      monitoredChannels,
      this.redditResolverDeps(organizationId)
    );

    // Apply resolution: attach the header, or mark the entry for removal.
    const drop = new Set<unknown>();
    outputs.forEach((output, index) => {
      const { post } = redditEntries[index];
      if (!output.target) {
        drop.add(post);
        return;
      }
      (post as { redditTarget?: unknown }).redditTarget = output.target;
    });

    if (drop.size) {
      for (const item of contentItems) {
        item.platforms = item.platforms.filter((post) => !drop.has(post));
      }
      // Prune content items whose every platform was dropped.
      contentItems.splice(
        0,
        contentItems.length,
        ...contentItems.filter((item) => item.platforms.length > 0)
      );
    }

    // Persist Tier-2 discoveries back into the project's Engage config so future
    // plans reuse them (Tier 1) and Engage scanning picks them up. Best-effort:
    // a duplicate (409) or any single failure must not fail generation.
    if (discovered.length) {
      try {
        const config = await this._engageRepository.getOrCreateConfig(
          organizationId,
          projectId
        );
        for (const { subreddit } of discovered) {
          await this._engageRepository
            .addMonitoredChannel(config.id, organizationId, {
              platform: 'reddit',
              channelId: subreddit,
              channelName: subreddit,
            })
            .catch((error: unknown) => {
              this.logger.debug(
                `[reddit-target] persist r/${subreddit} skipped: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            });
        }
      } catch (error) {
        this.logger.warn(
          `[reddit-target] could not persist discovered subreddits: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  private async _mapKeywordTargetsToIds(
    organizationId: string,
    projectId: string,
    policies: z.infer<typeof GeneratedPlanSchema>['engagePolicies']
  ): Promise<PersistedEngagePolicy[]> {
    const texts = [
      ...new Set(
        policies.flatMap((policy) => (policy.keywordTargets ?? []).map((t) => t.keyword))
      ),
    ];
    if (!this._engageRepository || !texts.length) {
      return this._foldKeywordTargets(policies, (keyword) => keyword);
    }
    const textToId = await this._engageRepository.resolveOrCreateKeywordIds(
      organizationId,
      projectId,
      texts
    );
    return this._foldKeywordTargets(policies, (keyword) => textToId[keyword]);
  }

  private _toRecord(plan: OperationPlan) {
    const payload = plan.planPayload as {
      contentItems?: unknown[];
      engagePolicies?: unknown[];
      warnings?: string[];
    };
    return {
      id: plan.id,
      projectId: plan.projectId,
      taskId: plan.taskId,
      sourceTaskVersion: plan.sourceTaskVersion ?? undefined,
      campaignId: plan.campaignId,
      durationDays: dayjs.utc(plan.endsAt).startOf('day').diff(dayjs.utc(plan.startsAt).startOf('day'), 'day') + 1,
      platforms: plan.platforms,
      generatorVersion: plan.generatorVersion,
      status: plan.status,
      startsAt: plan.startsAt.toISOString(),
      endsAt: plan.endsAt.toISOString(),
      data: plan.data ?? null,
      contentItems: payload.contentItems ?? [],
      engagePolicies: payload.engagePolicies ?? [],
      billingTransactionId: plan.billingTransactionId ?? undefined,
      creditAmount: plan.creditAmount ?? undefined,
      // Same failure contract as getOverview: a record handed back on a
      // FAILED/BILLING_FAILED status carries the reason, not just the status.
      errorCode: plan.errorCode ?? null,
      errorMessage: plan.errorMessage ?? null,
      warnings: payload.warnings ?? [],
    };
  }

  private async _reconcilePending(plan: OperationPlan) {
    let billed;
    try {
      billed = await this._creditService!.reconcileAwaitedDeduction({
        userId: plan.organizationId,
        taskId: `operation_plan:${plan.id}`,
        businessType: AiseeBusinessType.OPERATION_PLAN,
        description: `Generate operation plan for project ${plan.projectId}`,
        relatedId: plan.id,
        // Same passthrough as _generateAndBill so the reconcile path also lets
        // aisee-core write the plan id/status into the product result.
        data: {
          bizType: 'operation_plan',
          projectId: plan.projectId,
          planId: plan.id,
          sourceTaskId: plan.taskId,
        },
      });
    } catch (error) {
      // A thrown reconcile (most often: the remote credit-confirm keeps failing,
      // e.g. its handler errors) leaves the plan in BILLING_PENDING and the next
      // interval retries. Log it — a silent catch here turns a stuck-forever plan
      // into an invisible one, which is exactly how these rows "never change".
      this.logger.warn(
        `Reconcile of BILLING_PENDING plan ${plan.id} threw; keeping BILLING_PENDING for retry: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return this._toRecord(plan);
    }
    if (!billed) {
      // No BillingRecord for this plan (or its costItems failed to parse): there is
      // nothing to confirm or re-deduct, so the plan cannot advance on its own.
      // Surface it rather than stalling mutely.
      this.logger.warn(
        `Reconcile of BILLING_PENDING plan ${plan.id} found no billable record; keeping BILLING_PENDING`
      );
      return this._toRecord(plan);
    }
    if (!billed.deduction.success && !billed.deduction.skipped) {
      this.logger.error(
        `Credit deduction rejected on reconcile for plan ${plan.id}: ${billed.deduction.error ?? 'no reason given'}`
      );
      return this._toRecord(await this._repo.updateStatus(plan.id, {
        status: 'BILLING_FAILED',
        errorCode: 'CREDIT_DEDUCTION_FAILED',
        errorMessage: OperationPlanService.billingFailureReason(billed.deduction.error),
      }));
    }
    const creditAmount = billed.costItems.reduce(
      (sum, item) => sum + Number(item.amount),
      0
    ).toFixed(6);
    const readyPlan = await this._repo.updateStatus(plan.id, {
      status: 'READY',
      billingTransactionId: billed.deduction.transactionId ?? null,
      creditAmount,
      errorCode: null,
      errorMessage: null,
    });
    await this._materializePlanPosts(readyPlan, readyPlan.planPayload);
    return this._toRecord(readyPlan);
  }

  // Learned per-day rate behind the progress estimate, cached in memory for
  // OPERATION_PLAN_PROGRESS_CACHE_TTL_MS to keep getOverview polling off the
  // Settings table. Falls back to the hardcoded default when there is no
  // Settings row yet (fresh install, before the first generation reports in)
  // or the read fails for any reason.
  private async _getProgressMsPerDay(): Promise<number> {
    const now = Date.now();
    if (
      this._progressMsPerDayCache &&
      now - this._progressMsPerDayCache.loadedAt < OPERATION_PLAN_PROGRESS_CACHE_TTL_MS
    ) {
      return this._progressMsPerDayCache.value;
    }
    let value = OPERATION_PLAN_PROGRESS_PER_DAY_MS_DEFAULT;
    try {
      value =
        (await this._settingsService?.get<number>(OPERATION_PLAN_PROGRESS_MS_PER_DAY_KEY)) ??
        value;
    } catch (err) {
      this.logger.warn(
        `Failed to read ${OPERATION_PLAN_PROGRESS_MS_PER_DAY_KEY}, using default: ${
          err instanceof Error ? err.message : err
        }`
      );
    }
    this._progressMsPerDayCache = { value, loadedAt: now };
    return value;
  }

  // Feeds one successful generation's actual (completeGeneration - createdAt) /
  // durationDays back into the learned per-day rate via an exponential moving
  // average, so the estimate tracks real drift (model gets slower/faster,
  // typical plan size changes) instead of staying pinned to a value tuned
  // once. Called fire-and-forget right after the GENERATING → BILLING_PENDING
  // transition — this is a cosmetic estimate, never worth blocking or
  // failing a paid generation over.
  private async _recordObservedGenerationDuration(
    actualDurationMs: number,
    totalDays: number
  ): Promise<void> {
    if (!this._settingsService || totalDays <= 0) return;
    const observedMsPerDay = actualDurationMs / totalDays;
    try {
      const current = await this._getProgressMsPerDay();
      const next = Math.round(
        current + OPERATION_PLAN_PROGRESS_EMA_ALPHA * (observedMsPerDay - current)
      );
      await this._settingsService.set(OPERATION_PLAN_PROGRESS_MS_PER_DAY_KEY, next, {
        type: 'number',
        defaultValue: OPERATION_PLAN_PROGRESS_PER_DAY_MS_DEFAULT,
      });
      this._progressMsPerDayCache = { value: next, loadedAt: Date.now() };
    } catch (err) {
      this.logger.warn(
        `Failed to update ${OPERATION_PLAN_PROGRESS_MS_PER_DAY_KEY}: ${
          err instanceof Error ? err.message : err
        }`
      );
    }
  }

  // Rough, non-authoritative progress estimate for a GENERATING plan. There is
  // no real per-day completion signal (generation is one monolithic LLM call —
  // see _generatePlanArtifacts), so this interpolates elapsed wall time
  // against a day-count-scaled expected duration (the per-day rate is
  // learned — see _getProgressMsPerDay). Good enough for a "day N of M"
  // progress indicator; not a guarantee that day N is actually done. Returns
  // null once the plan has left GENERATING (nothing left to estimate).
  private async _estimateGenerationProgress(
    plan: OperationPlan
  ): Promise<{ totalDays: number; estimatedCompletedDays: number; percent: number } | null> {
    if (plan.status !== 'GENERATING') {
      return null;
    }
    const totalDays =
      dayjs.utc(plan.endsAt).startOf('day').diff(dayjs.utc(plan.startsAt).startOf('day'), 'day') + 1;
    const msPerDay = await this._getProgressMsPerDay();
    const expectedMs = OPERATION_PLAN_PROGRESS_BASE_MS + msPerDay * totalDays;
    const elapsedMs = Date.now() - plan.createdAt.getTime();
    const ratio = Math.min(
      Math.max(elapsedMs / expectedMs, 0),
      OPERATION_PLAN_PROGRESS_MAX_RATIO
    );
    return {
      totalDays,
      estimatedCompletedDays: Math.min(totalDays - 1, Math.floor(ratio * totalDays)),
      percent: Math.round(ratio * 100),
    };
  }

  /**
   * The project's currently-active plan id, if any (READY, startsAt<=now<=
   * endsAt — same definition getActivePlan / the engage reply pacing gate
   * already use, so "active" never means two different things depending on
   * which caller asks). Minimal by design: a caller that needs the full
   * detail (posts, engage stats) follows up with GET /operation-plans/:id —
   * this exists so a client doesn't have to invent its OWN notion of "which
   * plan is active" (e.g. a client-side cache keyed by a DIFFERENT flow) to
   * get that id in the first place.
   */
  async getActivePlanId(
    organizationId: string,
    projectId: string
  ): Promise<{ id: string | null }> {
    const plan = await this._repo.getActivePlan(
      organizationId,
      projectId,
      new Date()
    );
    return { id: plan?.id ?? null };
  }

  async getOverview(organizationId: string, planId: string) {
    const plan = await this._repo.getById(planId, organizationId);
    const [posts, engageStats, engageView, progress] = await Promise.all([
      this._repo.getPostsForPlan(plan.id, organizationId),
      this._getReplyPacingByDay(plan),
      this._getEngagePoliciesView(plan),
      this._estimateGenerationProgress(plan),
    ]);

    return {
      // Keep the polling status at the response top level, matching the create
      // endpoint, while preserving the existing plan.status field.
      status: plan.status,
      // Only meaningful (non-null) while status === 'GENERATING'; see
      // _estimateGenerationProgress for why it's an estimate, not a fact.
      progress,
      // Why a FAILED / BILLING_FAILED plan ended where it did. `errorCode` is
      // the stable machine value to branch on; `errorMessage` is the specific
      // reason to show the user (null on every non-failed status). Mirrored at
      // the top level next to `status` because that is what the page polls.
      errorCode: plan.errorCode ?? null,
      errorMessage: plan.errorMessage ?? null,
      plan: {
        id: plan.id,
        projectId: plan.projectId,
        taskId: plan.taskId,
        campaignId: plan.campaignId,
        platforms: plan.platforms,
        status: plan.status,
        startsAt: plan.startsAt,
        endsAt: plan.endsAt,
        data: plan.data ?? null,
      },
      // getPostsForPlan returns every part flat (anchor + thread follow-ups as
      // separate rows). Nest each thread under its anchor so the overview shows
      // one entry per content item, its follow-ups carried in `thread`.
      posts: this._nestThreadPosts(posts),
      engageStats,
      // The plan's engagement targets, with keywordTargets keyed by keyword TEXT
      // (not the internal keyword id persisted in planPayload) plus a flat list
      // of the keyword texts referenced by those policies.
      engagePolicies: engageView.engagePolicies,
      engageKeywords: engageView.engageKeywords,
    };
  }

  // Rebuild the flat post list into anchor posts each carrying their thread
  // follow-ups in `thread`. materializePlanPosts links a thread as a chain
  // (anchor <- part0 <- part1 …), all parts sharing the anchor's group; we walk
  // that parentPostId chain to nest the follow-ups in publish order. A part
  // whose parent is absent from the set (e.g. the anchor was soft-deleted) is
  // treated as its own anchor so it is never dropped from the overview.
  private _nestThreadPosts<T extends { id: string; parentPostId: string | null }>(
    posts: T[]
  ): (T & { thread: T[] })[] {
    const ids = new Set(posts.map((p) => p.id));
    const childrenByParent = new Map<string, T[]>();
    for (const post of posts) {
      if (!post.parentPostId || !ids.has(post.parentPostId)) continue;
      const siblings = childrenByParent.get(post.parentPostId);
      if (siblings) siblings.push(post);
      else childrenByParent.set(post.parentPostId, [post]);
    }

    const collectThread = (anchorId: string): T[] => {
      const thread: T[] = [];
      const queue = [...(childrenByParent.get(anchorId) ?? [])];
      while (queue.length) {
        const node = queue.shift()!;
        thread.push(node);
        const kids = childrenByParent.get(node.id);
        if (kids) queue.push(...kids);
      }
      return thread;
    };

    return posts
      .filter((post) => !post.parentPostId || !ids.has(post.parentPostId))
      .map((anchor) => ({ ...anchor, thread: collectThread(anchor.id) }));
  }

  async reconcileBillingPending(limit = 50): Promise<void> {
    if (!this._creditService) return;
    const plans = await this._repo.findBillingPending(limit);
    await Promise.allSettled(plans.map((plan) => this._reconcilePending(plan)));
  }

  // Re-drive GENERATING rows whose background job never finished (worker crash,
  // interrupted deploy). Called on an interval by the generation sweeper. Each
  // row is re-run through _generateAndBill, which is idempotent on the plan id,
  // so a row that merely finished slowly is not double-billed (its billing task
  // key `operation_plan:${id}` dedupes remotely).
  async resumeStuckGenerations(olderThanMs = 600_000, limit = 20): Promise<void> {
    if (!this._aiseeClient || !this._creditService || !this._settingsService || !this._openaiService) {
      return;
    }
    const plans = await this._repo.findStuckGenerating(olderThanMs, limit);
    await Promise.allSettled(plans.map((plan) => this._resumeGeneration(plan)));
  }

  // Rebuild the generation context for a stuck row from its persisted fields and
  // the source task, then re-run the background job. The original curated
  // `input.keywords` is not stored, so effectiveKeywords is recomputed from the
  // task (analyzer → snapshot) — the same fallback a request without curated
  // keywords would take.
  private async _resumeGeneration(plan: OperationPlan): Promise<void> {
    const taskLookup = await this._aiseeClient!.getTaskDetail(plan.taskId);
    if ('reason' in taskLookup) {
      // Source task gone or the analysis service is down; leave the row for a
      // later tick (or manual triage) rather than failing it on a transient miss.
      this.logger.warn(
        `Skipping stuck operation plan ${plan.id}: task ${plan.taskId} lookup returned ${taskLookup.reason}`
      );
      return;
    }
    const task = taskLookup.task;
    const durationDays =
      dayjs.utc(plan.endsAt).startOf('day').diff(dayjs.utc(plan.startsAt).startOf('day'), 'day') + 1;
    const ctx: PlanGenerationContext = {
      start: plan.startsAt,
      end: plan.endsAt,
      durationDays,
      platforms: plan.platforms,
      task,
      baselineScore: this._extractBaselineScore(task.result),
      effectiveKeywords: this._resolveEffectiveKeywords(task),
      platformPlaybook: await this._buildPlatformPlaybook(plan.platforms),
      maxThreadParts: await this._resolveMaxThreadParts(),
    };
    await this._generateAndBill(
      plan.id,
      plan.organizationId,
      plan.projectId,
      {
        taskId: plan.taskId,
        startAt: plan.startsAt.toISOString(),
        endAt: plan.endsAt.toISOString(),
        platforms: plan.platforms,
      },
      ctx
    );
  }

  private async _getReplyPacingByDay(plan: OperationPlan): Promise<ReplyPacingByDay> {
    const payload = plan.planPayload as { engagePolicies?: EngagePolicy[] } | null;
    const enabledPolicies = (
      Array.isArray(payload?.engagePolicies) ? payload!.engagePolicies : []
    ).filter(
      (p) => p?.enabled && p.keywordTargets && Object.keys(p.keywordTargets).length
    );
    if (!enabledPolicies.length) return {};

    // Resolve every keywordId (across all platform policies) to its text once.
    // matchedKeywords on EngageSentReply stores keyword TEXT, not id — see
    // schema.prisma's EngageOpportunityState.matchedKeywords comment.
    const allKeywordIds = [
      ...new Set(enabledPolicies.flatMap((p) => Object.keys(p.keywordTargets ?? {}))),
    ];
    const keywordRows = await this._repo.resolveKeywordTexts(allKeywordIds);
    const textById = new Map(keywordRows.map((k) => [k.id, k.keyword]));

    // Per-platform target lists. Drop any keywordId that no longer resolves
    // (keyword deleted since the plan was generated) rather than leaking a raw
    // uuid to the frontend; drop a platform entirely if none of its keywords
    // survive.
    type Target = { keywordId: string; keyword: string; targetReplies: number };
    const platformPolicies = enabledPolicies
      .map((policy) => {
        const targets: Target[] = Object.entries(policy.keywordTargets ?? {})
          .map(([keywordId, count]) => {
            const keyword = textById.get(keywordId);
            const targetReplies = Number(count);
            return keyword && Number.isFinite(targetReplies)
              ? { keywordId, keyword, targetReplies }
              : null;
          })
          .filter((t): t is Target => t !== null);
        return {
          platform: policy.platform,
          themeTitle: policy.themeTitle?.trim() || undefined,
          targets,
          targetRepliesPerDay: policy.targetRepliesPerDay,
          // Indexed for the per-day lookup below; a 0 override is meaningful,
          // so resolve by presence rather than truthiness.
          dailyTargetByDate: new Map(
            (policy.dailyTargets ?? [])
              .filter((d) => typeof d?.date === 'string' && typeof d?.target === 'number')
              .map((d) => [d.date, d.target])
          ),
        };
      })
      .filter((p) => p.targets.length);
    if (!platformPolicies.length) return {};

    const replies = await this._repo.getSentRepliesInRange(
      plan.organizationId,
      plan.projectId,
      plan.startsAt,
      plan.endsAt
    );

    const days: string[] = [];
    for (
      let d = dayjs.utc(plan.startsAt).startOf('day');
      !d.isAfter(plan.endsAt);
      d = d.add(1, 'day')
    ) {
      days.push(d.format('YYYY-MM-DD'));
    }

    // Pre-seed every (day, platform, keyword) triple at 0 so the frontend gets
    // a complete grid instead of sparse/missing entries.
    const actualByDay = new Map<string, Map<string, Map<string, number>>>(
      days.map((day) => [
        day,
        new Map(
          platformPolicies.map((pp) => [
            pp.platform,
            new Map(pp.targets.map((t) => [t.keyword, 0])),
          ])
        ),
      ])
    );
    // Platform-level distinct reply count per (day, platform) — the same unit as
    // targetRepliesPerDay ("one reply = one") and the same scope as the send-time
    // daily-target gate (countProjectSentRepliesToday: every reply on the
    // platform counts, keyword-independent). The per-keyword counts below CANNOT
    // be summed into this: they count per (reply × matched keyword).
    const replyCountByDay = new Map<string, Map<string, number>>(
      days.map((day) => [
        day,
        new Map(platformPolicies.map((pp) => [pp.platform, 0])),
      ])
    );
    for (const reply of replies) {
      const day = dayjs.utc(reply.post.publishDate).format('YYYY-MM-DD');
      const platform = reply.opportunity?.platform;
      if (!platform) continue;
      const byPlatformCount = replyCountByDay.get(day);
      if (byPlatformCount?.has(platform)) {
        byPlatformCount.set(platform, byPlatformCount.get(platform)! + 1);
      }
      const counts = actualByDay.get(day)?.get(platform);
      if (!counts) continue; // outside the range, or a platform with no policy
      for (const keyword of reply.matchedKeywords) {
        if (counts.has(keyword)) counts.set(keyword, counts.get(keyword)! + 1);
      }
    }

    const result: ReplyPacingByDay = {};
    for (const day of days) {
      const byPlatform = actualByDay.get(day)!;
      const byPlatformCount = replyCountByDay.get(day)!;
      result[day] = platformPolicies.map((pp) => {
        const counts = byPlatform.get(pp.platform)!;
        return {
          platform: pp.platform,
          themeTitle: pp.themeTitle,
          targetRepliesPerDay: pp.dailyTargetByDate.has(day)
            ? pp.dailyTargetByDate.get(day)
            : pp.targetRepliesPerDay,
          actualReplies: byPlatformCount.get(pp.platform) ?? 0,
          keywords: pp.targets.map((t) => ({
            keywordId: t.keywordId,
            keyword: t.keyword,
            actualReplies: counts.get(t.keyword) ?? 0,
            targetReplies: t.targetReplies,
          })),
        };
      });
    }
    return result;
  }

  // The plan's engagePolicies as persisted, but with each policy's keywordTargets
  // re-keyed from the internal keyword id to the keyword TEXT — the raw ids in
  // planPayload are meaningless to API consumers. Any id that no longer resolves
  // (keyword deleted since generation) is dropped rather than leaked as a bare
  // uuid. Also returns a flat list of the referenced keyword texts.
  private async _getEngagePoliciesView(plan: OperationPlan): Promise<{
    engagePolicies: Array<{
      platform: string;
      themeTitle?: string;
      targetRepliesPerDay?: number;
      dailyTargets?: Array<{ date: string; target: number }>;
      keywordTargets: Record<string, number>;
      enabled: boolean;
    }>;
    engageKeywords: string[];
  }> {
    const payload = plan.planPayload as { engagePolicies?: EngagePolicy[] } | null;
    const policies = Array.isArray(payload?.engagePolicies)
      ? payload!.engagePolicies
      : [];
    if (!policies.length) return { engagePolicies: [], engageKeywords: [] };

    const allKeywordIds = [
      ...new Set(policies.flatMap((p) => Object.keys(p.keywordTargets ?? {}))),
    ];
    const keywordRows = await this._repo.resolveKeywordTexts(allKeywordIds);
    const textById = new Map(keywordRows.map((k) => [k.id, k.keyword]));

    const engagePolicies = policies.map((p) => {
      const keywordTargets: Record<string, number> = {};
      for (const [keywordId, count] of Object.entries(p.keywordTargets ?? {})) {
        const keyword = textById.get(keywordId);
        const target = Number(count);
        if (keyword && Number.isFinite(target)) keywordTargets[keyword] = target;
      }
      return {
        platform: p.platform,
        themeTitle: p.themeTitle?.trim() || undefined,
        targetRepliesPerDay: p.targetRepliesPerDay,
        dailyTargets: p.dailyTargets,
        keywordTargets,
        enabled: !!p.enabled,
      };
    });

    return {
      engagePolicies,
      engageKeywords: keywordRows.map((k) => k.keyword),
    };
  }
}

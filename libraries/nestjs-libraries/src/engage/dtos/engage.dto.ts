import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { OmitType, PickType } from '@nestjs/swagger';
import { EngageOpportunityStatus } from '@prisma/client';

// @IsIn rejects values missing here at the controller boundary (400) before
// either generator service sees them. Two prompt maps key off this list:
// STRATEGY_PROMPTS (engage-draft.service.ts, reply wording) and
// REFERENCE_POST_STRATEGY_PROMPTS (engage-reference-post.service.ts, original-
// post wording — see reference-post-generation.md §6 on why the text differs).
// Exported so the latter can type itself as Record<VALID_STRATEGIES[number],
// string>, making "added a strategy but not its prompt" a compile error there
// rather than a silent EXPERT_ANSWER fallback at runtime.
export const VALID_STRATEGIES = [
  'EXPERT_ANSWER',
  'DATA_BACKED',
  'EMPATHY_LED',
  'CONTRARIAN',
  'QUESTION_LED',
  'QUICK_TAKE',
  'AMPLIFY',
] as const;

// Keyword types must match the literals the scorer strict-equals (engage-scorer.ts
// computeKeywordScore). Without this enum, lowercase / mis-cased values silently
// store but never receive the +5/+3 brand/competitor bonus.
export const KEYWORD_TYPES = ['CORE', 'BRAND', 'COMPETITOR'] as const;
export type KeywordType = (typeof KEYWORD_TYPES)[number] | null;

// Shared by ListSentDto and LocateSentReplyDto so /sent and /sent/locate accept
// the exact same status vocabulary. Four granular states (published/scheduled/
// manual/error) + 'draft' (raw Post.state=DRAFT, expired or not) + two top-level
// rollups (settled/awaiting), plus three 'awaiting' sub-filters that back the
// Awaiting-review tabs: awaiting-draft (still-actionable DRAFT), awaiting-expired
// (DRAFT whose opportunity aged out — EngageOpportunityState.status=EXPIRED for
// this org), and awaiting-link (manual link-pending OR failed publish — both need
// the user to act before the reply counts as sent).
export const SENT_STATUS_VALUES = [
  'published',
  'scheduled',
  'manual',
  'error',
  'draft',
  'settled',
  'awaiting',
  'awaiting-draft',
  'awaiting-expired',
  'awaiting-link',
] as const;

// ─── Config ───────────────────────────────────────────────────────────────────

export class SaveEngageConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /**
   * Unattended reply mode for this project's Engage.
   *   'off'    — the plan's daily reply targets stay a send-time CEILING on
   *              replies a user initiates (the behaviour before this existed).
   * On, the backend drafts up to the day's budget and the browser extension
   * sends them unattended.
   *
   * Replaces the tri-state `autoReplyMode`, whose third value `review` parked
   * drafts for a human to send. That mode is retired: managed replying always
   * sends, and no client ever set anything but `review`, which made the enum a
   * boolean in disguise. Stored rows carrying the old key are still read
   * correctly — see `readEngageConfigMetadata`.
   *
   * Requires a projectId: the driver only reads project-scoped configs, so a
   * switch set on the legacy null-project row would be silently inert.
   */
  @IsOptional()
  @IsBoolean()
  autoReplyEnabled?: boolean;

  /**
   * Per-PLATFORM reply policy, keyed by platform:
   *   { "reddit": { autoReplyEnabled, windowStart, windowEnd, timezone,
   *                 defaultStrategy } }
   * Refines autoReplyEnabled (which decides WHETHER this project replies at all)
   * with WHERE and WHEN. Replaces the key wholesale — send the full map.
   */
  @IsOptional()
  @IsObject()
  replyPolicies?: Record<string, unknown>;

  // Opaque aisee-core products.id. Omit for the legacy, single (null-project)
  // config (project-scoped-post-engage-design.md §8/§11).
  @IsOptional()
  @IsString()
  projectId?: string;
}

export class SetupEngageDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AddKeywordDto)
  keywords: AddKeywordDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AddMonitoredChannelDto)
  monitoredChannels?: AddMonitoredChannelDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AddTrackedAccountDto)
  trackedAccounts?: AddTrackedAccountDto[];

  @IsOptional()
  @IsString()
  projectId?: string;
}

// ─── Keywords ─────────────────────────────────────────────────────────────────

export class AddKeywordDto {
  // Trim + collapse internal whitespace at the boundary so the stored keyword is
  // canonical. The global scan unit key normalises the same way
  // (normalizeKeyword), and getOrgContextsForUnit's SQL `equals insensitive`
  // pre-filter runs against the RAW stored value — a padded/double-spaced
  // keyword (" AI ", "machine  learning") would otherwise never match its own
  // normalised unit key and the subscribing org would be silently dropped from
  // fan-out. Case is preserved for display (the SQL match is case-insensitive).
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  keyword: string;

  @IsOptional()
  @IsIn(KEYWORD_TYPES)
  @Transform(({ value }) => value === '' ? undefined : value)
  type?: KeywordType;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  // Only meaningful on the standalone POST /keywords call — SetupEngageDto/
  // AddKeywordsBulkDto read projectId from their OWN top level, not from
  // each nested keyword item.
  @IsOptional()
  @IsString()
  projectId?: string;
}

export class UpdateKeywordDto {
  @IsOptional()
  @IsIn([...KEYWORD_TYPES, null])
  type?: KeywordType;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class AddKeywordsBulkDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AddKeywordDto)
  keywords: AddKeywordDto[];

  @IsOptional()
  @IsString()
  projectId?: string;
}

// ─── Monitored Channels ───────────────────────────────────────────────────────

export class AddMonitoredChannelDto {
  // A monitored channel is a CHANNEL-scope scan target, and reddit is the only
  // platform with a channel scope (CHANNEL_SCOPE_PLATFORMS in
  // engage-scan-target.ts). This used to be a free-form @IsString() documented
  // as 'reddit' | 'youtube' | 'qq' | 'discord', which let a caller store a row
  // no scanner could serve — and, after the scan-target merge, one whose key
  // reached the shared X `from:` query. Enumerated here so the rejection is a
  // validation error at the boundary rather than a 400 from deep inside the
  // repository. Widen this the day another platform gains a channel scanner.
  @IsIn(['reddit'])
  platform: string;

  // Bare community name. `r/` prefixes and casing are normalised server-side
  // (buildScanTargetKey); the stored value is the canonical scan-unit key.
  @IsString()
  @MaxLength(64)
  channelId: string;

  @IsString()
  @MaxLength(128)
  channelName: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  audienceSize?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  metadata?: Record<string, unknown>;

  // Only meaningful on the standalone POST /monitored-channels call.
  @IsOptional()
  @IsString()
  projectId?: string;
}

// Label only — no flair template id. Nothing that observes a subreddit's
// picker can see one (see RedditFlairOption), so a modelled `id` would be a
// field no client could ever populate.
export class RedditFlairOptionDto {
  @IsString()
  @MaxLength(128)
  label: string;
}

/**
 * One observation of what a subreddit requires of a post, reported by the
 * browser extension after a publish attempt.
 *
 * Every field is scraped from Reddit's own submit page, so the lengths and the
 * array size are enforced HERE rather than trusted downstream: this is the only
 * boundary between a DOM read in someone's browser and a Json column.
 *
 * Omitting a boolean means "this attempt did not observe it" — it is NOT a
 * claim of false, and the merge preserves whatever was previously learned (see
 * mergeRedditCapability).
 */
export class ReportRedditChannelCapabilityDto {
  // Bare community name; `r/` prefixes and casing are normalised server-side.
  @IsString()
  @MaxLength(64)
  subreddit: string;

  // A SNAPSHOT of the subreddit's flair picker — it replaces the stored list
  // rather than merging into it, so a partial read must not be sent.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RedditFlairOptionDto)
  flairs?: RedditFlairOptionDto[];

  @IsOptional()
  @IsBoolean()
  flairRequired?: boolean;

  @IsOptional()
  @IsBoolean()
  titleTagRequired?: boolean;
}

export class UpdateMonitoredChannelDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  channelName?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  audienceSize?: number;
}

export class SearchChannelsDto {
  @IsString()
  platform: string;

  @IsString()
  @MinLength(1)
  query: string;
}

// ─── Tracked Accounts (追踪账号 — external, no OAuth) ─────────────────────────

export class AddTrackedAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  username: string; // external X @username (no @ prefix)

  @IsOptional()
  @IsString()
  platform?: string; // default 'x'

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  picture?: string; // profile avatar URL (usually backfilled during scan)

  @IsOptional()
  @IsString()
  @MaxLength(100)
  categoryLabel?: string; // e.g. 'GEO专家'

  @IsOptional()
  @IsBoolean()
  enabled?: boolean; // default true (Prisma schema default)

  // Only meaningful on the standalone POST /tracked-accounts call.
  @IsOptional()
  @IsString()
  projectId?: string;
}

export class UpdateTrackedAccountDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  picture?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  categoryLabel?: string;
}

// ─── Reply Accounts (回复账号 — our own Integration accounts) ─────────────────
//
// Per-account auto-reply time window / default strategy moved to
// EngageConfig.replyPolicies (per-platform, via SaveEngageConfigDto) — this DTO
// only still owns whether the account may reply at all.

export class UpdateReplyAccountDto {
  @IsOptional()
  @IsBoolean()
  engageEnabled?: boolean;

  // Required in practice: engage.service.upsertReplyAccountSettings writes
  // IntegrationProject (integration, project), which has no legacy
  // null-project fallback to write to instead.
  @IsOptional()
  @IsString()
  projectId?: string;
}

// ─── Opportunities ────────────────────────────────────────────────────────────

export class ListOpportunitiesDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  // Multi-value: repeated params (?platform=x&platform=y) or comma-separated (?platform=x,y)
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null
      ? value
      : (Array.isArray(value) ? value : [value])
          .flatMap((v) => String(v).split(','))
          .map((v) => v.trim())
          .filter((v) => v !== '')
  )
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  platform?: string[];

  // Multi-value: repeated params or comma-separated
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null
      ? value
      : (Array.isArray(value) ? value : [value])
          .flatMap((v) => String(v).split(','))
          .map((v) => v.trim())
          .filter((v) => v !== '')
  )
  @IsArray()
  @ArrayMaxSize(20)
  @IsEnum(EngageOpportunityStatus, { each: true })
  status?: EngageOpportunityStatus[];

  // Multi-value: repeated params or comma-separated
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null
      ? value
      : (Array.isArray(value) ? value : [value])
          .flatMap((v) => String(v).split(','))
          .map((v) => v.trim())
          .filter((v) => v !== '')
  )
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  intent?: string[];

  // Restrict to opportunities that matched this exact keyword (text, as the org
  // configured it). Backed by EngageOpportunityState.matchedKeywords — strictly
  // within this org's keyword scope.
  @IsOptional()
  @IsString()
  keyword?: string;

  // Multi-keyword variant of `keyword`: keep opportunities that matched ANY of
  // these exact keywords (OR). Same per-org scope as `keyword`, backed by
  // EngageOpportunityState.matchedKeywords. Accepts BOTH forms (and a mix):
  //   repeated params  ?keywords=a&keywords=b
  //   comma-separated  ?keywords=a,b
  // Each value is split on commas and trimmed; empties are dropped. A keyword
  // that legitimately contains a comma must use the repeated-param form.
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null
      ? value
      : (Array.isArray(value) ? value : [value])
          .flatMap((v) => String(v).split(','))
          .map((v) => v.trim())
          .filter((v) => v !== '')
  )
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  keywords?: string[];

  @IsOptional()
  @IsString()
  @IsIn(['today', 'week'])
  date?: 'today' | 'week';

  // Exact lower bound on postPublishedAt (an instant, not a calendar preset).
  // Takes priority over `date` when both are given — use this for rolling
  // windows (e.g. "last 24h") that need hour precision `date` can't express.
  @IsOptional()
  @IsDateString()
  startDate?: string;

  // Exact upper bound on postPublishedAt, applied as-is with no rounding:
  // pass a full timestamp for a precise cutoff, or a bare date for its UTC
  // midnight. Combines with `date`/`startDate` to form a window.
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minScore?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minScoreKeyword?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minScoreHeat?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minScoreAuthority?: number;

  // Channel filter. Multi-value: repeated params or comma-separated.
  // Omit or leave empty for no filter; specific values = those channel ids (e.g. ["SEO", "TECH"]).
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null
      ? value
      : (Array.isArray(value) ? value : [value])
          .flatMap((v) => String(v).split(','))
          .map((v) => v.trim())
          .filter((v) => v !== '')
  )
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  channels?: string[];

  // Author filter. Multi-value: repeated params or comma-separated.
  // Omit or leave empty for no filter; specific values = those author usernames.
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null
      ? value
      : (Array.isArray(value) ? value : [value])
          .flatMap((v) => String(v).split(','))
          .map((v) => v.trim())
          .filter((v) => v !== '')
  )
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  authors?: string[];

  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value
  )
  @IsBoolean()
  bookmarked?: boolean;

  @IsOptional()
  @IsString()
  sortBy?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

// Filter contract for GET /opportunities/counts/summary: ListOpportunitiesDto's
// scoping (channels/authors/keyword(s)/date window/minScore*/intent/bookmarked)
// minus `status`/`platform` — the summary is a pure rollup where those two are
// the breakdown axes, not filters (narrowing by them belongs to
// GET /opportunities/count, which takes the full /opportunities contract) —
// and minus `sortBy`/`sortOrder`/`page`/`limit` (a counts response has no rows
// to sort or paginate).
// Derived via OmitType rather than hand-duplicated so a new filter added to
// ListOpportunitiesDto is inherited here automatically instead of silently
// missing from the summary endpoint.
export class OpportunityCountsSummaryDto extends OmitType(ListOpportunitiesDto, [
  'status',
  'platform',
  'sortBy',
  'sortOrder',
  'page',
  'limit',
] as const) {}

export class LocateOpportunityDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsString()
  opportunityId!: string;

  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null
      ? value
      : (Array.isArray(value) ? value : [value])
          .flatMap((v) => String(v).split(','))
          .map((v) => v.trim())
          .filter((v) => v !== '')
  )
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  platform?: string[];

  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null
      ? value
      : (Array.isArray(value) ? value : [value])
          .flatMap((v) => String(v).split(','))
          .map((v) => v.trim())
          .filter((v) => v !== '')
  )
  @IsArray()
  @ArrayMaxSize(20)
  @IsEnum(EngageOpportunityStatus, { each: true })
  status?: EngageOpportunityStatus[];

  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null
      ? value
      : (Array.isArray(value) ? value : [value])
          .flatMap((v) => String(v).split(','))
          .map((v) => v.trim())
          .filter((v) => v !== '')
  )
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  intent?: string[];

  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null
      ? value
      : (Array.isArray(value) ? value : [value])
          .flatMap((v) => String(v).split(','))
          .map((v) => v.trim())
          .filter((v) => v !== '')
  )
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  keywords?: string[];

  @IsOptional()
  @IsString()
  @IsIn(['today', 'week'])
  date?: 'today' | 'week';

  // Exact lower bound on postPublishedAt (an instant, not a calendar preset).
  // Takes priority over `date` when both are given — use this for rolling
  // windows (e.g. "last 24h") that need hour precision `date` can't express.
  @IsOptional()
  @IsDateString()
  startDate?: string;

  // Exact upper bound on postPublishedAt, applied as-is with no rounding:
  // pass a full timestamp for a precise cutoff, or a bare date for its UTC
  // midnight. Combines with `date`/`startDate` to form a window.
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minScore?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minScoreKeyword?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minScoreHeat?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minScoreAuthority?: number;

  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null
      ? value
      : (Array.isArray(value) ? value : [value])
          .flatMap((v) => String(v).split(','))
          .map((v) => v.trim())
          .filter((v) => v !== '')
  )
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  channels?: string[];

  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null
      ? value
      : (Array.isArray(value) ? value : [value])
          .flatMap((v) => String(v).split(','))
          .map((v) => v.trim())
          .filter((v) => v !== '')
  )
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  authors?: string[];

  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value
  )
  @IsBoolean()
  bookmarked?: boolean;

  @IsOptional()
  @IsString()
  sortBy?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class LocateSentReplyDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsString()
  sentReplyId!: string;

  @IsOptional()
  @IsString()
  platform?: string;

  @IsOptional()
  @IsString()
  @IsIn(SENT_STATUS_VALUES)
  status?: string;

  @IsOptional()
  @IsString()
  date?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ScoreStatsDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  @IsIn(['today', 'week', 'month'])
  date?: 'today' | 'week' | 'month';

  @IsOptional()
  @IsString()
  platform?: string;
}

// ─── Sent ─────────────────────────────────────────────────────────────────────

export class ListSentDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  platform?: string;

  // Two combined "rollup" values complement the four granular states:
  //   'settled'  = no further action needed: published (live) OR scheduled (will
  //                auto-fire). = published (PUBLISHED + releaseURL) OR QUEUE.
  //   'awaiting' = needs user action / generated but not yet live: a saved DRAFT,
  //                manual link-pending (PUBLISHED + no releaseURL), OR a failed
  //                publish (ERROR). Folds in the former GET /engage/awaiting-review
  //                endpoint.
  // Three more sub-filters of 'awaiting' back the Awaiting-review tabs (All /
  // Drafts / Awaiting link / Expired):
  //   'awaiting-draft'   = DRAFT, opportunity still actionable for this org.
  //   'awaiting-expired' = DRAFT, opportunity's EngageOpportunityState.status for
  //                        this org is EXPIRED (aged out — read-only).
  //   'awaiting-link'    = manual link-pending OR failed publish (the two states
  //                        that need the user to act, minus DRAFT).
  @IsOptional()
  @IsString()
  @IsIn(SENT_STATUS_VALUES)
  status?: string;

  // Date window: all (default/empty) | day | today | week | month. Untyped (no
  // @IsIn) so it accepts the same vocabulary as /dashboard/summary; the repository
  // maps it via the shared _engageDateWindow (unknown values → all-time).
  @IsOptional()
  @IsString()
  date?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

// Filter contract for GET /sent/counts/summary: ListSentDto's scoping minus
// `status`/`platform` — the summary is a pure rollup where those two are the
// breakdown axes, not filters (narrowing by them belongs to GET /sent/count,
// which takes the full /sent contract) — and minus pagination (a counts
// response has no rows to paginate).
export class SentCountsSummaryDto extends PickType(ListSentDto, [
  'projectId',
  'date',
] as const) {}

// Event-driven metrics refresh: the client posts the exact post ids it is
// currently showing on /engage/sent (any sort/filter/page). The server gates
// each by the per-plan metrics interval and refreshes only the due ones. Capped
// at 100 ids — one page is far smaller, and the service hard-caps regardless.
export class RefreshMetricsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  postIds: string[];
}

// Extension-sourced metrics for ONE published reply. The browser extension
// scrapes the reply's own page (X TweetDetail / Reddit comment .json) and posts
// the raw public counters here; the server computes impressions/traffic and
// persists them. Only the platform's own counter set is sent — unknown fields
// are ignored, missing ones default to 0 server-side.
export class IngestReplyMetricsDto {
  @IsIn(['x', 'reddit'])
  platform: 'x' | 'reddit';

  // X public_metrics
  @IsOptional()
  @IsNumber()
  impressions?: number;

  @IsOptional()
  @IsNumber()
  likes?: number;

  @IsOptional()
  @IsNumber()
  replies?: number;

  @IsOptional()
  @IsNumber()
  retweets?: number;

  @IsOptional()
  @IsNumber()
  quotes?: number;

  @IsOptional()
  @IsNumber()
  bookmarks?: number;

  // Reddit comment counters
  @IsOptional()
  @IsNumber()
  score?: number;

  @IsOptional()
  @IsNumber()
  comments?: number;
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

// Panel ① "Engage Performance" — headline summary stats, optionally scoped to one platform.
export class DashboardSummaryDto {
  // Optional project scope. Omitted = organization-wide (legacy behavior); set =
  // restrict every headline stat to posts/replies attributed to this project.
  @IsOptional()
  @IsString()
  projectId?: string;

  // Optional platform filter (x | reddit). Empty string / omitted = all platforms.
  // No @IsIn so an empty `?platform=` (the "All" toggle) is tolerated rather than
  // rejected — matches ListSentDto / DashboardTrafficsDto. Unknown values simply
  // match nothing in the query.
  @IsOptional()
  @IsString()
  platform?: string;

  // Optional date window: 'all' (default) | 'day' (today) | 'week' (ISO week) |
  // 'month'. Left untyped (no @IsIn) so 'all'/empty is tolerated; unknown values
  // fall through to all-time in the repository.
  @IsOptional()
  @IsString()
  date?: string;
}

// Panel ② "Your Posts" overlay — Engage reply counts bucketed by period.
export class DashboardRepliesTrendDto {
  // Optional project scope; omitted = organization-wide (legacy behavior).
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  @IsIn(['daily', 'weekly', 'monthly'])
  period?: string;
}

// Panel ④ "Engage Impressions Trend" — daily/weekly/monthly impressions by platform
// for engage posts. Response shape matches /dashboard/impressions so the same
// chart component can consume both.
export class DashboardImpressionsDto {
  // Optional project scope; omitted = organization-wide (legacy behavior).
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  @IsIn(['daily', 'weekly', 'monthly'])
  period?: string;
}

// Panel ③ "Traffic from Engage" — per-reply traffic-index breakdown.
export class DashboardTrafficsDto {
  // Optional project scope; omitted = organization-wide (legacy behavior).
  // Reused by both /dashboard/traffics and /dashboard/top-sources.
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  platform?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

// ─── Draft Generation ─────────────────────────────────────────────────────────

export class GenerateDraftDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsString()
  @IsIn(VALID_STRATEGIES)
  strategy: string;

  @IsInt()
  @Min(0)
  @Max(3)
  @Type(() => Number)
  brandStrength: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @ArrayMaxSize(20)
  mentions?: string[];

  @IsOptional()
  @IsInt()
  @Min(2)
  @Type(() => Number)
  outputLength?: number;

  // Reply length tier — the credit-pricing dimension (Short/Medium/Long →
  // base × multiplier). Also drives the generation target when outputLength is
  // not given explicitly. Defaults to 'medium' server-side when omitted.
  @IsOptional()
  @IsString()
  @IsIn(['short', 'medium', 'long'])
  length?: 'short' | 'medium' | 'long';
}

// ─── Reference-Post Generation (docs/engage/reference-post-generation.md) ─────
// Generates AND persists an ORIGINAL post inspired by an opportunity — not a
// reply to it. See engage.controller.ts POST /opportunities/:id/generate-post.
// One call, not a generate-then-save pair: it always saves as an
// account-less DRAFT Post (source='calendar', referenceOpportunityId
// attached). Further editing — content, picking an account, scheduling —
// goes through the existing generic POST /api/posts/ edit flow, same as any
// other draft; there is no separate save-generated-post endpoint.
//
// No integrationId/platform field: the target platform is always the
// opportunity's OWN platform (opportunity.platform), not a client choice —
// simpler than resolving it from an account. Deliberately mirrors
// GenerateDraftDto's shape (same strategy/brandStrength/mentions/outputLength
// vocabulary the reply-draft endpoint already uses) rather than a bespoke
// tone axis, for a consistent creative-control UI across both.

export class GenerateReferencePostDto {
  @IsString()
  @IsIn(VALID_STRATEGIES)
  strategy: string;

  @IsInt()
  @Min(0)
  @Max(3)
  @Type(() => Number)
  brandStrength: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @ArrayMaxSize(20)
  mentions?: string[];

  @IsOptional()
  @IsInt()
  @Min(2)
  @Type(() => Number)
  outputLength?: number;

  @IsOptional()
  @IsString()
  projectId?: string;

  // Opt-in, default false. Unlike the text itself, reused media has no
  // "rewrite it in your own words" mitigation — it's the same file, so this
  // carries a more direct copyright exposure than the generated text does.
  // Defaulting to false means that risk is only taken when a caller
  // explicitly asks for it. See docs/engage/reference-post-generation.md §6.
  @IsOptional()
  @IsBoolean()
  includeReferenceMedia?: boolean;
}

// ─── Reply Sending ────────────────────────────────────────────────────────────

export class SendReplyDto {
  @IsString()
  integrationId: string; // our own X account (reply account)

  @IsString()
  @MaxLength(4000)
  draftContent: string;

  @IsString()
  @IsIn(VALID_STRATEGIES)
  strategy: string;

  @IsInt()
  @Min(0)
  @Max(3)
  @Type(() => Number)
  brandStrength: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @ArrayMaxSize(20)
  mentions?: string[];

  @IsOptional()
  @IsString()
  projectId?: string;
}

export class ScheduleReplyDto extends SendReplyDto {
  @IsDateString()
  scheduledAt: string; // ISO date string (must be a future date)
}

export class BatchSendReplyDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SendReplyDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  items: SendReplyDto[];

  // One project for the whole batch — not read from each item's own
  // (inherited) projectId field.
  @IsOptional()
  @IsString()
  projectId?: string;
}

export class BatchScheduleReplyDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScheduleReplyDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  items: ScheduleReplyDto[];

  @IsOptional()
  @IsString()
  projectId?: string;
}

/**
 * The extension telling the backend that a reply target no longer exists.
 *
 * Everything here is DIAGNOSTIC. The opportunity id in the route is what is
 * acted on; `platform` and `url` are recorded so a report can be traced back to
 * the post it was made about, and `reason` is the poster's own words ("the post
 * was deleted by its author"), which end up on the closed reply's error. None
 * of it is trusted as authorisation — that comes from the caller owning a
 * queued reply against the opportunity.
 */
export class ReportTargetGoneDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  platform?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /**
   * Whether the PLATFORM itself said the address does not resolve (HTTP
   * 404/410), as opposed to the extension inferring it from page text.
   *
   * The one field here that is NOT diagnostic — it selects the blast radius.
   * `EngageOpportunity` is a globally-shared row with no un-retire path, so only
   * a confirmed report may retire it for every tenant; an unconfirmed one closes
   * just the caller's own reply. Page text cannot separate "deleted for
   * everyone" from "invisible to this session" (a protected account, a private
   * community, an author who blocked that one login).
   *
   * Absent means UNCONFIRMED. An older extension sends nothing, and the safe
   * reading of silence is the narrow action, never the global one.
   */
  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}

export class ConfirmManualReplyDto {
  @IsString()
  @MaxLength(4000)
  draftContent: string;

  @IsString()
  @IsIn(VALID_STRATEGIES)
  strategy: string;

  @IsInt()
  @Min(0)
  @Max(3)
  @Type(() => Number)
  brandStrength: number;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  replyUrl?: string;

  // Required for X manual replies: the X integration whose OAuth token the
  // metrics sync uses to read the reply tweet's analytics. Ignored for Reddit.
  @IsOptional()
  @IsString()
  integrationId?: string;

  @IsOptional()
  @IsString()
  projectId?: string;
}

export class EngageAuthorDto {
  @IsString()
  @MaxLength(100)
  handle: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  avatarUrl?: string;
}

export class SubmitManualReplyUrlDto {
  @IsString()
  @MaxLength(2048)
  url: string;

  // The actual poster (e.g. captured by the browser extension from X's
  // CreateTweet response). Stored as Post.settings.engageAuthor.
  @IsOptional()
  @ValidateNested()
  @Type(() => EngageAuthorDto)
  author?: EngageAuthorDto;
}

// Extension publish-on-success callback. Unlike the manual backfill (URL
// mandatory), the extension can confirm a send WITHOUT capturing a permalink
// (e.g. Reddit responded but the comment node couldn't be parsed). The commit
// must still land — flipping the DRAFT to PUBLISHED is what stops the record
// from being re-sendable and duplicating the live reply — so url is optional
// here and the reply is published URL-less (the Sent card then offers the
// manual "submit link" flow).
export class PublishExtensionReplyDto {
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => EngageAuthorDto)
  author?: EngageAuthorDto;
}

// The extension reporting that the platform removed a reply it had just posted
// successfully — verified from a logged-out view (extension utils/liveness/).
export class MarkReplyRemovedDto {
  // 'removed' — the platform left a tombstone where the content was.
  // 'gone'    — not visible to a logged-out reader at all, which can mean an
  //             account-level block rather than one community's rule.
  @IsString()
  @IsIn(['removed', 'gone'])
  reason: string;

  // The reply's own permalink, when the poster captured one. Kept even though
  // the reply is gone: it is the id any investigation starts from.
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;

  // What the check actually saw, for diagnosing a verdict that turns out wrong.
  @IsOptional()
  @IsString()
  @MaxLength(512)
  evidence?: string;
}

// Persist an unpublished working draft for an opportunity (one DRAFT per
// opportunity, upserted). Content may be AI-generated, AI-then-edited, or fully
// hand-typed — the save is decoupled from generation. Surfaces in
// GET /sent?status=awaiting (Post.state=DRAFT); does not claim the opportunity,
// charge credits, or sync metrics.
export class SaveDraftDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsString()
  @MaxLength(4000)
  draftContent: string;

  @IsString()
  @IsIn(VALID_STRATEGIES)
  strategy: string;

  @IsInt()
  @Min(0)
  @Max(3)
  @Type(() => Number)
  brandStrength: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @ArrayMaxSize(20)
  mentions?: string[];
}

export class UpdateScheduledReplyDto {
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  content?: string;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string; // must be a future date

  @IsOptional()
  @IsString()
  @IsIn(VALID_STRATEGIES)
  strategy?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3)
  @Type(() => Number)
  brandStrength?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @ArrayMaxSize(20)
  mentions?: string[];
}

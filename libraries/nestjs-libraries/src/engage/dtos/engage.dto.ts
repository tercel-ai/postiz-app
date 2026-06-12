import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { EngageOpportunityStatus } from '@prisma/client';

const VALID_STRATEGIES = ['EXPERT_ANSWER', 'DATA_BACKED', 'EMPATHY_LED'] as const;

// Keyword types must match the literals the scorer strict-equals (engage-scorer.ts
// computeKeywordScore). Without this enum, lowercase / mis-cased values silently
// store but never receive the +5/+3 brand/competitor bonus.
export const KEYWORD_TYPES = ['CORE', 'BRAND', 'COMPETITOR'] as const;
export type KeywordType = (typeof KEYWORD_TYPES)[number] | null;

// ─── Config ───────────────────────────────────────────────────────────────────

export class SaveEngageConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
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
}

// ─── Keywords ─────────────────────────────────────────────────────────────────

export class AddKeywordDto {
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
}

// ─── Monitored Channels ───────────────────────────────────────────────────────

export class AddMonitoredChannelDto {
  @IsString()
  platform: string; // 'reddit' | 'youtube' | 'qq' | 'discord' | ...

  @IsString()
  channelId: string;

  @IsString()
  channelName: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  audienceSize?: number;

  @IsOptional()
  metadata?: Record<string, unknown>;
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

export class UpdateReplyAccountDto {
  @IsOptional()
  @IsBoolean()
  engageEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  autoReplyEnabled?: boolean;

  @IsOptional()
  @IsString()
  autoReplyTimeStart?: string; // 'HH:MM' 24h

  @IsOptional()
  @IsString()
  autoReplyTimeEnd?: string;

  @IsOptional()
  @IsString()
  autoReplyTimezone?: string; // IANA timezone

  @IsOptional()
  @IsString()
  defaultStrategy?: string;
}

// ─── Opportunities ────────────────────────────────────────────────────────────

export class ListOpportunitiesDto {
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

export class LocateOpportunityDto {
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
  @IsString()
  sentReplyId!: string;

  @IsOptional()
  @IsString()
  platform?: string;

  @IsOptional()
  @IsString()
  @IsIn(['published', 'scheduled', 'manual', 'error', 'draft', 'settled', 'awaiting'])
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
  platform?: string;

  // Two combined "rollup" values complement the four granular states:
  //   'settled'  = no further action needed: published (live) OR scheduled (will
  //                auto-fire). = published (PUBLISHED + releaseURL) OR QUEUE.
  //   'awaiting' = needs user action / generated but not yet live: manual
  //                link-pending (PUBLISHED + no releaseURL) OR a failed publish
  //                (ERROR). Folds in the former GET /engage/awaiting-review endpoint.
  @IsOptional()
  @IsString()
  @IsIn(['published', 'scheduled', 'manual', 'error', 'draft', 'settled', 'awaiting'])
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

// ─── Dashboard ──────────────────────────────────────────────────────────────

// Panel ① "Engage Performance" — headline summary stats, optionally scoped to one platform.
export class DashboardSummaryDto {
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
  @IsOptional()
  @IsString()
  @IsIn(['daily', 'weekly', 'monthly'])
  period?: string;
}

// Panel ④ "Engage Impressions Trend" — daily/weekly/monthly impressions by platform
// for engage posts. Response shape matches /dashboard/impressions so the same
// chart component can consume both.
export class DashboardImpressionsDto {
  @IsOptional()
  @IsString()
  @IsIn(['daily', 'weekly', 'monthly'])
  period?: string;
}

// Panel ③ "Traffic from Engage" — per-reply traffic-index breakdown.
export class DashboardTrafficsDto {
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
}

export class BatchScheduleReplyDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScheduleReplyDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  items: ScheduleReplyDto[];
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

// Persist an unpublished working draft for an opportunity (one DRAFT per
// opportunity, upserted). Content may be AI-generated, AI-then-edited, or fully
// hand-typed — the save is decoupled from generation. Surfaces in
// GET /sent?status=awaiting (Post.state=DRAFT); does not claim the opportunity,
// charge credits, or sync metrics.
export class SaveDraftDto {
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

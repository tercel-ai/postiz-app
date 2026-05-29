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

// Sentinel for the `channels` / `authors` opportunity filters meaning
// "all of this org's configured channels / tracked accounts".
export const ENGAGE_FILTER_ALL = '__all__';

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
  @IsOptional()
  @IsString()
  platform?: string;

  @IsOptional()
  @IsEnum(EngageOpportunityStatus)
  status?: EngageOpportunityStatus;

  @IsOptional()
  @IsString()
  intent?: string;

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

  // Channel filter. `__all__` (ENGAGE_FILTER_ALL) = all of this org's enabled
  // monitored channels; any other value = that specific channel id (e.g. "SEO").
  @IsOptional()
  @IsString()
  channels?: string;

  // Author filter. `__all__` = posts from any of this org's tracked accounts
  // (i.e. scoreTracked > 0); any other value = that specific author username.
  @IsOptional()
  @IsString()
  authors?: string;

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

  @IsOptional()
  @IsString()
  @IsIn(['published', 'scheduled', 'manual', 'error'])
  status?: string;

  @IsOptional()
  @IsString()
  @IsIn(['today', 'week', 'month'])
  date?: 'today' | 'week' | 'month';

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

// Panel ② "Your Posts" overlay — daily Engage reply counts over a trailing window.
export class DashboardDailyDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}

// Panel ③ "Traffic from Engage" — per-reply traffic-index breakdown.
export class DashboardTrafficDto {
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
}

export class SubmitManualReplyUrlDto {
  @IsString()
  @MaxLength(2048)
  url: string;
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


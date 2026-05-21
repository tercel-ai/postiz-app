import {
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
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { EngageOpportunityStatus } from '@prisma/client';

const VALID_STRATEGIES = ['EXPERT_ANSWER', 'DATA_BACKED', 'EMPATHY_LED'] as const;

// ─── Config ───────────────────────────────────────────────────────────────────

export class SaveEngageConfigDto {
  @IsOptional()
  @IsBoolean()
  setupCompleted?: boolean;
}

// ─── Keywords ─────────────────────────────────────────────────────────────────

export class AddKeywordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  keyword: string;

  @IsOptional()
  @IsString()
  type?: string; // 'CORE' | 'BRAND' | 'COMPETITOR' | future

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateKeywordDto {
  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
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
  @MaxLength(100)
  categoryLabel?: string; // e.g. 'GEO专家'
}

export class UpdateTrackedAccountDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

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

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  trackedOnly?: boolean;

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
}

export class ScheduleReplyDto extends SendReplyDto {
  @IsDateString()
  scheduledAt: string; // ISO date string (must be a future date)
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
}

export class SubmitManualReplyUrlDto {
  @IsString()
  @MaxLength(2048)
  url: string;
}

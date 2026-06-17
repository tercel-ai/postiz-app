import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { RawPost } from '@gitroom/nestjs-libraries/engage/engage-scorer';

/**
 * One post the extension fetched (with the user's session) and NORMALISED to the
 * backend RawPost shape. The backend never sees raw platform JSON — the
 * extension owns parsing — so this mirrors `RawPost` (engage-scorer) field for
 * field. Metrics are optional and default to 0 server-side; only identity +
 * content + author + publish time are required to score and persist.
 */
export class ScanIngestPostDto {
  @IsString() platform: string;
  @IsString() externalPostId: string;
  @IsString() externalPostUrl: string;
  @IsString() authorUsername: string;
  @IsString() postContent: string;
  @IsDateString() postPublishedAt: string;

  @IsOptional() @IsString() channelId?: string;
  @IsOptional() @IsString() channelName?: string;
  @IsOptional() @IsString() authorDisplayName?: string;
  @IsOptional() @IsString() authorAvatarUrl?: string;
  @IsOptional() @IsInt() @Min(0) authorFollowers?: number;
  @IsOptional() @IsInt() @Min(0) channelFollowers?: number;

  @IsOptional() @IsInt() @Min(0) metricLikes?: number;
  @IsOptional() @IsInt() @Min(0) metricReplies?: number;
  @IsOptional() @IsInt() @Min(0) metricRetweets?: number;
  @IsOptional() @IsInt() @Min(0) metricQuotes?: number;
  @IsOptional() @IsInt() @Min(0) metricBookmarks?: number;
  @IsOptional() @IsInt() @Min(0) metricViews?: number;
  @IsOptional() @IsInt() @Min(0) metricShares?: number;
  @IsOptional() @IsInt() @Min(0) metricSaves?: number;
  @IsOptional() @IsInt() metricScore?: number; // Reddit score may be negative
  @IsOptional() @IsNumber() metricUpvoteRatio?: number;
  @IsOptional() @IsInt() @Min(0) metricComments?: number;
}

/** Where the extension stopped — persisted as the unit's advanced cursor. */
export class ScanIngestCursorDto {
  @IsOptional() @IsString() lastSeenExternalId?: string;
  @IsOptional() @IsDateString() lastSeenAt?: string;
}

/**
 * Extension → backend write-back for one claimed scan unit. `taskId` is the
 * EngageScanCursor id from the instruction (the lease handle); the backend
 * scores + persists the normalised posts (two-table), advances the cursor, and
 * releases the lease. Capped to keep one ingest aligned with one paged run.
 */
export class EngageScanIngestDto {
  @IsString() taskId: string;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ScanIngestPostDto)
  posts: ScanIngestPostDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ScanIngestCursorDto)
  nextCursor?: ScanIngestCursorDto;

  /** True when the extension reached the end / hit maxPages (no backlog left). */
  @IsOptional() @IsBoolean() exhausted?: boolean;
}

/**
 * Request body for POST /engage/scan-tasks/ingest. `completed` is the unit just
 * scanned (absent on the first/bootstrap call); `want` caps how many next units
 * to claim back. The server always claims + returns the next batch.
 */
export class EngageScanSyncDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => EngageScanIngestDto)
  completed?: EngageScanIngestDto;

  @IsOptional() @IsInt() @Min(1) @Max(5) want?: number;
}

/** Map one normalised ingest post to the scorer's RawPost (metrics default 0). */
export function scanIngestPostToRawPost(p: ScanIngestPostDto): RawPost {
  return {
    id: p.externalPostId,
    platform: p.platform,
    externalPostId: p.externalPostId,
    externalPostUrl: p.externalPostUrl,
    channelId: p.channelId,
    channelName: p.channelName,
    authorUsername: p.authorUsername,
    authorDisplayName: p.authorDisplayName,
    authorFollowers: p.authorFollowers,
    channelFollowers: p.channelFollowers,
    authorAvatarUrl: p.authorAvatarUrl,
    postContent: p.postContent,
    postPublishedAt: new Date(p.postPublishedAt),
    metricLikes: p.metricLikes ?? 0,
    metricReplies: p.metricReplies ?? 0,
    metricRetweets: p.metricRetweets ?? 0,
    metricQuotes: p.metricQuotes ?? 0,
    metricBookmarks: p.metricBookmarks ?? 0,
    metricViews: p.metricViews ?? 0,
    metricShares: p.metricShares ?? 0,
    metricSaves: p.metricSaves ?? 0,
    metricScore: p.metricScore ?? 0,
    metricUpvoteRatio: p.metricUpvoteRatio,
    metricComments: p.metricComments ?? 0,
  };
}

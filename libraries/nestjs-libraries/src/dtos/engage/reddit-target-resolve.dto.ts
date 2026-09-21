import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * One post's outcome, as reported by the browser extension after it searched
 * Reddit with the user's own session.
 *
 * Validation here is deliberately loose on `subreddit` — length and type only.
 * The authoritative check is normalizeSubreddit in the service, which applies
 * Reddit's real name grammar and is shared with the generator's own resolver.
 * Duplicating that rule as decorators would create a second spelling of it that
 * could disagree.
 */
export class RedditTargetResolveItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  postId: string;

  /** The chosen community, with or without an `r/` prefix. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  subreddit?: string;

  /** Reddit's own text for the matched flair option. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  flairLabel?: string;

  /** Observed: this community refuses a post with no flair. */
  @IsOptional()
  @IsBoolean()
  flairRequired?: boolean;

  /** The extension looked and found no usable community. */
  @IsOptional()
  @IsBoolean()
  unresolvable?: boolean;
}

export class RedditTargetResolveDto {
  /**
   * Capped at the same size the hand-out is (MAX_LIMIT in
   * RedditTargetResolutionService): a batch larger than what was offered did not
   * come from a poll of ours.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RedditTargetResolveItemDto)
  items: RedditTargetResolveItemDto[];
}

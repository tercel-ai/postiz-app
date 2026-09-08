import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { State } from '@prisma/client';

// Admin-side query for the cross-org Engage reply list (GET /admin/engage/sent).
// Mirrors AdminPostsQueryDto: optional org/user scoping resolved by
// resolveOrganizationId, plus Engage-specific filters (platform via the linked
// opportunity, state via the reply Post).
export class AdminEngageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;

  @IsOptional()
  @IsString()
  organizationId?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  // Platform of the opportunity the reply was posted to (x | reddit | ...).
  // No @IsIn — the supported provider set is open-ended; an unknown value simply
  // matches nothing rather than 400-ing.
  @IsOptional()
  @IsString()
  platform?: string;

  // Find the replies posted to one source post. Matched as a case-insensitive
  // substring of the opportunity's externalPostUrl, and normalised first, so a
  // pasted `twitter.com/...?s=20` finds the row stored as `x.com/...`. A bare
  // status id works too (it is a substring of the stored URL).
  @IsOptional()
  @IsString()
  externalPostUrl?: string;

  // Filter by the reply Post.state (DRAFT | QUEUE | PUBLISHED | ERROR).
  @IsOptional()
  @IsEnum(State)
  state?: State;

  // Whether the opportunity this reply answers carries a `repliesDisabledAt`
  // stamp — the platform was reported as accepting no replies on that post.
  //
  // TRI-STATE, unlike AdminOpportunityQueryDto.onlyBrokenUrls: `true` = only
  // closed posts, `false` = only open ones, omitted = both. Which is why the
  // transform hands anything it does not recognise straight to @IsBoolean and
  // takes the 400. Coercing (the `value === 'true'` shorthand) would read a
  // typo'd `repliesDisabled=yes` as `false` and quietly answer "only the open
  // ones" — the opposite of what was asked, with nothing to show for it.
  @IsOptional()
  @Transform(({ value }) => {
    if (value === '' || value === undefined || value === null) return undefined;
    if (value === true || value === 'true' || value === '1') return true;
    if (value === false || value === 'false' || value === '0') return false;
    return value;
  })
  @IsBoolean()
  repliesDisabled?: boolean;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'desc';
}

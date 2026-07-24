import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
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

  // Filter by the reply Post.state (DRAFT | QUEUE | PUBLISHED | ERROR).
  @IsOptional()
  @IsEnum(State)
  state?: State;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'desc';
}

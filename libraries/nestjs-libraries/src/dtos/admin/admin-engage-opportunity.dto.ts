import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

// Admin-side triage of EngageOpportunity rows whose stored address is not a
// single post — see docs/admin-engage-opportunities.md. Driven by the browser
// extension, which is the only place a LinkedIn address can be re-resolved
// (those pages are members-only, so no server job can read them).

export class AdminOpportunityQueryDto {
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
  pageSize: number = 25;

  // No @IsIn: the provider set is open-ended, and an unknown value should match
  // nothing rather than 400 (same reasoning as AdminEngageQueryDto.platform).
  @IsOptional()
  @IsString()
  platform?: string;

  // Restrict to rows that cannot be replied to: an entity-page address
  // (/company/, /school/, /showcase/) or no address at all.
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  onlyBrokenUrls?: boolean;
}

export class AdminOpportunityUrlItemDto {
  @IsString()
  id: string;

  @IsString()
  externalPostUrl: string;
}

export class AdminOpportunityUrlBodyDto {
  // Bounded so one call cannot rewrite the table. The extension probes ~25 rows
  // per page and only sends the ones it verified.
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AdminOpportunityUrlItemDto)
  items: AdminOpportunityUrlItemDto[];
}

export class AdminOpportunityDeleteBodyDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  ids: string[];
}

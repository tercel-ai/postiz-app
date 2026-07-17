import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsDateString,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { State } from '@prisma/client';
import { VALID_CHANNELS, Channel } from '@gitroom/nestjs-libraries/dtos/posts/get.posts-list.dto';
import { VALID_POST_SOURCES, PostSource } from '@gitroom/nestjs-libraries/dtos/posts/post-source';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GetPostsDto {
  @ApiProperty()
  @IsDateString()
  startDate: string;

  @ApiProperty()
  @IsDateString()
  endDate: string;

  @ApiPropertyOptional({ enum: ['day', 'week', 'month'] })
  @IsOptional()
  @IsString()
  @IsIn(['day', 'week', 'month'])
  display?: 'day' | 'week' | 'month';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customer?: string;

  // Opaque aisee-core products.id. Omitting it returns every post the caller
  // can already see (legacy, non-project behavior preserved during migration
  // — project-scoped-post-engage-design.md §8/§11).
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  projectId?: string;

  // Filter to only the posts generated under one OperationPlan.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  operationPlanId?: string;

  @ApiPropertyOptional({ enum: State })
  @IsOptional()
  @IsEnum(State)
  state?: State;

  // Filter by Post.source. Accepts a single value ('engage') or a
  // comma-separated list ('calendar,chat'); omitting it returns all sources.
  // Used by the Engage Calendar / Upcoming Replies panels.
  @ApiPropertyOptional({ enum: VALID_POST_SOURCES, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(VALID_POST_SOURCES.length)
  @IsString({ each: true })
  @IsIn(VALID_POST_SOURCES as unknown as string[], { each: true })
  @Transform(({ value }) =>
    (Array.isArray(value) ? value : [value]).flatMap((v: string) =>
      v.includes(',') ? v.split(',') : [v]
    )
  )
  source?: PostSource[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Transform(({ value }) =>
    (Array.isArray(value) ? value : [value]).flatMap((v: string) =>
      v.includes(',') ? v.split(',') : [v]
    )
  )
  integrationId?: string[];

  @ApiPropertyOptional({ enum: VALID_CHANNELS, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @IsIn(VALID_CHANNELS as unknown as string[], { each: true })
  @Transform(({ value }) =>
    (Array.isArray(value) ? value : [value]).flatMap((v: string) =>
      v.includes(',') ? v.split(',') : [v]
    )
  )
  channel?: Channel[];
}

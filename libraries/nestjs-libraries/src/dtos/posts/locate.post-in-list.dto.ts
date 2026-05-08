import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { State } from '@prisma/client';
import {
  Channel,
  VALID_CHANNELS,
} from '@gitroom/nestjs-libraries/dtos/posts/get.posts-list.dto';

export class LocatePostInListDto {
  @ApiProperty({ description: 'Post id whose page within /posts/list to locate' })
  @IsString()
  @IsNotEmpty()
  postId!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;

  @ApiPropertyOptional({ enum: State })
  @IsOptional()
  @IsEnum(State)
  state?: State;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) =>
    (Array.isArray(value) ? value : [value]).flatMap((v: string) =>
      v.includes(',') ? v.split(',') : [v]
    )
  )
  integrationId?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Filter by provider type (e.g. x, reddit, linkedin)',
    enum: VALID_CHANNELS,
  })
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sourcePostId?: string;

  @ApiPropertyOptional({ enum: ['templates', 'timeline'], default: 'timeline' })
  @IsOptional()
  @IsIn(['templates', 'timeline'])
  view?: 'templates' | 'timeline' = 'timeline';

  @ApiPropertyOptional({
    enum: ['publishDate', 'createdAt', 'updatedAt', 'state'],
    default: 'publishDate',
  })
  @IsOptional()
  @IsIn(['publishDate', 'createdAt', 'updatedAt', 'state'])
  sortBy?: 'publishDate' | 'createdAt' | 'updatedAt' | 'state' = 'publishDate';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';
}

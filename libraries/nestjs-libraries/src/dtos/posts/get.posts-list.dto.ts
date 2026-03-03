import { ArrayMaxSize, IsArray, IsEnum, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { State } from '@prisma/client';

export const VALID_CHANNELS = [
  'x', 'reddit', 'linkedin', 'linkedin-page', 'instagram',
  'instagram-standalone', 'facebook', 'youtube', 'tiktok',
  'pinterest', 'threads', 'mastodon', 'bluesky', 'medium',
  'devto', 'hashnode', 'wordpress', 'discord', 'slack',
  'telegram', 'dribbble', 'kick', 'twitch', 'lemmy',
  'listmonk', 'gmb', 'wrapcast', 'nostr', 'vk',
] as const;

export type Channel = (typeof VALID_CHANNELS)[number];

export class GetPostsListDto {
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
  @IsEnum(State)
  state?: State;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) =>
    (Array.isArray(value) ? value : [value]).flatMap((v: string) =>
      v.includes(',') ? v.split(',') : [v]
    )
  )
  integrationId?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Filter by provider type (e.g. x, reddit, linkedin)' })
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

  @IsOptional()
  @IsIn(['publishDate', 'createdAt', 'updatedAt', 'state'])
  sortBy: 'publishDate' | 'createdAt' | 'updatedAt' | 'state' = 'publishDate';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'desc';
}

import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { State } from '@prisma/client';

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
  @IsString()
  integrationId?: string;

  @IsOptional()
  @IsIn(['publishDate', 'createdAt', 'updatedAt', 'state'])
  sortBy: 'publishDate' | 'createdAt' | 'updatedAt' | 'state' = 'publishDate';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'desc';
}

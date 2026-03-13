import { IsInt, IsNotEmpty, IsOptional, Max, Min, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class GetPostReleasesDto {
  @IsString()
  @IsNotEmpty()
  postId: string;

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
}

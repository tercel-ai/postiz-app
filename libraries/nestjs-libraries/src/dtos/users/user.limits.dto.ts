import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class UpdateUserLimitsDto {
  @IsString()
  userId: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxChannels?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxPostsPerMonth?: number | null;
}

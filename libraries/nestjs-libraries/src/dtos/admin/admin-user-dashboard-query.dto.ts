import { IsOptional, IsString, IsDateString, IsArray, ArrayMaxSize, IsIn } from 'class-validator';
import { Transform } from 'class-transformer';
import { VALID_CHANNELS, Channel } from '@gitroom/nestjs-libraries/dtos/posts/get.posts-list.dto';

const csvTransform = Transform(({ value }) =>
  (Array.isArray(value) ? value : [value]).flatMap((v: string) =>
    v.includes(',') ? v.split(',') : [v]
  )
);

export class AdminUserDashboardSummaryQueryDto {
  @IsOptional()
  @IsString()
  organizationId?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @csvTransform
  integrationId?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @IsIn(VALID_CHANNELS as unknown as string[], { each: true })
  @csvTransform
  channel?: Channel[];

  @IsOptional()
  @IsString()
  tz?: string;
}

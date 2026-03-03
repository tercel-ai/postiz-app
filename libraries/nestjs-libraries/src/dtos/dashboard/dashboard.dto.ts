import { IsOptional, IsString, IsIn, IsInt, Min, Max, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';

export class DashboardSummaryQueryDto {
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;
}

export class PostsTrendQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(['daily', 'weekly', 'monthly'])
  period?: 'daily' | 'weekly' | 'monthly' = 'daily';
}

export class ImpressionsQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(['daily', 'weekly', 'monthly'])
  period?: 'daily' | 'weekly' | 'monthly' = 'daily';
}

export class PostEngagementQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number = 30;
}

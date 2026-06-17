import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDefined,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/**
 * One metric series as returned by a platform's analytics, mirroring the
 * backend `AnalyticsData` shape so the same `extractMetrics` pipeline can be
 * reused. `total` is left loosely typed (string or number) — the pipeline
 * coerces with `Number(...)` — so the extension need not stringify.
 */
class AnalyticsPointDto {
  @IsDefined()
  total: string | number;

  @IsString()
  date: string;
}

class AnalyticsDataDto {
  @IsString()
  label: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AnalyticsPointDto)
  data: AnalyticsPointDto[];

  @IsOptional()
  @IsNumber()
  percentageChange?: number;
}

class MetricsBackfillItemDto {
  @IsString()
  postId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AnalyticsDataDto)
  analytics: AnalyticsDataDto[];
}

/**
 * Extension → server write-back of metrics it fetched for the posts the user is
 * viewing. The platform for each post is resolved server-side from ownership, so
 * the body carries only post id + raw metric series. Capped to keep the batch
 * aligned with one viewed page.
 */
export class MetricsBackfillDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => MetricsBackfillItemDto)
  items: MetricsBackfillItemDto[];
}

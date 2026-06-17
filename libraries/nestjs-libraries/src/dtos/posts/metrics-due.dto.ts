import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsString } from 'class-validator';

/**
 * The post ids the extension is currently viewing (one page). The server returns
 * the subset that is due for a metrics fetch (within the monitoring window and
 * past the fetch interval). Capped to keep request volume organic / low.
 */
export class MetricsDueDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ids: string[];
}

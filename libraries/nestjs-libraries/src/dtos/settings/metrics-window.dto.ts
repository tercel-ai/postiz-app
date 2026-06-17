import { IsInt, Max, Min } from 'class-validator';

/**
 * User-set metrics-monitoring window (days): posts published within this many
 * days stay under analytics monitoring. The server clamps the value to the
 * org's plan ceiling at read time, so the upper bound here is only a sanity
 * guard against absurd inputs.
 */
export class MetricsWindowDto {
  @IsInt()
  @Min(1)
  @Max(365)
  metricsWindowDays: number;
}

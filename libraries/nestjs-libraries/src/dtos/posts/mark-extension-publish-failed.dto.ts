import { Type } from 'class-transformer';
import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PublishedSegmentDto } from './published-segment.dto';

/**
 * Body for the extension publish-FAILED callback (PATCH
 * /posts/:id/extension-publish-failed).
 *
 * A thread publishes segment by segment and STOPS at the first failure, so a
 * "failed" task is routinely a PARTIAL SUCCESS: the anchor (and possibly more
 * segments) is already live on the platform. `segments` carries exactly which
 * ones went out, so the server can record them PUBLISHED instead of marking a
 * live post ERROR — which would leave it out of every metrics path forever,
 * with no way to recover the permalinks (they live only in the extension's
 * queue state and are dropped when it settles).
 *
 * Optional for version skew: an older extension omits it and the server keeps
 * the previous all-or-nothing behaviour.
 */
export class MarkExtensionPublishFailedDto {
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  error?: string;

  /**
   * Segments that DID publish before the failure, in publish order. An empty or
   * absent list means nothing went out (the classic total failure).
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PublishedSegmentDto)
  segments?: PublishedSegmentDto[];
}

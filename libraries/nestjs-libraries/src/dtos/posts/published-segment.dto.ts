import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * One thread segment the extension actually PUBLISHED, reported back on both
 * extension callbacks.
 *
 * `postId` is OUR Post id, echoed from the due-item's `segments[].postId` — not a
 * position in the list. A thread is offered and settled across a network hop and
 * a lease window (minutes), during which the chain can change (an edit, a plan
 * re-materialize, a soft-delete). Matching by position would then stamp a live
 * permalink onto the wrong Post row — silent corruption, and strictly worse than
 * the state inaccuracy this whole mechanism exists to fix. Matching by id cannot.
 */
export class PublishedSegmentDto {
  /** Our Post id for this segment, echoed from the due-item. */
  @IsString()
  @MaxLength(64)
  postId!: string;

  /**
   * Permalink of this segment. Optional for the same reason as the top-level
   * releaseURL: a platform can confirm the send without yielding a URL.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;

  /** Platform post id for this segment, stored as releaseId. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  releaseId?: string;
}

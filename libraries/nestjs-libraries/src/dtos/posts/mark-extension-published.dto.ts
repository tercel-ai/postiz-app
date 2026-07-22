import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for the extension publish-on-success callback (PATCH
 * /posts/:id/extension-published). The browser extension publishes a Post
 * in-browser with the user's own platform session, then reports the permalink
 * (+ platform post id) back so the server flips the saved Post to PUBLISHED and
 * backfills its releaseURL — the same closed loop as the Engage reply flow.
 */
export class MarkExtensionPublishedDto {
  /** Permalink of the published post (the first thread segment). */
  @IsString()
  @MaxLength(2048)
  releaseURL: string;

  /** Platform post id (Reddit t3_* fullname / X rest_id), stored as releaseId. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  releaseId?: string;
}

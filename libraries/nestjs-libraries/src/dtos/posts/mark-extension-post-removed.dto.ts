import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for the extension removal callback (PATCH /posts/:id/extension-removed).
 * The extension published this Post successfully, then a logged-out check
 * (utils/liveness/, currently Reddit only) found the platform had removed it
 * seconds later. Mirrors engage's MarkReplyRemovedDto — see that file's
 * comment for why `reason` is one of exactly these two values.
 */
export class MarkExtensionPostRemovedDto {
  @IsString()
  @IsIn(['removed', 'gone'])
  reason: string;

  /** The post's own permalink, when the poster captured one. */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  releaseURL?: string;

  /** What the check actually saw, for diagnosing a verdict that turns out wrong. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  evidence?: string;
}

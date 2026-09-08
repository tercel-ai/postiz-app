import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { VALID_CHANNELS } from '@gitroom/nestjs-libraries/dtos/posts/get.posts-list.dto';

/**
 * One platform's login state from the extension's session-maintenance probe
 * (aisee-browser-extension's `PlatformLoginEntry`). `id` is the platform-side
 * account id, comparable to `Integration.internalId` — the primary match key.
 * `handle` is the username without any @/u/ prefix, used as a fallback match
 * against `Integration.profile` when `id` is absent or doesn't resolve.
 */
export class ExtensionSessionPlatformDto {
  @IsString()
  @IsIn(VALID_CHANNELS as unknown as string[])
  platform!: string;

  @IsBoolean()
  loggedIn!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  handle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  name?: string;

  /**
   * Avatar url as the extension read it from the platform, http(s) only. Used
   * to picture a channel CREATED from this report, and to backfill one whose
   * stored picture is missing or was never an image — never to re-upload a
   * picture that is already good (the stored copy is re-hosted, so it can't be
   * compared to this url, and a user can set their own from the UI).
   *
   * Longer cap than the identity fields: platform CDN avatar urls carry signing
   * and sizing query strings that routinely run past 256 characters.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  picture?: string;
}

/**
 * Body for PATCH /integrations/extension-session — the browser extension's
 * hourly session-maintenance job reports what it already probed, once per
 * platform. The server fans this out across every Integration the org has
 * for a reported platform: the matching one (by internalId, falling back to
 * profile) is marked reachable via the 'extension' send path, every sibling
 * on that platform is marked not reachable. This never blocks the 'api' send
 * path or the publish-due queue — see extensionRouteBranches() — it only
 * feeds diagnostics and CLI display.
 */
export class ExtensionSessionReportDto {
  @IsDateString()
  checkedAt!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExtensionSessionPlatformDto)
  platforms!: ExtensionSessionPlatformDto[];
}

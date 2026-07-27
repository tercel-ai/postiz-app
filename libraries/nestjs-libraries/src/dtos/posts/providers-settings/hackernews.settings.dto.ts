import { IsDefined, IsString, MinLength } from 'class-validator';

/**
 * Hacker News post settings. A submission needs a title (the story headline);
 * the post body is the message content. Publishing happens via the browser
 * extension (HN has no write API), but the settings shape mirrors the other
 * article providers so the composer UI and validation are consistent.
 */
export class HackernewsSettingsDto {
  @IsString()
  @MinLength(2)
  @IsDefined()
  title: string;
}

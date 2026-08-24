import { IsDefined, IsOptional, IsString, Matches, MinLength, ValidateIf } from 'class-validator';

/**
 * Hacker News post settings. A submission needs a title (the story headline);
 * the post body is the message content. Publishing happens via the browser
 * extension (HN has no write API), but the settings shape mirrors the other
 * article providers so the composer UI and validation are consistent.
 *
 * `url` is optional: when present the submission is a link post (HN's "Show
 * HN"/"link" story, e.g. the project's own product page); when absent it is a
 * plain text post. Same URL regex as reddit/medium's link fields, including
 * the `(post:` escape hatch for the composer's cross-post link variable.
 */
export class HackernewsSettingsDto {
  @IsString()
  @MinLength(2)
  @IsDefined()
  title: string;

  @IsOptional()
  @IsString()
  @ValidateIf((o) => o.url && o.url.indexOf('(post:') === -1)
  @Matches(
    /^(|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})$/,
    {
      message: 'Invalid URL',
    }
  )
  url?: string;
}

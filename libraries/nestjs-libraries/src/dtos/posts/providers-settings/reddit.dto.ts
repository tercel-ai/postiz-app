import {
  ArrayMinSize,
  IsBoolean,
  IsDefined,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RedditFlairDto {
  @IsString()
  @IsDefined()
  id: string;

  @IsString()
  @IsDefined()
  name: string;
}

export class RedditSettingsDtoInner {
  @IsString()
  @MinLength(2)
  @IsDefined()
  subreddit: string;

  @IsString()
  @MinLength(2)
  @IsDefined()
  title: string;

  @IsString()
  @MinLength(2)
  @IsDefined()
  type: string;

  @IsUrl()
  @IsDefined()
  @ValidateIf((o) => o.type === 'link' && o?.url?.indexOf('(post:') === -1)
  @Matches(
    /^(|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})$/,
    {
      message: 'Invalid URL',
    }
  )
  url: string;

  @IsBoolean()
  @IsDefined()
  is_flair_required: boolean;

  @ValidateIf((e) => e.is_flair_required)
  @IsDefined()
  @ValidateNested()
  @Type(() => RedditFlairDto)
  flair: RedditFlairDto;
}

export class RedditSettingsValueDto {
  @Type(() => RedditSettingsDtoInner)
  @IsDefined()
  @ValidateNested()
  value: RedditSettingsDtoInner;
}

export class RedditSettingsDto {
  // Absent in reply mode (see `replyToId` below) — the subreddit-submission
  // path is skipped entirely then, so it has nothing to validate.
  @ValidateIf((o) => !o.replyToId)
  @Type(() => RedditSettingsValueDto)
  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  subreddit: RedditSettingsValueDto[];

  // Reply-to-existing-thread mode (Engage scheduled replies): a bare Reddit id
  // to comment on via /api/comment, bypassing subreddit submission. Not part
  // of the normal compose UI — set only by engage.service.ts.
  @IsOptional()
  @IsString()
  replyToId?: string;
}

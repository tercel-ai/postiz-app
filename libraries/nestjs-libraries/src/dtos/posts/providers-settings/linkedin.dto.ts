import { IsBoolean, IsIn, IsOptional, IsString, Matches } from 'class-validator';

export class LinkedinDto {
  @IsBoolean()
  @IsOptional()
  post_as_images_carousel?: boolean;

  @IsString()
  @IsIn(['PUBLIC', 'CONNECTIONS', 'LOGGED_IN'])
  @IsOptional()
  visibility?: 'PUBLIC' | 'CONNECTIONS' | 'LOGGED_IN';

  @IsBoolean()
  @IsOptional()
  disable_comments?: boolean;

  @IsOptional()
  @Matches(/^(https:\/\/(www\.)?linkedin\.com\/(feed\/update\/urn:li:activity:\d+|posts\/[a-zA-Z0-9_-]+activity-\d+-[a-zA-Z0-9_-]+)\/?(\?.*)?)?$/, {
    message: 'Invalid LinkedIn post URL. Example: https://www.linkedin.com/feed/update/urn:li:activity:1234567890',
  })
  reshare_url?: string;
}
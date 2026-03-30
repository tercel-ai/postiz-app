import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

export class LinkedinDto {
  @IsBoolean()
  @IsOptional()
  post_as_images_carousel: boolean;

  @IsString()
  @IsIn(['PUBLIC', 'CONNECTIONS', 'LOGGED_IN'])
  @IsOptional()
  visibility: 'PUBLIC' | 'CONNECTIONS' | 'LOGGED_IN';

  @IsBoolean()
  @IsOptional()
  disable_comments: boolean;
}
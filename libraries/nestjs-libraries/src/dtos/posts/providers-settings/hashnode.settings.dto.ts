import {
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MediaDto } from '@gitroom/nestjs-libraries/dtos/media/media.dto';

export class HashnodeTagsSettings {
  @IsString()
  value: string;

  @IsString()
  label: string;
}

export class HashnodeSettingsDto {
  @IsString()
  @MinLength(6)
  @IsDefined()
  title: string;

  // Optional on Hashnode too; skip the length check for an empty string so a
  // frontend sending `subtitle: ''` (untouched field) does not 400.
  @IsOptional()
  @ValidateIf((o) => o.subtitle !== '')
  @IsString()
  @MinLength(2)
  subtitle?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MediaDto)
  main_image?: MediaDto;

  @IsOptional()
  @IsString()
  @ValidateIf((o) => o.canonical && o.canonical.indexOf('(post:') === -1)
  @Matches(
    /^(|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})$/,
    {
      message: 'Invalid URL',
    }
  )
  canonical?: string;

  @IsString()
  @IsDefined()
  publication?: string;

  @IsArray()
  @ArrayMinSize(1)
  @Type(() => HashnodeTagsSettings)
  @ValidateNested({ each: true })
  tags: HashnodeTagsSettings[];
}

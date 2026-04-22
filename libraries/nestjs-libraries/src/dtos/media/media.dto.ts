import { IsDefined, IsString, IsUrl, ValidateIf, Validate } from 'class-validator';
import { ValidUrlExtension, ValidUrlPath } from '@gitroom/helpers/utils/valid.url.path';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MediaDto {
  @ApiProperty()
  @IsString()
  @IsDefined()
  id: string;

  @ApiProperty()
  @IsString()
  @IsDefined()
  @Validate(ValidUrlPath)
  @Validate(ValidUrlExtension)
  path: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => o.alt)
  @IsString()
  alt?: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => o.thumbnail)
  @IsUrl()
  thumbnail?: string;
}

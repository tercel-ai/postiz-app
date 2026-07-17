import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsDefined,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MinLength,
  Validate,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MediaDto } from '@gitroom/nestjs-libraries/dtos/media/media.dto';
import {
  allProviders,
  type AllProvidersSettings,
  EmptySettings,
} from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/all.providers.settings';
import { ValidContent } from '@gitroom/helpers/utils/valid.images';
import {
  VALID_POST_SOURCES,
  PostSource,
} from '@gitroom/nestjs-libraries/dtos/posts/post-source';

export class Integration {
  @IsDefined()
  @IsString()
  id: string;
}

export class PostContent {
  @IsDefined()
  @IsString()
  @Validate(ValidContent)
  content: string;

  @IsOptional()
  @IsString()
  id: string;

  @IsOptional()
  @IsNumber()
  delay: number;

  @IsArray()
  @Type(() => MediaDto)
  @ValidateNested({ each: true })
  image: MediaDto[];
}

export class Post {
  @IsDefined()
  @Type(() => Integration)
  @ValidateNested()
  integration: Integration;

  @IsDefined()
  @ArrayMinSize(1)
  @IsArray()
  @Type(() => PostContent)
  @ValidateNested({ each: true })
  value: PostContent[];

  @IsOptional()
  @IsString()
  group: string;

  @ValidateNested()
  @Type(() => EmptySettings, {
    keepDiscriminatorProperty: true,
    discriminator: {
      property: '__type',
      subTypes: allProviders(EmptySettings),
    },
  })
  settings: AllProvidersSettings;
}

class Tags {
  @IsDefined()
  @IsString()
  value: string;

  @IsDefined()
  @IsString()
  label: string;
}

export class CreatePostDto {
  @IsDefined()
  @IsIn(['draft', 'schedule', 'now'])
  type: 'draft' | 'schedule' | 'now';

  // Opaque aisee-core products.id. Omit for a legacy, non-project post
  // (project-scoped-post-engage-design.md §8/§11 — must keep working during
  // migration). ProjectAuthGuard has already authorized this value against
  // the caller's organization by the time this DTO is validated.
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsIn(VALID_POST_SOURCES as unknown as string[])
  source?: PostSource;

  @IsOptional()
  @IsString()
  order?: string;

  @IsDefined()
  @IsBoolean()
  shortLink: boolean;

  @IsOptional()
  @IsNumber()
  inter?: number;

  @IsDefined()
  @IsDateString()
  date: string;

  @IsArray()
  @IsDefined()
  @ValidateNested({ each: true })
  tags: Tags[];

  @ValidateIf((o) => o.type !== 'draft')
  @IsDefined()
  @Type(() => Post)
  @IsArray()
  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  posts: Post[];
}

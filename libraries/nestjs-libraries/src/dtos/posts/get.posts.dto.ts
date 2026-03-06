import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsDateString,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { State } from '@prisma/client';
import { VALID_CHANNELS, Channel } from '@gitroom/nestjs-libraries/dtos/posts/get.posts-list.dto';

export class GetPostsDto {
  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsOptional()
  @IsString()
  customer: string;

  @IsOptional()
  @IsEnum(State)
  state?: State;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Transform(({ value }) =>
    (Array.isArray(value) ? value : [value]).flatMap((v: string) =>
      v.includes(',') ? v.split(',') : [v]
    )
  )
  integrationId?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @IsIn(VALID_CHANNELS as unknown as string[], { each: true })
  @Transform(({ value }) =>
    (Array.isArray(value) ? value : [value]).flatMap((v: string) =>
      v.includes(',') ? v.split(',') : [v]
    )
  )
  channel?: Channel[];
}

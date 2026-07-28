import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/**
 * One post to commit to the send queue (DRAFT -> QUEUE). `id` is the ROOT post
 * of a channel's chain — its thread children are flipped with it. `publishMethod`
 * is the user's optional choice of send path; omit it to let the backend resolve
 * the only viable path (and, when both are viable, default to the extension).
 */
export class SchedulePostItemDto {
  @IsString()
  id!: string;

  // Lowercase to match the public PublishMethod contract; the backend maps it to
  // the Prisma enum. A choice the post cannot honour (e.g. 'api' with no bound
  // account) fails that item individually, not the whole batch.
  @IsOptional()
  @IsIn(['extension', 'api'])
  publishMethod?: 'extension' | 'api';

  // Optional new schedule time for THIS post (ISO). Set per-post — a batch can
  // commit different posts at different times. Omit to keep the post's existing
  // (materialized) publishDate. Applies to the post's whole thread chain.
  @IsOptional()
  @IsDateString()
  date?: string;
}

/**
 * Body for POST /posts/schedule — commit a batch of DRAFT posts (typically an
 * operation plan's selected posts) to the send queue. The DB QUEUE state is the
 * single source of truth; the send path (extension vs API) is decided here, once
 * per post, and both executors read that decision so a post is never double-sent.
 */
export class SchedulePostsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => SchedulePostItemDto)
  posts!: SchedulePostItemDto[];
}

import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  ValidateIf,
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
 *
 * Two mutually exclusive ways to name the batch: explicit `posts` (hand-picked
 * ids) or `planId` (every still-DRAFT post of one operation plan). Supplying
 * both is rejected rather than merged — a silent union would make it impossible
 * to tell which posts a per-post `publishMethod` was meant to apply to.
 */
export class SchedulePostsDto {
  // Hand-picked ids. Required only when `planId` is absent; ValidateIf keeps a
  // plan-scoped body from failing ArrayNotEmpty on a field it never sets.
  @ValidateIf((o) => !o.planId)
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => SchedulePostItemDto)
  posts?: SchedulePostItemDto[];

  // Plan-scoped alternative: commit EVERY still-DRAFT post of this operation
  // plan. Exists because "activate this plan" is one user action over a set the
  // client would otherwise have to enumerate and keep in sync — a plan can be
  // re-materialized, so a client-held id list goes stale.
  @ValidateIf((o) => !o.posts)
  @IsString()
  planId?: string;

  // Send path for a plan-scoped commit, applied to every post in it (a per-post
  // choice is only expressible through `posts`). Omit — the normal case — to let
  // the backend resolve each post's only viable path. Ignored when `posts` is
  // used, which carries its own per-item choice.
  @IsOptional()
  @IsIn(['extension', 'api'])
  publishMethod?: 'extension' | 'api';

  // Plan-scoped only: restrict activation to roots on these platforms
  // (Post.providerIdentifier, e.g. 'x' | 'reddit' | 'linkedin'; case-insensitive).
  // Omit to activate every platform the plan has. Every response field —
  // `total`, `alreadyScheduled`, `scheduled`, `failed` — is scoped to the
  // filtered set, not the whole plan, so a caller that filtered to `['x']`
  // never sees counts for posts it didn't ask to touch.
  //
  // Rejected together with `posts` — a hand-picked id list is already an
  // explicit selection, so a platform-shaped filter on top of it would be
  // ambiguous (narrow the list, or ignored?). That check lives in the
  // controller (mirroring the `planId`+`posts` mutual exclusion just above):
  // `@ValidateIf` can only skip a field's OWN validators, it cannot reject a
  // field for another field's presence.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  platforms?: string[];
}

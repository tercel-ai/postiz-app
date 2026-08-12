import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';
import { GetPostsListDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts-list.dto';
import { LocatePostInListDto } from '@gitroom/nestjs-libraries/dtos/posts/locate.post-in-list.dto';

// Query strings carry booleans as text, so `hasOperationPlan` must survive the
// 'true'/'false' round-trip AND stay `undefined` when the caller omits it —
// a stray `false` would silently hide every plan-generated post from existing
// callers that never passed the parameter.
const CASES = [
  { name: 'GetPostsDto', cls: GetPostsDto, base: { startDate: '2026-04-01T00:00:00Z', endDate: '2026-04-30T00:00:00Z' } },
  { name: 'GetPostsListDto', cls: GetPostsListDto, base: {} },
  { name: 'LocatePostInListDto', cls: LocatePostInListDto, base: { postId: 'post-1' } },
] as const;

describe.each(CASES)('$name.hasOperationPlan', ({ cls, base }) => {
  it('stays undefined when the parameter is absent', () => {
    const dto = plainToInstance(cls as any, { ...base }) as any;

    expect(dto.hasOperationPlan).toBeUndefined();
    expect(validateSync(dto)).toHaveLength(0);
  });

  it("parses 'true' into true", () => {
    const dto = plainToInstance(cls as any, {
      ...base,
      hasOperationPlan: 'true',
    }) as any;

    expect(dto.hasOperationPlan).toBe(true);
    expect(validateSync(dto)).toHaveLength(0);
  });

  it("parses 'false' into false", () => {
    const dto = plainToInstance(cls as any, {
      ...base,
      hasOperationPlan: 'false',
    }) as any;

    expect(dto.hasOperationPlan).toBe(false);
    expect(validateSync(dto)).toHaveLength(0);
  });
});

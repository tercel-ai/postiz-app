import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  DEFAULT_REFERENCE_POST_THREAD_PARTS,
  GenerateReferencePostDto,
  REFERENCE_POST_MAX_THREAD_PARTS,
  resolveThreadPostCount,
} from '@gitroom/nestjs-libraries/engage/dtos/engage.dto';

// `maxThreadParts` counts TOTAL posts, the anchor included, and is EXACT
// despite the name — both halves of which are historical (it counted
// follow-ups, and it was a ceiling). Resolving it in one place is what keeps
// the prompt, the token budget and the shortfall report from disagreeing
// about how long a thread was asked for.
describe('resolveThreadPostCount', () => {
  it('reads the field as a total post count, anchor included', () => {
    expect(resolveThreadPostCount({ maxThreadParts: 1 })).toBe(1);
    expect(resolveThreadPostCount({ maxThreadParts: 3 })).toBe(3);
    expect(resolveThreadPostCount({ maxThreadParts: 5 })).toBe(5);
  });

  it('falls back to the default when the field is absent', () => {
    expect(resolveThreadPostCount({})).toBe(DEFAULT_REFERENCE_POST_THREAD_PARTS);
    expect(resolveThreadPostCount({ maxThreadParts: undefined })).toBe(
      DEFAULT_REFERENCE_POST_THREAD_PARTS
    );
  });

  // Internal callers bypass the DTO's own @Min/@Max, and an unclamped value
  // would set the model's token budget as well as its instructions.
  it('clamps out-of-range values from callers that bypass the DTO', () => {
    expect(resolveThreadPostCount({ maxThreadParts: 99 })).toBe(
      REFERENCE_POST_MAX_THREAD_PARTS
    );
    expect(resolveThreadPostCount({ maxThreadParts: 0 })).toBe(1);
    expect(resolveThreadPostCount({ maxThreadParts: -3 })).toBe(1);
    expect(resolveThreadPostCount({ maxThreadParts: 3.7 })).toBe(3);
  });
});

describe('GenerateReferencePostDto thread bounds', () => {
  function validate(body: Record<string, unknown>) {
    const dto = plainToInstance(GenerateReferencePostDto, {
      strategy: 'EXPERT_ANSWER',
      brandStrength: 1,
      ...body,
    });
    return validateSync(dto as object);
  }

  // The range is unchanged from when this was a follow-up ceiling — only the
  // meaning of the number moved — so no client sending a valid value starts
  // getting a 400.
  it('accepts the whole 1-5 range', () => {
    for (let n = 1; n <= REFERENCE_POST_MAX_THREAD_PARTS; n++) {
      expect(validate({ maxThreadParts: n })).toHaveLength(0);
    }
  });

  it('rejects a count past the 5-post maximum', () => {
    const errors = validate({ maxThreadParts: REFERENCE_POST_MAX_THREAD_PARTS + 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('maxThreadParts');
  });

  it('rejects a count below one post', () => {
    const errors = validate({ maxThreadParts: 0 });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('maxThreadParts');
  });

  it('leaves the field optional', () => {
    expect(validate({})).toHaveLength(0);
  });
});

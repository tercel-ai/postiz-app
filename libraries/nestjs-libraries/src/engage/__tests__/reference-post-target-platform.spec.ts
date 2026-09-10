import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { GenerateReferencePostDto } from '@gitroom/nestjs-libraries/engage/dtos/engage.dto';
import { SCANNABLE_PLATFORMS } from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';

// `targetPlatform` turns reference-post generation from a→a into a→any: the
// opportunity stays the reference, this names the platform the post is WRITTEN
// FOR. The DTO is the boundary that keeps that value inside the vocabulary the
// rest of engage speaks.
describe('GenerateReferencePostDto targetPlatform', () => {
  function validate(body: Record<string, unknown>) {
    const dto = plainToInstance(GenerateReferencePostDto, {
      strategy: 'EXPERT_ANSWER',
      brandStrength: 1,
      ...body,
    });
    return validateSync(dto as object);
  }

  it('accepts every scannable platform', () => {
    for (const platform of SCANNABLE_PLATFORMS) {
      expect(validate({ targetPlatform: platform })).toHaveLength(0);
    }
  });

  // The allowlist is SCANNABLE_PLATFORMS itself, not a literal copy — so a
  // platform added there becomes a valid target with no second edit, and this
  // assertion keeps working without being rewritten.
  it('is sourced from the shared scannable list, not a private copy', () => {
    const errors = validate({ targetPlatform: 'x' });
    expect(errors).toHaveLength(0);
    expect(SCANNABLE_PLATFORMS).toContain('x');
  });

  // Not merely "some unknown string": `facebook` is a real provider this app
  // publishes to, and it is still rejected — engage generates for the
  // platforms it can scan, and nothing else.
  it('rejects a platform outside the scannable set', () => {
    for (const platform of ['facebook', 'mastodon', 'not-a-platform', '']) {
      const errors = validate({ targetPlatform: platform });
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('targetPlatform');
    }
  });

  it('rejects a non-string', () => {
    const errors = validate({ targetPlatform: 5 });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('targetPlatform');
  });

  // Backwards compatibility: every existing client omits it, and must keep
  // getting a post written for the opportunity's own platform.
  it('leaves the field optional', () => {
    expect(validate({})).toHaveLength(0);
    expect(validate({ targetPlatform: undefined })).toHaveLength(0);
  });
});

// `targetChannel` is what makes a reddit post reachable from a NON-reddit
// opportunity: nothing in an X or LinkedIn opportunity implies a community, so
// the caller names one or the request is refused. The DTO's job is to reject a
// name Reddit itself could never accept, before it reaches the provider.
describe('GenerateReferencePostDto targetChannel', () => {
  function validate(body: Record<string, unknown>) {
    const dto = plainToInstance(GenerateReferencePostDto, {
      strategy: 'EXPERT_ANSWER',
      brandStrength: 1,
      ...body,
    });
    return validateSync(dto as object);
  }

  it('accepts a bare subreddit name', () => {
    for (const name of ['pottery', 'r_place', 'AskReddit', 'a_b_1', 'abc']) {
      expect(validate({ targetChannel: name })).toHaveLength(0);
    }
  });

  // The `r/` prefix is the mistake a human copying from the address bar
  // actually makes, and it must fail here rather than reach Reddit as a
  // subreddit literally named "r".
  it('rejects an r/-prefixed name', () => {
    const errors = validate({ targetChannel: 'r/pottery' });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('targetChannel');
  });

  // Reddit's own rule: 3-21 characters, letters/digits/underscore only.
  it('rejects names outside reddit’s own shape', () => {
    for (const name of ['ab', 'a'.repeat(22), 'has space', 'has-dash', '']) {
      const errors = validate({ targetChannel: name });
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('targetChannel');
    }
  });

  // Omitted is the norm: a reddit→reddit generation resolves the subreddit
  // from the opportunity, and every non-reddit target ignores the field.
  it('leaves the field optional', () => {
    expect(validate({})).toHaveLength(0);
    expect(validate({ targetChannel: undefined })).toHaveLength(0);
  });
});

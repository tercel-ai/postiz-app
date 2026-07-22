import { describe, expect, it } from 'vitest';
import { parseRedditSubmitResponse } from '../reddit.poster';

describe('parseRedditSubmitResponse', () => {
  it('extracts url and fullname from an api_type=json submit response', () => {
    const data = {
      json: {
        errors: [],
        data: {
          url: 'https://www.reddit.com/r/test/comments/abc123/a_title/',
          id: 'abc123',
          name: 't3_abc123',
        },
      },
    };
    expect(parseRedditSubmitResponse(data)).toEqual({
      permalink: 'https://www.reddit.com/r/test/comments/abc123/a_title/',
      postId: 't3_abc123',
    });
  });

  it('returns empty fields on missing or malformed responses', () => {
    expect(parseRedditSubmitResponse(undefined)).toEqual({
      permalink: undefined,
      postId: undefined,
    });
    expect(parseRedditSubmitResponse({ json: {} })).toEqual({
      permalink: undefined,
      postId: undefined,
    });
    expect(parseRedditSubmitResponse({ json: { data: { url: 42 } } })).toEqual({
      permalink: undefined,
      postId: undefined,
    });
  });
});

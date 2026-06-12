import { describe, it, expect } from 'vitest';
import {
  resolveRedditThingId,
  parseRedditCommentThing,
} from '@gitroom/extension/utils/reddit.poster';

describe('resolveRedditThingId', () => {
  it('resolves a post URL to a t3_ fullname', () => {
    expect(
      resolveRedditThingId(
        'https://www.reddit.com/r/webdev/comments/1abc2de/some_title_slug/'
      )
    ).toBe('t3_1abc2de');
  });

  it('resolves a comment URL to a t1_ fullname', () => {
    expect(
      resolveRedditThingId(
        'https://www.reddit.com/r/webdev/comments/1abc2de/some_title_slug/h9x8y7z/'
      )
    ).toBe('t1_h9x8y7z');
  });

  it('handles old.reddit.com and missing trailing slash', () => {
    expect(
      resolveRedditThingId(
        'https://old.reddit.com/r/test/comments/9z9z9z/title'
      )
    ).toBe('t3_9z9z9z');
  });

  it('returns null for a non-comment Reddit URL', () => {
    expect(resolveRedditThingId('https://www.reddit.com/r/webdev/')).toBeNull();
  });

  it('returns null for an unparseable string', () => {
    expect(resolveRedditThingId('not a url')).toBeNull();
  });
});

describe('parseRedditCommentThing', () => {
  it('reads structured JSON shape (permalink + name)', () => {
    expect(
      parseRedditCommentThing({
        name: 't1_abc123',
        permalink: '/r/test/comments/xxx/title/abc123/',
      })
    ).toEqual({
      permalink: 'https://www.reddit.com/r/test/comments/xxx/title/abc123/',
      postId: 't1_abc123',
    });
  });

  it('reads HTML-render shape (data-permalink in content, id as fullname)', () => {
    const thing = {
      id: 't1_or061rp',
      content:
        '<div class="thing" data-permalink="/r/singularity/comments/1u21rk2/anthropic/or061rp/" data-author="x">…</div>',
    };
    expect(parseRedditCommentThing(thing)).toEqual({
      permalink:
        'https://www.reddit.com/r/singularity/comments/1u21rk2/anthropic/or061rp/',
      postId: 't1_or061rp',
    });
  });

  it('returns empty object for a null thing', () => {
    expect(parseRedditCommentThing(null)).toEqual({});
  });
});

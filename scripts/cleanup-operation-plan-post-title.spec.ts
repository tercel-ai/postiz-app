import { describe, it, expect } from 'vitest';
import { cleanPost } from './cleanup-operation-plan-post-title';

// A Reddit settings blob shaped exactly as the materializer writes it
// (operation-plan.repository.ts): __type + the subreddit[].value.{subreddit,
// title,type,is_flair_required} publishing header.
function redditSettings(title: string): string {
  return JSON.stringify({
    __type: 'reddit',
    campaignId: 'camp-1',
    contentId: 'c-1',
    themeKey: 'w1:foundations',
    subreddit: [
      {
        value: {
          subreddit: 'webdev',
          title,
          type: 'self',
          is_flair_required: false,
        },
      },
    ],
  });
}

describe('cleanPost', () => {
  it('cleans a non-reddit polluted title and leaves settings untouched', () => {
    const out = cleanPost('W1 - Foundations: Ship the beta', '{"__type":"x"}');
    expect(out).toEqual({
      title: 'Foundations: Ship the beta',
      settings: null, // no reddit header to rewrite
      redditTitles: 0,
    });
  });

  it('returns null when the title is already clean (idempotent)', () => {
    expect(cleanPost('Ship the beta', '{"__type":"x"}')).toBeNull();
  });

  it('cleans BOTH Post.title and the reddit submit header, preserving other fields', () => {
    const out = cleanPost(
      'W2 - Distribution: Seed the launch thread',
      redditSettings('W2 - Distribution: Seed the launch thread')
    );
    expect(out).not.toBeNull();
    expect(out!.title).toBe('Distribution: Seed the launch thread');
    expect(out!.redditTitles).toBe(1);

    const settings = JSON.parse(out!.settings as string);
    // header title cleaned...
    expect(settings.subreddit[0].value.title).toBe('Distribution: Seed the launch thread');
    // ...while every other header field survives verbatim
    expect(settings.subreddit[0].value.subreddit).toBe('webdev');
    expect(settings.subreddit[0].value.type).toBe('self');
    expect(settings.subreddit[0].value.is_flair_required).toBe(false);
    expect(settings.themeKey).toBe('w1:foundations');
  });

  it('cleans a leaked reddit header even when Post.title is already clean', () => {
    const out = cleanPost(
      'Distribution: Seed the launch thread',
      redditSettings('W2 - Distribution: Seed the launch thread')
    );
    expect(out).not.toBeNull();
    expect(out!.title).toBe('Distribution: Seed the launch thread'); // unchanged
    expect(out!.redditTitles).toBe(1);
    expect(JSON.parse(out!.settings as string).subreddit[0].value.title).toBe(
      'Distribution: Seed the launch thread'
    );
  });

  it('returns null when a reddit row is already fully clean', () => {
    expect(
      cleanPost('Distribution: Seed the launch thread', redditSettings('Distribution: Seed the launch thread'))
    ).toBeNull();
  });

  it('fixes the title but never rewrites unparseable settings', () => {
    const out = cleanPost('W3 - Density: Daily replies', 'not-json{');
    expect(out).toEqual({
      title: 'Density: Daily replies',
      settings: null,
      redditTitles: 0,
    });
  });

  it('returns null for a clean title with unparseable settings', () => {
    expect(cleanPost('Density: Daily replies', 'not-json{')).toBeNull();
  });

  it('handles a null title (only the reddit header needs cleaning)', () => {
    const out = cleanPost(null, redditSettings('W1 - Foundations: X'));
    expect(out).not.toBeNull();
    expect(out!.title).toBeNull();
    expect(out!.redditTitles).toBe(1);
    expect(JSON.parse(out!.settings as string).subreddit[0].value.title).toBe('Foundations: X');
  });

  it('returns null for a null title with clean settings', () => {
    expect(cleanPost(null, '{"__type":"x"}')).toBeNull();
  });

  it('cleans multiple subreddit header entries and counts each changed one', () => {
    const settings = JSON.stringify({
      __type: 'reddit',
      subreddit: [
        { value: { subreddit: 'a', title: 'W1 - One' } },
        { value: { subreddit: 'b', title: 'Already clean' } },
        { value: { subreddit: 'c', title: 'Week 2 – Two' } },
      ],
    });
    const out = cleanPost('W1 - One', settings);
    expect(out).not.toBeNull();
    expect(out!.redditTitles).toBe(2); // entry b was already clean
    const parsed = JSON.parse(out!.settings as string);
    expect(parsed.subreddit.map((s: any) => s.value.title)).toEqual([
      'One',
      'Already clean',
      'Two',
    ]);
  });

  it('treats null settings as empty and only touches the title', () => {
    const out = cleanPost('W1 - Foundations: X', null);
    expect(out).toEqual({ title: 'Foundations: X', settings: null, redditTitles: 0 });
  });
});

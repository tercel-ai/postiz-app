import { describe, it, expect } from 'vitest';
import { titleFromSettings } from '../settings-title';

// Real settings blobs, copied from production rows.
const REDDIT_SETTINGS = {
  __type: 'reddit',
  subreddit: [
    {
      value: {
        subreddit: 'football',
        title:
          'Tactical Deep-Dive: How Luis de la Fuente turned Spain into the most defensively stifling team in World Cup history',
        type: 'self',
        is_flair_required: false,
      },
    },
  ],
};

describe('titleFromSettings', () => {
  // The regression this module exists for: Reddit keeps its title nested per
  // community, so reading settings.title alone returned nothing and the post
  // reached the extension titleless.
  it('reads the reddit title out of subreddit[0].value', () => {
    expect(titleFromSettings('reddit', REDDIT_SETTINGS)).toBe(
      'Tactical Deep-Dive: How Luis de la Fuente turned Spain into the most defensively stifling team in World Cup history'
    );
  });

  it('reads the lemmy title from the same nested shape', () => {
    expect(
      titleFromSettings('lemmy', {
        subreddit: [{ value: { subreddit: 'tech', title: 'Lemmy headline' } }],
      })
    ).toBe('Lemmy headline');
  });

  it('reads a top-level title for the article platforms', () => {
    for (const platform of ['devto', 'medium', 'hackernews', 'hashnode']) {
      expect(titleFromSettings(platform, { title: `${platform} headline` })).toBe(
        `${platform} headline`
      );
    }
  });

  // The platform argument is what the caller persisted; several internal
  // callers only carry it in settings.__type.
  it('falls back to settings.__type when no platform is passed', () => {
    expect(titleFromSettings(undefined, REDDIT_SETTINGS)).toContain('Tactical Deep-Dive');
  });

  it('is case-insensitive about the platform name', () => {
    expect(titleFromSettings('Reddit', REDDIT_SETTINGS)).toContain('Tactical Deep-Dive');
  });

  // A hand-shaped body may put it top-level even on a community platform —
  // an unexpected title beats a titleless post.
  it('falls back to a top-level title on a community platform', () => {
    expect(titleFromSettings('reddit', { title: 'top level' })).toBe('top level');
  });

  it('prefers the nested community title over a top-level one', () => {
    expect(
      titleFromSettings('reddit', { ...REDDIT_SETTINGS, title: 'top level' })
    ).toContain('Tactical Deep-Dive');
  });

  it('returns undefined when there is no usable title', () => {
    expect(titleFromSettings('reddit', {})).toBeUndefined();
    expect(titleFromSettings('x', { title: '' })).toBeUndefined();
    expect(titleFromSettings('x', { title: '   ' })).toBeUndefined();
    expect(titleFromSettings('reddit', { subreddit: [] })).toBeUndefined();
    expect(titleFromSettings('reddit', { subreddit: [{ value: {} }] })).toBeUndefined();
    expect(titleFromSettings('x', null)).toBeUndefined();
    expect(titleFromSettings('x', undefined)).toBeUndefined();
  });

  it('ignores a non-string title rather than passing it through', () => {
    expect(titleFromSettings('x', { title: 42 as any })).toBeUndefined();
    expect(
      titleFromSettings('reddit', { subreddit: [{ value: { title: 42 as any } }] })
    ).toBeUndefined();
  });
});

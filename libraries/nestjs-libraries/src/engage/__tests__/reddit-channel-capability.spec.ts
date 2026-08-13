import { describe, expect, it } from 'vitest';
import {
  isEmptyRedditCapability,
  matchRedditFlairLabel,
  mergeRedditCapability,
  readRedditCapability,
} from '@gitroom/nestjs-libraries/engage/reddit-channel-capability';
import { REDDIT_FLAIR_MATCH_CASES } from '@gitroom/helpers/extension/reddit-flair-match-contract';

const AT = '2026-08-12T10:00:00.000Z';

describe('readRedditCapability', () => {
  it('reads a well-formed record', () => {
    expect(
      readRedditCapability({
        avatar: 'https://x/y.png',
        reddit: {
          flairs: [{ label: '📰News' }, { label: 'Discussion' }],
          flairRequired: true,
          observedAt: AT,
          source: 'extension',
        },
      })
    ).toEqual({
      flairs: [{ label: '📰News' }, { label: 'Discussion' }],
      flairRequired: true,
      observedAt: AT,
      source: 'extension',
    });
  });

  // The column is schema-less Json written by several unrelated paths, and the
  // flair list ultimately originates from DOM scraping — every shape has to
  // degrade to "not observed" instead of throwing.
  it('degrades to empty on any malformed shape', () => {
    for (const input of [
      undefined,
      null,
      'a string',
      42,
      [],
      {},
      { reddit: null },
      { reddit: 'nope' },
      { reddit: [] },
      { reddit: { flairs: 'not-an-array' } },
      { reddit: { flairRequired: 'yes' } },
      { reddit: { source: 'somewhere-else' } },
    ]) {
      expect(() => readRedditCapability(input)).not.toThrow();
      expect(readRedditCapability(input).flairRequired).toBeUndefined();
    }
  });

  it('drops unusable flair entries but keeps the usable ones', () => {
    expect(
      readRedditCapability({
        reddit: { flairs: [{ label: '  News  ' }, { label: '' }, 'x', null, { notALabel: 1 }] },
      }).flairs
    ).toEqual([{ label: 'News' }]);
  });
});

describe('mergeRedditCapability', () => {
  it('leaves non-reddit metadata keys untouched', () => {
    const merged = mergeRedditCapability(
      { description: 'd', url: 'u', avatar: 'a' },
      { flairRequired: true },
      AT
    );
    expect(merged.description).toBe('d');
    expect(merged.url).toBe('u');
    expect(merged.avatar).toBe('a');
  });

  // The list is a snapshot of what the subreddit offers right now. Union-ing
  // would keep a flair alive in the cache forever after the mods deleted it.
  it('REPLACES the stored flair list rather than merging into it', () => {
    const merged = mergeRedditCapability(
      { reddit: { flairs: [{ label: 'Old' }, { label: 'Gone' }] } },
      { flairs: [{ label: 'New' }] },
      AT
    );
    expect(readRedditCapability(merged).flairs).toEqual([{ label: 'New' }]);
  });

  // A publish that never hit a rule proves nothing about whether one exists —
  // it must not clear a `true` learned from a real rejection.
  it('treats an absent boolean as "not observed", not false', () => {
    const merged = mergeRedditCapability(
      { reddit: { flairRequired: true, titleTagRequired: true } },
      { flairs: [{ label: 'News' }] },
      AT
    );
    const read = readRedditCapability(merged);
    expect(read.flairRequired).toBe(true);
    expect(read.titleTagRequired).toBe(true);
  });

  it('overwrites a boolean when the patch states it, including with false', () => {
    const merged = mergeRedditCapability(
      { reddit: { flairRequired: true } },
      { flairRequired: false },
      AT
    );
    expect(readRedditCapability(merged).flairRequired).toBe(false);
  });

  it('keeps the previous flair list when the patch carries none', () => {
    const merged = mergeRedditCapability(
      { reddit: { flairs: [{ label: 'News' }] } },
      { flairRequired: true },
      AT
    );
    expect(readRedditCapability(merged).flairs).toEqual([{ label: 'News' }]);
  });

  it('stamps observedAt on every write and defaults source to extension', () => {
    const merged = mergeRedditCapability({}, { flairRequired: true }, AT);
    expect(readRedditCapability(merged)).toMatchObject({
      observedAt: AT,
      source: 'extension',
    });
  });

  it('survives metadata that is not an object at all', () => {
    const merged = mergeRedditCapability('garbage', { flairRequired: true }, AT);
    expect(readRedditCapability(merged).flairRequired).toBe(true);
  });
});

describe('isEmptyRedditCapability', () => {
  it('is true when nothing was observed', () => {
    expect(isEmptyRedditCapability({})).toBe(true);
    expect(isEmptyRedditCapability({ flairs: [] })).toBe(true);
    expect(isEmptyRedditCapability({ source: 'extension' })).toBe(true);
  });

  it('is false once anything was observed', () => {
    expect(isEmptyRedditCapability({ flairs: [{ label: 'News' }] })).toBe(false);
    expect(isEmptyRedditCapability({ flairRequired: false })).toBe(false);
    expect(isEmptyRedditCapability({ titleTagRequired: true })).toBe(false);
  });
});

// Must agree with selectRedditFlairInPage's matcher: whatever this accepts, the
// extension has to be able to find on the live page, or the resolution was a
// hand-off with extra steps.
describe('matchRedditFlairLabel', () => {
  // r/football's real option set (screenshot 2026-08-12).
  const FOOTBALL = [
    { label: 'No flair' },
    { label: 'Redditch United' },
    { label: '📰News' },
    { label: '⇄ Transfer News' },
  ];

  it('matches exactly, ignoring case and surrounding whitespace', () => {
    expect(matchRedditFlairLabel('  redditch UNITED ', FOOTBALL)).toEqual({
      label: 'Redditch United',
    });
  });

  it('matches across decorative emoji and symbols', () => {
    expect(matchRedditFlairLabel('News', FOOTBALL)?.label).toBe('📰News');
    expect(matchRedditFlairLabel('transfer news', FOOTBALL)?.label).toBe('⇄ Transfer News');
  });

  it('prefers an exact match over a decoration-stripped one', () => {
    const options = [{ label: '📰News' }, { label: 'News' }];
    expect(matchRedditFlairLabel('News', options)?.label).toBe('News');
  });

  // Stripping decoration can make distinct flairs collide; picking either would
  // file the post under a topic nobody chose.
  it('refuses an ambiguous decoration-stripped match', () => {
    const options = [{ label: '📰News' }, { label: '📢News' }];
    expect(matchRedditFlairLabel('News', options)).toBeNull();
  });

  it('returns null for a label the community does not offer', () => {
    expect(matchRedditFlairLabel('Growth Marketing', FOOTBALL)).toBeNull();
  });

  it('returns null when there is nothing to match against', () => {
    expect(matchRedditFlairLabel('News', [])).toBeNull();
    expect(matchRedditFlairLabel('News', undefined)).toBeNull();
    expect(matchRedditFlairLabel('', FOOTBALL)).toBeNull();
    expect(matchRedditFlairLabel(null, FOOTBALL)).toBeNull();
  });

  // The returned OPTION is what callers carry forward, so it must be Reddit's
  // own text rather than the proposed label — that is what makes the executor's
  // exact-match pass hit instead of relying on its decoration-stripping fallback.
  it("returns Reddit's own label, not the caller's spelling", () => {
    expect(matchRedditFlairLabel('news', [{ label: 'News' }])).toEqual({ label: 'News' });
  });
});

// The half of the shared contract this side owns. The SAME cases are run
// against the extension's independent copy in
// apps/extension/src/pages/background/__tests__/reddit-flair-select.spec.ts —
// see reddit-flair-match-contract.ts for why the two cannot share code and what
// silently breaks when they drift.
describe('matchRedditFlairLabel — shared flair-matching contract', () => {
  for (const c of REDDIT_FLAIR_MATCH_CASES) {
    it(c.name, () => {
      const options = c.options.map((label) => ({ label }));
      expect(matchRedditFlairLabel(c.proposed, options)?.label ?? null).toBe(c.expected);
    });
  }
});

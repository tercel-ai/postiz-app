// The flair-matching contract, written once as executable cases.
//
// Two implementations have to agree on it, and they cannot share code:
//
//   - backend  `matchRedditFlairLabel`  (nestjs-libraries/engage/reddit-channel-capability.ts)
//     resolves a generated label against a subreddit's cached option set, and
//     carries REDDIT's spelling of the winner forward into the post settings.
//   - extension `findLabel` inside `selectRedditFlairInPage`
//     (extension/pages/background/reddit.submit.tab.ts) finds that same label on
//     the live submit page. It is serialized into the page by
//     chrome.scripting.executeScript, so it MUST stay self-contained — it cannot
//     import the backend's copy, and no bundler can deduplicate them.
//
// Divergence is silent and one-directional: the backend resolves a label, writes
// it into the post, and the extension then fails to find it on the page — so the
// post is parked on a human with nothing anywhere reporting a fault. Nothing in
// the type system can catch that, and until this file existed the two test
// suites mirrored each other by hand, so editing one normalization rule left
// every test green.
//
// Both specs iterate these cases. A change to either implementation's matching
// rules must be made in both, or one of the two suites goes red.
//
// Scope note: only the shared EXACT/decoration-stripped rules live here. The
// extension's extras are deliberately out of scope — visibility (`isVisible`,
// meaningless without a DOM) and the catch-all fallback sweep (a policy the
// backend intentionally does not have). Every case below therefore uses options
// that are all visible and passes no fallback labels.

export interface RedditFlairMatchCase {
  /** Test name, used verbatim as the `it(...)` title on both sides. */
  name: string;
  /** The generated label being resolved. */
  proposed: string;
  /** The subreddit's full option set, in Reddit's own spelling. */
  options: string[];
  /** Reddit's spelling of the expected winner, or null when nothing may match. */
  expected: string | null;
}

export const REDDIT_FLAIR_MATCH_CASES: RedditFlairMatchCase[] = [
  {
    name: 'matches identical text',
    proposed: 'Discussion',
    options: ['News', 'Discussion'],
    expected: 'Discussion',
  },
  {
    name: 'ignores case',
    proposed: 'dIsCuSsIoN',
    options: ['News', 'Discussion'],
    expected: 'Discussion',
  },
  {
    name: 'collapses surrounding and inner whitespace',
    proposed: '  Weekly   Thread  ',
    options: ['Weekly Thread'],
    expected: 'Weekly Thread',
  },
  // r/football renders its options as "📰News" and "⇄ Transfer News"; a
  // generated label never carries the decoration, so whole-text matching alone
  // misses every such flair.
  {
    name: 'matches across a leading emoji',
    proposed: 'News',
    options: ['Redditch United', '📰News'],
    expected: '📰News',
  },
  {
    name: 'matches across a leading symbol and its spacing',
    proposed: 'Transfer News',
    options: ['📰News', '⇄ Transfer News'],
    expected: '⇄ Transfer News',
  },
  {
    name: 'prefers an exact match over a decoration-stripped one',
    proposed: 'News',
    options: ['📰News', 'News'],
    expected: 'News',
  },
  // Stripping decoration can make two distinct flairs collide. Picking either
  // would file the post under a topic nobody chose, so neither is picked.
  {
    name: 'refuses an ambiguous decoration-stripped match',
    proposed: 'News',
    options: ['📰News', '📢News'],
    expected: null,
  },
  {
    name: 'refuses a label the community does not offer',
    proposed: 'Growth Marketing',
    options: ['Redditch United', '📰News', '⇄ Transfer News'],
    expected: null,
  },
  // A label that is nothing BUT decoration normalizes to empty, which must not
  // be treated as "matches everything".
  {
    name: 'refuses a proposed label that is only decoration',
    proposed: '📰',
    options: ['📰News', 'Discussion'],
    expected: null,
  },
  {
    name: 'refuses an empty proposed label',
    proposed: '',
    options: ['News', 'Discussion'],
    expected: null,
  },
  {
    name: 'refuses any label when the community offers no options',
    proposed: 'News',
    options: [],
    expected: null,
  },
];

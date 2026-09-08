import { describe, it, expect } from 'vitest';
import {
  postSearchText,
  scorePost,
  matchKeywordStrength,
  RawPost,
} from '../engage-scorer';
import type { EngageKeyword } from '@prisma/client';

// Test fixtures
function makeKeyword(
  keyword: string,
  type: 'CORE' | 'BRAND' | 'COMPETITOR' = 'CORE',
  enabled = true
): Pick<EngageKeyword, 'keyword' | 'type' | 'enabled'> {
  return { keyword, type, enabled };
}

function makePost(overrides: Partial<RawPost> = {}): RawPost {
  return {
    id: 'x_1',
    platform: 'x',
    externalPostId: '1',
    externalPostUrl: 'https://x.com/u/status/1',
    authorUsername: 'u',
    postContent: 'AI tooling is great',
    postPublishedAt: new Date(),
    metricLikes: 0,
    metricReplies: 0,
    metricRetweets: 0,
    metricQuotes: 0,
    metricScore: 0,
    metricComments: 0,
    ...overrides,
  };
}

describe('title is part of the text every keyword is matched against', () => {
  // Scanners used to concatenate the title into postContent, so reading the
  // body alone saw everything. Now that the title is its own column, a post
  // whose keyword appears ONLY in the title (a Reddit/HN link submission has
  // no body at all) must still qualify — otherwise splitting the field would
  // silently stop those posts from ever becoming opportunities.
  const kw = [makeKeyword('apcore')];

  it('scores a post whose keyword appears only in the title', () => {
    const post = makePost({
      platform: 'reddit',
      title: 'apcore vs MCP: which runtime governs tool calls?',
      postContent: '',
    });
    expect(scorePost(post, kw)).not.toBeNull();
  });

  it('still rejects a post that mentions the keyword in neither field', () => {
    const post = makePost({ title: 'Weekend reading', postContent: 'unrelated' });
    expect(scorePost(post, kw)).toBeNull();
  });

  describe('postSearchText', () => {
    it('puts the title first, on its own line', () => {
      expect(postSearchText({ title: 'Q?', postContent: 'A.' })).toBe('Q?\nA.');
    });

    it('falls back to the body alone on a title-less platform', () => {
      expect(postSearchText({ postContent: 'just a tweet' })).toBe('just a tweet');
    });

    it('returns the title alone when the body is empty (link post)', () => {
      expect(postSearchText({ title: 'headline', postContent: '' })).toBe('headline');
    });
  });
});

describe('engage-scorer', () => {
  describe('postMatchesKeyword — CJK keywords (fix #9)', () => {
    it('matches a Chinese-only keyword inside Chinese content', () => {
      const post = makePost({ postContent: '我们是GEO专家团队' });
      const result = scorePost(post, [makeKeyword('专家')]);
      expect(result).not.toBeNull();
      expect(result!.scoreKeyword).toBeGreaterThan(0);
    });

    it('does NOT match ASCII keyword against unrelated substring (e.g. "AI" in "rail")', () => {
      const post = makePost({ postContent: 'I rode the rail to work' });
      const result = scorePost(post, [makeKeyword('AI')]);
      expect(result).toBeNull();
    });

    it('matches ASCII keyword with proper word boundary', () => {
      const post = makePost({ postContent: 'AI tooling is great' });
      const result = scorePost(post, [makeKeyword('AI')]);
      expect(result).not.toBeNull();
    });

    it('matches mixed CJK keyword like "SEO媒体" against the same string', () => {
      const post = makePost({ postContent: '推荐一些SEO媒体平台' });
      const result = scorePost(post, [makeKeyword('SEO媒体')]);
      expect(result).not.toBeNull();
    });

    it('CJK keyword does NOT match when content uses different chars', () => {
      const post = makePost({ postContent: '我是个工程师' });
      const result = scorePost(post, [makeKeyword('专家')]);
      expect(result).toBeNull();
    });
  });

  describe('postMatchesKeyword — hyphenated spelling of a multi-word keyword', () => {
    // A Quora scan for "open source AI" returned ten answers, six on-topic, but
    // only the two that used a literal space survived — "open-source AI" was
    // rejected four times over on the hyphen alone. The platform search that
    // surfaced the post treats the two spellings as one phrase; so must this.
    const kw = [makeKeyword('open source AI')];

    it.each([
      ['open source AI', 'There are no open source AI only projects'],
      ['open-source AI', 'DeepSeek is an open-source AI model'],
      ['Open-Source AI', 'What are some Open-Source AI chatbots?'],
      ['open_source AI', 'tagged open_source AI in the repo'],
      ['open — source AI', 'the open — source AI debate'],
    ])('matches the %s spelling', (_label, content) => {
      expect(scorePost(makePost({ postContent: content }), kw)).not.toBeNull();
    });

    it.each([
      ['a different noun', 'Why did Google open source TensorFlow?'],
      ['a different verb form', 'By open sourcing AI, OpenAI helps a little'],
      ['the words out of order', 'Grok is open-source, and it is an AI'],
    ])('still rejects %s', (_label, content) => {
      expect(scorePost(makePost({ postContent: content }), kw)).toBeNull();
    });

    it('does not let the joiner leak across a word boundary', () => {
      // "\b" must still anchor both ends: no matching inside a longer token.
      const post = makePost({ postContent: 'reopen-source AIs' });
      expect(scorePost(post, kw)).toBeNull();
    });
  });

  describe('matchKeywordStrength — loose (same-root inflection) matches', () => {
    // The motivating case: a LinkedIn search for "ai agents" surfaces posts
    // that only ever write "AI agent" (singular) — on-topic, and rejecting it
    // outright was dropping most of a keyword's real hits.
    it('matches the singular form of a plural keyword — "loose"', () => {
      expect(matchKeywordStrength('Your AI agent remembers things', 'ai agents')).toBe(
        'loose'
      );
    });

    it('matches the plural form of a singular keyword — "loose"', () => {
      expect(matchKeywordStrength('AI agents are everywhere now', 'ai agent')).toBe(
        'loose'
      );
    });

    it('matches verb inflections of the last word — governs/governing/governed', () => {
      expect(matchKeywordStrength('who governs this system', 'govern')).toBe('loose');
      expect(matchKeywordStrength('governing the rollout', 'govern')).toBe('loose');
      expect(matchKeywordStrength('AI was governed by policy', 'govern')).toBe(
        'loose'
      );
    });

    it('does NOT match the -ance/-ation/-ion derivational forms (cut for safety)', () => {
      // Dropped deliberately: the same stem-then-suffix mechanism that let
      // "govern" match "governance" also let "rate" match "ration" (via the
      // "rat" stem + "ion") — a derived form's stem collides with unrelated
      // real words far more often than a plain plural/tense stem does. See
      // the "does not misfire on short words" block below for that case.
      expect(matchKeywordStrength('AI governance is a big topic', 'govern')).toBeNull();
      expect(matchKeywordStrength('under EU regulation now', 'regulate')).toBeNull();
    });

    it('does not misfire on short words whose stem collides with a real word', () => {
      // "rate" → stem "rat" → "rat" + "ion" used to match "ration", a
      // completely unrelated word. "use" → stem "us" → the bare stem "us" is
      // already a real, unrelated word on its own. Below LOOSE_MIN_WORD_LENGTH,
      // these keywords only ever match their own exact phrase.
      expect(matchKeywordStrength('military ration packs', 'rate')).toBeNull();
      expect(matchKeywordStrength('let us know what you think', 'use')).toBeNull();
      // The exact phrase itself is unaffected.
      expect(matchKeywordStrength('what is the rate today', 'rate')).toBe('exact');
    });

    it('the exact phrase itself still scores "exact", not "loose"', () => {
      expect(matchKeywordStrength('AI agents are everywhere', 'ai agents')).toBe(
        'exact'
      );
    });

    it('only widens the LAST word — "open sourcing AI" still does not hit "open source AI"', () => {
      // Same fixture as the hyphenation suite above: "source" is not the last
      // word, so it stays literal even under loose matching.
      expect(
        matchKeywordStrength('By open sourcing AI, OpenAI helps', 'open source AI')
      ).toBeNull();
    });

    it('does not loosen a single-word ALL-CAPS keyword (looks like an abbreviation)', () => {
      // "AI" has vowels but is short and all-caps as configured; inflecting it
      // ("AIs", "AIing") is meaningless noise, not a real widening.
      expect(matchKeywordStrength('nothing relevant here', 'AI')).toBeNull();
    });

    it('does not loosen a short vowel-less keyword like "mcp"', () => {
      expect(matchKeywordStrength('completely unrelated post', 'mcp')).toBeNull();
    });

    it('rejects unrelated content entirely', () => {
      expect(matchKeywordStrength('a totally different topic', 'ai agents')).toBeNull();
    });
  });

  describe('matchKeywordStrength — abbreviation/expansion equivalents (score as "exact")', () => {
    it('a bare acronym keyword matches its spelled-out form in content', () => {
      expect(
        matchKeywordStrength(
          'We integrated with the Model Context Protocol today',
          'mcp'
        )
      ).toBe('exact');
    });

    it('a spelled-out keyword matches a bare acronym in content (auto-derived)', () => {
      expect(
        matchKeywordStrength('Our agent now speaks MCP', 'model context protocol')
      ).toBe('exact');
    });

    it('is case-insensitive and works through scorePost end to end', () => {
      const post = makePost({ postContent: 'Announcing our new MCP server' });
      const result = scorePost(post, [makeKeyword('Model Context Protocol')]);
      expect(result).not.toBeNull();
      expect(result!.scoreKeyword).toBe(15); // full exact-match weight, not the loose discount
    });

    it('does not match an unrelated acronym-shaped word', () => {
      expect(matchKeywordStrength('ask the DBA about this', 'mcp')).toBeNull();
    });

    it('does NOT auto-derive a 2-letter acronym from a 2-word keyword', () => {
      // "open source" → "os" would otherwise count ANY mention of an
      // operating system as an exact hit for "open source" — a 2-letter
      // acronym collides with real short words far too often to be safe.
      // The exact phrase itself is unaffected.
      expect(
        matchKeywordStrength('Windows is a popular OS choice', 'open source')
      ).toBeNull();
      expect(
        matchKeywordStrength('this is fully open source', 'open source')
      ).toBe('exact');
    });

    it('does not auto-derive a 3-letter acronym that collides with a common word', () => {
      // STOP_ACRONYMS backstop: even at 3+ words, an acronym that happens to
      // spell out an ordinary word must not become a silent exact-match
      // trigger for that word everywhere it appears.
      expect(
        matchKeywordStrength('the weather is nice today', 'total hardware efficiency')
      ).toBeNull();
    });
  });

  describe('computeKeywordScore — loose hits score roughly half of an exact hit', () => {
    it('a loose-only hit scores less than the same keyword matched exactly', () => {
      const exact = scorePost(
        makePost({ postContent: 'AI agents are everywhere' }),
        [makeKeyword('ai agents')]
      )!;
      const loose = scorePost(
        makePost({ postContent: 'Your AI agent remembers things' }),
        [makeKeyword('ai agents')]
      )!;
      expect(exact.scoreKeyword).toBe(15);
      expect(loose.scoreKeyword).toBe(7);
      expect(loose.scoreKeyword).toBeLessThan(exact.scoreKeyword);
    });
  });

  describe('computeKeywordScore — BRAND/COMPETITOR bonus (fix #8 invariant)', () => {
    it('grants +5 bonus only when type is exactly "BRAND"', () => {
      const post = makePost({ postContent: 'I love AISEE' });
      const result = scorePost(post, [makeKeyword('AISEE', 'BRAND')]);
      expect(result).not.toBeNull();
      // base = min(1*15, 35) = 15; brand +5 = 20
      expect(result!.scoreKeyword).toBe(20);
    });

    it('grants +3 bonus only when type is exactly "COMPETITOR"', () => {
      const post = makePost({ postContent: 'Comparing Ahrefs and SEMrush' });
      const result = scorePost(post, [makeKeyword('Ahrefs', 'COMPETITOR')]);
      expect(result).not.toBeNull();
      expect(result!.scoreKeyword).toBe(18);
    });

    it('returns null when no enabled keyword hits', () => {
      const post = makePost({ postContent: 'unrelated content' });
      const result = scorePost(post, [makeKeyword('AISEE', 'BRAND', false)]);
      expect(result).toBeNull();
    });
  });

  describe('matchedKeywords — the enabled keywords actually hit', () => {
    it('reports only the enabled keywords present in the content', () => {
      const post = makePost({ postContent: 'Best GEO and SEO tools for 2026' });
      const result = scorePost(post, [
        makeKeyword('GEO'),
        makeKeyword('SEO'),
        makeKeyword('PPC'), // not in content
        makeKeyword('disabled', null, false), // disabled → never counts
      ]);
      expect(result).not.toBeNull();
      expect(result!.matchedKeywords).toEqual(['GEO', 'SEO']);
    });
  });

  describe('scoreHeat — per-platform branch routing', () => {
    // Build a post that hits the keyword "GEO" with every metric explicit (0 by
    // default) so each heat formula reads defined numbers, not undefined → NaN.
    function metricPost(platform: string, m: Partial<RawPost> = {}): RawPost {
      return makePost({
        platform,
        postContent: 'GEO matters',
        metricLikes: 0,
        metricReplies: 0,
        metricRetweets: 0,
        metricQuotes: 0,
        metricBookmarks: 0,
        metricViews: 0,
        metricShares: 0,
        metricSaves: 0,
        metricScore: 0,
        metricUpvoteRatio: 0,
        metricComments: 0,
        ...m,
      });
    }
    const heatOf = (post: RawPost) =>
      scorePost(post, [makeKeyword('GEO')])!.scoreHeat;

    it('X: sums the specified view and engagement tiers, including strict thresholds', () => {
      const score = (m: Partial<RawPost>) => heatOf(metricPost('x', m));

      expect(score({ metricViews: 0 })).toBe(4);
      expect(score({ metricViews: 301 })).toBe(8);
      expect(score({ metricViews: 1_001 })).toBe(14);
      expect(score({ metricViews: 5_001 })).toBe(21);
      expect(score({ metricViews: 20_001 })).toBe(27);
      expect(score({ metricViews: 50_001 })).toBe(32);

      expect(score({ metricLikes: 81 })).toBe(7);
      expect(score({ metricLikes: 301 })).toBe(12);
      expect(score({ metricLikes: 1_001 })).toBe(17);
      expect(score({ metricLikes: 2_001 })).toBe(22);
      expect(score({ metricLikes: 81, metricViews: 301 })).toBe(11);
    });

    it('X: weights replies, retweets, and quotes and excludes shares from x_heat', () => {
      expect(heatOf(metricPost('x', { metricReplies: 27 }))).toBe(7);
      expect(heatOf(metricPost('x', { metricRetweets: 41 }))).toBe(7);
      expect(heatOf(metricPost('x', { metricQuotes: 41 }))).toBe(7);
      expect(heatOf(metricPost('x', { metricShares: 2_001 }))).toBe(4);
    });

    it('text branch (bluesky): likes*1+replies*3+... → 400 lands in the >300 bucket (23)', () => {
      // bluesky is not "x" — proves the text branch covers all engagement platforms.
      expect(heatOf(metricPost('bluesky', { metricLikes: 400 }))).toBe(23);
    });

    it('video branch (youtube): views are weighted (200k*0.005=1000 → >800 bucket, 33)', () => {
      expect(heatOf(metricPost('youtube', { metricViews: 200_000 }))).toBe(33);
    });

    it('network branch (instagram): saves are weighted (300*4=1200 → >1000 bucket, 45)', () => {
      expect(heatOf(metricPost('instagram', { metricSaves: 300 }))).toBe(45);
    });

    it('community branch (reddit): score*upvoteRatio+comments*2 → 500 in the >400 bucket (33)', () => {
      expect(
        heatOf(metricPost('reddit', { metricScore: 500, metricUpvoteRatio: 1 }))
      ).toBe(33);
    });

    it('unknown platform falls through to the community branch', () => {
      // e.g. "discord" is in no case list → default (community) formula.
      expect(
        heatOf(metricPost('discord', { metricScore: 200, metricUpvoteRatio: 1 }))
      ).toBe(23);
    });

    it('community branch clamps a heavily-downvoted score to 0 (no negative heat)', () => {
      expect(
        heatOf(metricPost('reddit', { metricScore: -500, metricUpvoteRatio: 1 }))
      ).toBe(4);
    });
  });

  describe('scoreAuthority — caps at 15 (spec)', () => {
    const authOf = (post: RawPost) =>
      scorePost(post, [makeKeyword('AI')])!.scoreAuthority;

    it('X: >50k followers → 15 (max)', () => {
      expect(authOf(makePost({ authorFollowers: 60_000 }))).toBe(15);
    });

    it('X: small/zero followers → base 2', () => {
      expect(authOf(makePost({ authorFollowers: 500 }))).toBe(2);
    });

    it('community (reddit): authority from channelFollowers (subreddit size), >1M → 15', () => {
      expect(
        authOf(makePost({ platform: 'reddit', channelFollowers: 2_000_000 }))
      ).toBe(15);
    });

    it('community (reddit): author followers are IGNORED — only channelFollowers drives it', () => {
      // A Reddit post with a huge authorFollowers but no channel size → floor 2.
      expect(
        authOf(makePost({ platform: 'reddit', authorFollowers: 9_000_000 }))
      ).toBe(2);
    });
  });

  describe('scoreRecency — binary 24h (spec)', () => {
    const recOf = (post: RawPost) =>
      scorePost(post, [makeKeyword('AI')])!.scoreRecency;

    it('within 24h → 5', () => {
      expect(recOf(makePost({ postPublishedAt: new Date() }))).toBe(5);
    });

    it('older than 24h → 0', () => {
      const old = new Date(Date.now() - 25 * 3_600_000);
      expect(recOf(makePost({ postPublishedAt: old }))).toBe(0);
    });
  });

  describe('重点账户 bonus — scoreTracked', () => {
    const kw = [makeKeyword('AI')];

    it('no tracked flag → scoreTracked 0', () => {
      expect(scorePost(makePost(), kw)!.scoreTracked).toBe(0);
    });

    it('isFromTrackedAccount adds +5', () => {
      const base = scorePost(makePost(), kw)!.score;
      const tracked = scorePost(makePost({ isFromTrackedAccount: true }), kw)!;
      expect(tracked.scoreTracked).toBe(5);
      expect(tracked.score).toBe(base + 5);
    });
  });
});

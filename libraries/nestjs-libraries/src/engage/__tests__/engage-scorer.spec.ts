import { describe, it, expect } from 'vitest';
import { scorePost, RawPost } from '../engage-scorer';
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

    it('text branch (bluesky): likes*1+replies*3+... → 400 lands in the >300 bucket (23)', () => {
      // bluesky is not "x" — proves the text branch covers all engagement platforms.
      expect(heatOf(metricPost('bluesky', { metricLikes: 400 }))).toBe(23);
    });

    it('video branch (youtube): views are weighted (200k*0.005=1000 → >800 bucket, 33)', () => {
      expect(heatOf(metricPost('youtube', { metricViews: 200_000 }))).toBe(33);
    });

    it('text branch ignores views entirely (same 200k views on x → base 4)', () => {
      // Discriminates video from text: views only count under the video branch.
      expect(heatOf(metricPost('x', { metricViews: 200_000 }))).toBe(4);
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

    it('reddit uses the SAME author-follower curve as X (not subreddit size)', () => {
      // 60k author followers → 15 on the follower curve. Under the old
      // subreddit-size curve 60k mapped to 6, so this pins the new semantics.
      expect(
        authOf(makePost({ platform: 'reddit', authorFollowers: 60_000 }))
      ).toBe(15);
    });

    it('reddit: typical ~0-follower author → base 2', () => {
      expect(
        authOf(makePost({ platform: 'reddit', authorFollowers: 0 }))
      ).toBe(2);
      expect(
        authOf(makePost({ platform: 'reddit', authorFollowers: undefined }))
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

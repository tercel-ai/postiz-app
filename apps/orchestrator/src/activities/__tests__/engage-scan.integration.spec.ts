/**
 * Integration tests for EngageScanActivity + EngageIntentClassifierService.
 * Real network calls, no mocks.
 *
 * Required env vars (tests skip when absent):
 *   X_BEARER_TOKEN           — app-only bearer for Twitter API v2
 *   REDDIT_CLIENT_ID         — Reddit OAuth app id
 *   REDDIT_CLIENT_SECRET     — Reddit OAuth app secret
 *   ANTHROPIC_API_KEY        — (or OPENROUTER_API_KEY) for intent classification fallback
 *
 * Reddit RSS + intent classification via local NLI model always run.
 *
 * Run:
 *   pnpm vitest run apps/orchestrator/src/activities/__tests__/engage-scan.integration.spec.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { EngageScanActivity } from '../engage-scan.activity';
import { EngageIntentClassifierService } from '@gitroom/nestjs-libraries/engage/engage-intent-classifier.service';
import { getRedditToken } from '@gitroom/nestjs-libraries/engage/reddit-auth';
import type { RawPost } from '@gitroom/nestjs-libraries/engage/engage-scorer';

const TIMEOUT = 30_000;

const hasXToken = !!process.env.X_BEARER_TOKEN;
const hasRedditCreds = !!process.env.REDDIT_CLIENT_ID && !!process.env.REDDIT_CLIENT_SECRET;
const hasAiKey = !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.OPENROUTER_API_KEY);

function buildActivity(): EngageScanActivity {
  return new EngageScanActivity(
    {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any
  );
}

function printPosts(label: string, posts: RawPost[]) {
  console.log(`\n=== ${label} (${posts.length} posts) ===`);
  if (posts.length === 0) {
    console.log('  (no posts returned)');
    return;
  }
  for (const p of posts.slice(0, 5)) {
    console.log(`  [${p.platform}] @${p.authorUsername}`);
    console.log(`  url  : ${p.externalPostUrl}`);
    console.log(`  text : ${p.postContent.slice(0, 120).replace(/\n/g, ' ')}`);
    console.log(`  likes=${p.metricLikes} replies=${p.metricReplies} score=${p.metricScore}`);
    console.log('');
  }
  if (posts.length > 5) console.log(`  ... and ${posts.length - 5} more`);
}

async function printClassifications(
  classifier: EngageIntentClassifierService,
  posts: RawPost[]
) {
  if (posts.length === 0) return;
  console.log('\n--- Intent classification ---');
  const sample = posts.slice(0, 5);
  const results = await classifier.classifyBatch(
    sample.map((p) => ({ id: p.id, content: p.postContent }))
  );
  for (const p of sample) {
    const r = results[p.id];
    console.log(
      `  [${r.primaryIntent}] score=${r.intentScore.toFixed(2)} tags=${r.intentTags.join(',')} | "${p.postContent.slice(0, 80).replace(/\n/g, ' ')}"`
    );
  }
}

// ---------------------------------------------------------------------------
// Reddit RSS (public, always runs)
// ---------------------------------------------------------------------------

describe('Reddit RSS scan', () => {
  const activity = buildActivity();
  // r/javascript reliably has daily posts; r/programming search can return 0 for t=day
  const SUBREDDIT = 'javascript';
  const KEYWORD = 'javascript';
  const AUDIENCE = 2_400_000;

  it(
    'fetches and prints posts from r/javascript',
    async () => {
      const posts = await (activity as any)._searchRedditPostsViaRss(
        SUBREDDIT, KEYWORD, AUDIENCE
      );

      printPosts(`Reddit RSS r/${SUBREDDIT} q="${KEYWORD}"`, posts);

      expect(Array.isArray(posts)).toBe(true);
      // Validate shape of every returned post
      for (const p of posts) {
        expect(p.platform).toBe('reddit');
        expect(p.channelId).toBe(SUBREDDIT);
        expect(typeof p.postContent).toBe('string');
        expect(p.postPublishedAt).toBeInstanceOf(Date);
        expect(p.id).toMatch(/^reddit_/);
        expect(p.externalPostUrl).toContain('reddit.com');
      }
    },
    TIMEOUT
  );

  it(
    'returns empty array for nonexistent subreddit (404)',
    async () => {
      const posts = await (activity as any)._searchRedditPostsViaRss(
        'xyzzy_no_such_sub_99999', 'test', 0
      );
      console.log('Nonexistent sub posts:', posts.length);
      expect(posts).toEqual([]);
    },
    TIMEOUT
  );
});

// ---------------------------------------------------------------------------
// Reddit RSS + intent classification
// Uses local Xenova NLI model (no API key needed); falls back to Claude if model load fails.
// ---------------------------------------------------------------------------

describe('Reddit RSS + intent classification', () => {
  const activity = buildActivity();
  let classifier: EngageIntentClassifierService;

  beforeAll(async () => {
    classifier = new EngageIntentClassifierService();
    await classifier.onModuleInit();
  }, TIMEOUT);

  it(
    'classifies intent of real Reddit posts from r/javascript',
    async () => {
      const posts = await (activity as any)._searchRedditPostsViaRss(
        'javascript', 'javascript', 2_400_000
      );

      printPosts('Reddit RSS r/javascript q="javascript"', posts);

      if (posts.length === 0) {
        console.log('No posts returned — skipping classification step');
        return;
      }

      await printClassifications(classifier, posts);

      // Just verify classification returns valid structure
      const results = await classifier.classifyBatch(
        posts.slice(0, 3).map((p: RawPost) => ({ id: p.id, content: p.postContent }))
      );
      for (const p of posts.slice(0, 3)) {
        const r = results[p.id];
        expect(typeof r.primaryIntent).toBe('string');
        expect(Array.isArray(r.intentTags)).toBe(true);
        expect(typeof r.intentScore).toBe('number');
      }
    },
    TIMEOUT
  );
});

// ---------------------------------------------------------------------------
// Reddit OAuth (requires credentials)
// ---------------------------------------------------------------------------

describe.skipIf(!hasRedditCreds)('Reddit OAuth scan', () => {
  const activity = buildActivity();

  it(
    'acquires token and fetches posts via OAuth (falls back to RSS on 403)',
    async () => {
      const token = await getRedditToken();
      if (!token) {
        console.log('\nReddit OAuth token: null — credentials returned 403 (app may need "script" type). Testing RSS fallback path instead.');
      } else {
        console.log('\nReddit OAuth token:', token.slice(0, 8) + '...');
      }

      // _searchRedditPosts auto-falls-back to RSS when OAuth fails — always returns RawPost[]
      const posts = await (activity as any)._searchRedditPosts(
        'javascript', 'javascript', 2_400_000
      );
      printPosts(`Reddit _searchRedditPosts r/javascript (via ${token ? 'OAuth' : 'RSS fallback'})`, posts);

      expect(Array.isArray(posts)).toBe(true);
      for (const p of posts) {
        expect(p.platform).toBe('reddit');
        expect(p.id).toMatch(/^reddit_/);
        expect(typeof p.postContent).toBe('string');
      }
      if (token && posts.length > 0) {
        // OAuth path includes these fields from the JSON API
        expect(typeof posts[0].metricComments).toBe('number');
        expect(typeof posts[0].metricScore).toBe('number');
      }
    },
    TIMEOUT
  );
});

// ---------------------------------------------------------------------------
// X keyword search (requires X_BEARER_TOKEN)
// ---------------------------------------------------------------------------

describe.skipIf(!hasXToken)('X keyword search', () => {
  const activity = buildActivity();
  const TOKEN = process.env.X_BEARER_TOKEN!;

  it(
    'fetches and prints tweets for keyword "AI"',
    async () => {
      const posts = await (activity as any)._searchXByKeyword('AI', TOKEN);
      printPosts('X search q="AI"', posts);

      expect(Array.isArray(posts)).toBe(true);
      if (posts.length > 0) {
        const p = posts[0];
        expect(p.platform).toBe('x');
        expect(p.id).toMatch(/^x_/);
        expect(p.externalPostUrl).toMatch(/^https:\/\/x\.com\//);
        expect(typeof p.postContent).toBe('string');
        expect(p.postPublishedAt).toBeInstanceOf(Date);
      }
    },
    TIMEOUT
  );

  it(
    'returns empty array for invalid token (401) without throwing',
    async () => {
      const posts = await (activity as any)._searchXByKeyword('AI', 'bad-token-xyz');
      console.log('Invalid token posts:', posts.length, '(expect 0)');
      expect(posts).toEqual([]);
    },
    TIMEOUT
  );
});

// ---------------------------------------------------------------------------
// X tracked account timeline (requires X_BEARER_TOKEN)
// ---------------------------------------------------------------------------

describe.skipIf(!hasXToken)('X tracked account timeline', () => {
  const activity = buildActivity();

  beforeAll(() => {
    process.env.X_BEARER_TOKEN = process.env.X_BEARER_TOKEN;
  });

  it(
    'fetches and prints recent tweets from @OpenAI',
    async () => {
      const posts = await (activity as any)._fetchUserTweets('OpenAI', null);
      printPosts('X @OpenAI timeline', posts);

      expect(Array.isArray(posts)).toBe(true);
      if (posts.length > 0) {
        expect(posts[0].authorUsername).toBe('OpenAI');
        expect(posts[0].platform).toBe('x');
        expect(posts[0].externalPostUrl).toContain('OpenAI');
      }
    },
    TIMEOUT
  );

  it(
    'returns empty array for nonexistent account without throwing',
    async () => {
      const posts = await (activity as any)._fetchUserTweets('xyzzy_no_such_user_99999', null);
      console.log('Nonexistent account posts:', posts.length, '(expect 0)');
      expect(posts).toEqual([]);
    },
    TIMEOUT
  );

  it(
    'filters by start_time — all returned tweets should be within window',
    async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const posts = await (activity as any)._fetchUserTweets('OpenAI', since);

      console.log(`X @OpenAI last 24h: ${posts.length} tweets`);
      for (const p of posts) {
        expect(p.postPublishedAt.getTime()).toBeGreaterThanOrEqual(since.getTime() - 5_000);
      }
    },
    TIMEOUT
  );
});

// ---------------------------------------------------------------------------
// X + intent classification (requires X_BEARER_TOKEN; uses local NLI model)
// ---------------------------------------------------------------------------

describe.skipIf(!hasXToken)('X search + intent classification', () => {
  const activity = buildActivity();
  let classifier: EngageIntentClassifierService;

  beforeAll(async () => {
    classifier = new EngageIntentClassifierService();
    await classifier.onModuleInit();
  }, TIMEOUT);

  it(
    'classifies intent of real tweets for keyword "AI"',
    async () => {
      const posts = await (activity as any)._searchXByKeyword(
        'AI', process.env.X_BEARER_TOKEN!
      );

      printPosts('X search q="AI"', posts);

      if (posts.length === 0) {
        console.log('No tweets — skipping classification');
        return;
      }

      await printClassifications(classifier, posts);

      const results = await classifier.classifyBatch(
        posts.slice(0, 3).map((p: RawPost) => ({ id: p.id, content: p.postContent }))
      );
      for (const p of posts.slice(0, 3)) {
        const r = results[p.id];
        expect(typeof r.primaryIntent).toBe('string');
        expect(r.intentScore).toBeGreaterThanOrEqual(0);
      }
    },
    TIMEOUT
  );
});

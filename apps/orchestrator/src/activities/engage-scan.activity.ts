import { Injectable, Logger } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { Context } from '@temporalio/activity';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';
import { EngageIntentClassifierService } from '@gitroom/nestjs-libraries/engage/engage-intent-classifier.service';
import {
  scorePost,
  RawPost,
  ScoredPost,
} from '@gitroom/nestjs-libraries/engage/engage-scorer';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { EngageKeyword, Prisma } from '@prisma/client';
import { getRedditToken, redditAuthHeaders } from '@gitroom/nestjs-libraries/engage/reddit-auth';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

const OPPORTUNITY_TTL_DAYS = Number(process.env.ENGAGE_OPPORTUNITY_TTL_DAYS ?? 7);
const MIN_SCORE = 60;
const X_SEARCH_DELAY_MS = 1000;
const REDDIT_SEARCH_DELAY_MS = 500;

const REDDIT_BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.reddit.com/',
};

// Derived from the repository method so the type stays in sync automatically.
type OrgContext = Awaited<ReturnType<EngageRepository['getAllEnabledOrgContexts']>>[number];

// Batch keyword texts into X API OR queries, respecting the 480-char soft limit.
function batchKeywordsForX(keywords: string[]): string[] {
  const batches: string[] = [];
  let current: string[] = [];
  let len = 0;
  for (const kw of keywords) {
    const part = current.length ? ` OR ${kw}` : kw;
    if (current.length > 0 && len + part.length > 480) {
      batches.push(current.length === 1 ? current[0] : `(${current.join(' OR ')})`);
      current = [kw];
      len = kw.length;
    } else {
      current.push(kw);
      len += part.length;
    }
  }
  if (current.length) {
    batches.push(current.length === 1 ? current[0] : `(${current.join(' OR ')})`);
  }
  return batches;
}

// X enforces the original tweet's reply_settings on API replies. Any restricted
// value means our reply account almost certainly cannot reply, so such tweets are
// dropped at scan time rather than surfaced as opportunities the user can only
// fail to reply to.
//
// Per the X API v2 docs the *returned* tweet field uses different strings than the
// *create-post* request parameter — a documented naming inconsistency:
//   returned (Data Dictionary): 'everyone' | 'mentioned_users' | 'followers'
//   request  (Create Post):     'following' | 'mentionedUsers' | 'subscribers' | 'verified'
// 'everyone' is the only "open to all" value and is identical on both sides, so we
// whitelist it (and an absent value, which defaults to 'everyone') and drop
// everything else. A whitelist is deliberate: a blocklist of the request-side
// strings would let the differently-spelled returned values slip through.
function isXReplyable(replySettings?: string): boolean {
  return !replySettings || replySettings.toLowerCase() === 'everyone';
}

// Max concurrent upserts per phase in _persistOpportunities. The posts array is
// unbounded (union of all matched posts across keywords/subreddits) and persist
// runs once per enabled org, so an un-chunked Promise.all can exhaust the Prisma
// connection pool on a busy scan. Chunking caps in-flight queries.
const PERSIST_BATCH_SIZE = 25;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function deduplicatePosts(posts: RawPost[]): RawPost[] {
  const seen = new Set<string>();
  return posts.filter((p) => {
    const key = `${p.platform}:${p.externalPostId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

@Injectable()
@Activity()
export class EngageScanActivity {
  private readonly logger = new Logger(EngageScanActivity.name);

  constructor(
    private _engageRepository: EngageRepository,
    private _intentClassifier: EngageIntentClassifierService,
    private _integration: PrismaRepository<'integration'>,
    private _opportunity: PrismaRepository<'engageOpportunity'>,
    private _oppState: PrismaRepository<'engageOpportunityState'>,
    private _keyword: PrismaRepository<'engageKeyword'>,
    private _trackedAccount: PrismaRepository<'engageTrackedAccount'>,
    private _channel: PrismaRepository<'engageMonitoredChannel'>,
    private _tx: PrismaTransaction
  ) {}

  private _heartbeat(progress?: unknown): void {
    try {
      Context.current().heartbeat(progress);
    } catch {
      // Not running inside a Temporal activity context (e.g. unit tests).
    }
  }

  // ─── Global keyword scan (X + Reddit global) ─────────────────────────────

  @ActivityMethod()
  async runGlobalKeywordScan(): Promise<void> {
    const orgContexts = await this._engageRepository.getAllEnabledOrgContexts();
    if (!orgContexts.length) return;

    const globalKeywordTexts = new Set<string>();
    for (const ctx of orgContexts) {
      for (const kw of ctx.keywords) globalKeywordTexts.add(kw.keyword);
    }
    if (!globalKeywordTexts.size) return;

    const keywords = Array.from(globalKeywordTexts);
    const xToken = await this._findAnyXToken(orgContexts);
    if (!xToken) {
      this.logger.warn(
        `X global scan skipped: no usable X token across ${orgContexts.length} org(s)`
      );
    }

    const [xPosts, redditPosts] = await Promise.all([
      xToken ? this._scanXPlatformGlobal(xToken, keywords) : Promise.resolve<RawPost[]>([]),
      this._scanRedditGlobal(keywords),
    ]);

    const allRaw = deduplicatePosts([...xPosts, ...redditPosts]);
    if (allRaw.length) {
      await Promise.all(orgContexts.map((ctx) => this._fanOutToOrg(ctx, allRaw)));
    }
    // Always expire stale opportunities regardless of scan yield.
    await Promise.all(orgContexts.map((ctx) => this._expireStaleOpportunities(ctx.organizationId)));
    await this._finalizeAllOrgs(orgContexts);
  }

  // ─── Global monitored-channel scan (Reddit subreddits × keywords) ─────────

  @ActivityMethod()
  async runGlobalChannelScan(): Promise<void> {
    const orgContexts = await this._engageRepository.getAllEnabledOrgContexts();
    if (!orgContexts.length) return;

    const globalKeywordTexts = new Set<string>();
    const globalSubreddits = new Map<string, number>(); // subredditId → max audienceSize

    for (const ctx of orgContexts) {
      for (const kw of ctx.keywords) globalKeywordTexts.add(kw.keyword);
      for (const ch of ctx.monitoredChannels) {
        if (ch.platform !== 'reddit') continue;
        const current = globalSubreddits.get(ch.channelId) ?? 0;
        if (ch.audienceSize > current) globalSubreddits.set(ch.channelId, ch.audienceSize);
      }
    }

    if (!globalSubreddits.size || !globalKeywordTexts.size) return;

    const keywords = Array.from(globalKeywordTexts);
    const allRaw = deduplicatePosts(
      await this._scanMonitoredChannelsGlobal(globalSubreddits, keywords)
    );

    if (allRaw.length) {
      await Promise.all(orgContexts.map((ctx) => this._fanOutToOrg(ctx, allRaw)));
    }
    // Always expire stale opportunities regardless of scan yield.
    await Promise.all(orgContexts.map((ctx) => this._expireStaleOpportunities(ctx.organizationId)));
    await this._updateAllChannelsLastScannedAt(orgContexts.map((c) => c.organizationId));
    await this._finalizeAllOrgs(orgContexts);
  }

  @ActivityMethod()
  async runGlobalTrackedAccountsScan(): Promise<void> {
    const orgContexts = await this._engageRepository.getAllEnabledOrgContexts();
    if (!orgContexts.length) return;

    // username (lowercase) → all account records across orgs
    const globalAccounts = new Map<string, Array<{ id: string; orgId: string }>>();
    for (const ctx of orgContexts) {
      for (const acc of ctx.trackedAccounts) {
        const key = acc.username.toLowerCase();
        const records = globalAccounts.get(key) ?? [];
        records.push({ id: acc.id, orgId: ctx.organizationId });
        globalAccounts.set(key, records);
      }
    }

    if (!globalAccounts.size) return;

    // Fetch each unique username once.
    const results = new Map<
      string,
      { posts: RawPost[]; profile?: { picture?: string; displayName?: string } }
    >();
    for (const [username, accountRecords] of globalAccounts) {
      this._heartbeat({ stage: 'tracked_fetch_global', username });
      try {
        const result = await this._fetchUserTweets(username);
        results.set(username, result);
        // Update profile/lastCheckedAt for all records of this username.
        for (const record of accountRecords) {
          await this._updateTrackedAccountAfterScan(record.id, result.profile);
        }
      } catch (err) {
        this.logger.warn(
          `Failed to fetch tweets for @${username}: ${(err as Error).message}`
        );
      }
      await sleep(X_SEARCH_DELAY_MS);
    }

    // Fan-out per org.
    await Promise.all(
      orgContexts.map(async (ctx) => {
        const orgPosts: RawPost[] = [];
        for (const acc of ctx.trackedAccounts) {
          const result = results.get(acc.username.toLowerCase());
          if (!result?.posts.length) continue;
          orgPosts.push(...result.posts.map((p) => ({ ...p, isFromTrackedAccount: true })));
        }

        if (orgPosts.length) {
          const scored = orgPosts
            .map((p) => scorePost(p, ctx.keywords))
            .filter((p): p is ScoredPost => p !== null && p.score >= MIN_SCORE);
          if (scored.length) {
            const classified = await this._classifyIntents(scored);
            await this._persistOpportunities(ctx.organizationId, classified);
            await this._updateKeywordHitCounts(ctx.organizationId, classified, ctx.keywords);
          }
        }

        await this._expireStaleOpportunities(ctx.organizationId);
        await this._engageRepository.saveConfig(ctx.organizationId, { lastScanAt: new Date() });
      })
    );
  }

  // ─── X platform (global batch) ────────────────────────────────────────────

  private async _scanXPlatformGlobal(
    token: string,
    keywords: string[]
  ): Promise<RawPost[]> {
    const batches = batchKeywordsForX(keywords);
    const results: RawPost[] = [];
    for (const query of batches) {
      this._heartbeat({ stage: 'x_search_global', query: query.slice(0, 60) });
      try {
        const posts = await this._searchXByKeyword(query, token);
        results.push(...posts);
        await sleep(X_SEARCH_DELAY_MS);
      } catch (err) {
        this.logger.warn(
          `X global search failed for batch "${query.slice(0, 60)}…": ${(err as Error).message}`
        );
      }
    }
    this.logger.log(
      `X global scan: ${results.length} post(s) across ${batches.length} batch(es) / ${keywords.length} keyword(s)`
    );
    return results;
  }

  private async _searchXByKeyword(
    keyword: string,
    accessToken: string
  ): Promise<RawPost[]> {
    const params = new URLSearchParams({
      query: keyword,
      max_results: '50',
      'tweet.fields': 'public_metrics,author_id,created_at,text,reply_settings',
      'user.fields': 'public_metrics,name,username',
      expansions: 'author_id',
    });
    const res = await fetch(
      `https://api.twitter.com/2/tweets/search/recent?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      this.logger.warn(
        `X /tweets/search/recent returned ${res.status} for "${keyword}": ${body.slice(0, 200)}`
      );
      return [];
    }
    const json = (await res.json()) as {
      data?: Array<{
        id: string;
        text: string;
        created_at: string;
        author_id: string;
        reply_settings?: string;
        public_metrics?: {
          like_count: number;
          reply_count: number;
          retweet_count: number;
          quote_count: number;
          bookmark_count: number;
        };
      }>;
      includes?: {
        users?: Array<{
          id: string;
          username: string;
          name: string;
          public_metrics?: { followers_count: number };
        }>;
      };
    };

    const usersMap = new Map(
      (json.includes?.users ?? []).map((u) => [u.id, u])
    );
    const tweets = (json.data ?? []).filter((t) => isXReplyable(t.reply_settings));
    const dropped = (json.data?.length ?? 0) - tweets.length;
    if (dropped > 0) {
      this.logger.log(
        `X keyword "${keyword}": skipped ${dropped} reply-restricted tweet(s)`
      );
    }
    return tweets.map((tweet) => {
      const author = usersMap.get(tweet.author_id);
      return {
        id: `x_${tweet.id}`,
        platform: 'x',
        externalPostId: tweet.id,
        externalPostUrl: `https://x.com/${author?.username ?? 'i'}/status/${tweet.id}`,
        authorUsername: author?.username ?? tweet.author_id,
        authorDisplayName: author?.name,
        authorFollowers: author?.public_metrics?.followers_count,
        postContent: tweet.text,
        postPublishedAt: new Date(tweet.created_at),
        metricLikes: tweet.public_metrics?.like_count ?? 0,
        metricReplies: tweet.public_metrics?.reply_count ?? 0,
        metricRetweets: tweet.public_metrics?.retweet_count ?? 0,
        metricQuotes: tweet.public_metrics?.quote_count ?? 0,
        metricBookmarks: tweet.public_metrics?.bookmark_count ?? 0,
        metricViews: 0,
        metricShares: 0,
        metricSaves: 0,
        metricScore: 0,
        metricComments: 0,
        rawData: { tweet, author } as Record<string, unknown>,
      };
    });
  }

  // ─── Monitored channels scan (global) ─────────────────────────────────────

  private async _scanMonitoredChannelsGlobal(
    globalSubreddits: Map<string, number>,
    keywords: string[]
  ): Promise<RawPost[]> {
    const results: RawPost[] = [];
    for (const [subredditId, audienceSize] of globalSubreddits) {
      for (const keyword of keywords) {
        this._heartbeat({
          stage: 'reddit_search_global_channel',
          subreddit: subredditId,
          keyword,
        });
        try {
          const posts = await this._searchRedditPosts(subredditId, keyword, audienceSize);
          results.push(...posts);
          await sleep(REDDIT_SEARCH_DELAY_MS);
        } catch (err) {
          this.logger.warn(
            `Reddit scan failed for r/${subredditId} "${keyword}": ${(err as Error).message}`
          );
        }
      }
    }
    return results;
  }

  private async _searchRedditPosts(
    subreddit: string,
    keyword: string,
    audienceSize: number
  ): Promise<RawPost[]> {
    const token = await getRedditToken();

    if (token) {
      const url = `https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/search?q=${encodeURIComponent(keyword)}&sort=top&t=week&limit=25&restrict_sr=true`;
      const res = await fetch(url, {
        headers: redditAuthHeaders(token),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          data?: { children?: Array<{ data: Record<string, unknown> }> };
        };
        return this._parseRedditJsonPosts(json.data?.children ?? [], subreddit, audienceSize);
      }
      const body = await res.text().catch(() => '<unreadable>');
      this.logger.warn(`Reddit OAuth search ${res.status} for r/${subreddit} "${keyword}": ${body.slice(0, 200)}`);
    }

    return this._searchRedditPostsViaRss(subreddit, keyword, audienceSize);
  }

  // ─── Global Reddit post search (keyword across all subreddits) ───────────

  private async _scanRedditGlobal(keywords: string[]): Promise<RawPost[]> {
    const results: RawPost[] = [];
    for (const keyword of keywords) {
      this._heartbeat({ stage: 'reddit_global_search', keyword });
      try {
        const posts = await this._searchRedditPostsGlobal(keyword);
        results.push(...posts);
        await sleep(REDDIT_SEARCH_DELAY_MS);
      } catch (err) {
        this.logger.warn(
          `Reddit global search failed for "${keyword}": ${(err as Error).message}`
        );
      }
    }
    return results;
  }

  private async _searchRedditPostsGlobal(keyword: string): Promise<RawPost[]> {
    const token = await getRedditToken();

    if (token) {
      try {
        const url = `https://oauth.reddit.com/search?q=${encodeURIComponent(keyword)}&sort=top&t=week&limit=25&type=link`;
        const res = await fetch(url, {
          headers: redditAuthHeaders(token),
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const json = (await res.json()) as {
            data?: { children?: Array<{ data: Record<string, unknown> }> };
          };
          return this._parseRedditGlobalJsonPosts(json.data?.children ?? []);
        }
        const body = await res.text().catch(() => '<unreadable>');
        this.logger.warn(
          `Reddit OAuth global search ${res.status} for "${keyword}": ${body.slice(0, 200)}`
        );
      } catch {
        // fall through to public API
      }
    }

    try {
      const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(keyword)}&sort=top&t=week&limit=25&type=link`;
      const res = await fetch(url, {
        headers: REDDIT_BROWSER_HEADERS,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        this.logger.warn(`Reddit public global search ${res.status} for "${keyword}"`);
        return [];
      }
      const json = (await res.json()) as {
        data?: { children?: Array<{ data: Record<string, unknown> }> };
      };
      return this._parseRedditGlobalJsonPosts(json.data?.children ?? []);
    } catch (err) {
      this.logger.warn(`Reddit public global search failed for "${keyword}": ${(err as Error).message}`);
      return [];
    }
  }

  private _parseRedditGlobalJsonPosts(
    children: Array<{ data: Record<string, unknown> }>
  ): RawPost[] {
    return children
      .filter((c) => c.data.subreddit_type !== 'private')
      .map((c) => {
        const p = c.data;
        const subreddit = p.subreddit as string;
        return {
          id: `reddit_${p.id as string}`,
          platform: 'reddit',
          externalPostId: p.id as string,
          externalPostUrl: `https://www.reddit.com${p.permalink as string}`,
          channelId: subreddit,
          channelName: `r/${subreddit}`,
          authorUsername: p.author as string,
          authorFollowers: (p.subreddit_subscribers as number) ?? 0,
          postContent: `${p.title as string}${p.selftext ? '\n' + (p.selftext as string) : ''}`.trim(),
          postPublishedAt: new Date((p.created_utc as number) * 1000),
          metricLikes: 0,
          metricReplies: 0,
          metricRetweets: 0,
          metricQuotes: 0,
          metricBookmarks: 0,
          metricViews: 0,
          metricShares: 0,
          metricSaves: 0,
          metricScore: (p.score as number) ?? 0,
          metricUpvoteRatio: (p.upvote_ratio as number) ?? 0,
          metricComments: (p.num_comments as number) ?? 0,
          rawData: p,
        };
      });
  }

  private async _searchRedditPostsViaRss(
    subreddit: string,
    keyword: string,
    audienceSize: number
  ): Promise<RawPost[]> {
    const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.rss?q=${encodeURIComponent(keyword)}&sort=top&t=week&restrict_sr=on`;
    const res = await fetch(url, {
      headers: REDDIT_BROWSER_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      this.logger.warn(`Reddit RSS ${res.status} for r/${subreddit} "${keyword}"`);
      return [];
    }
    const xml = await res.text();
    return this._parseRedditRssPosts(xml, subreddit, audienceSize);
  }

  private _parseRedditJsonPosts(
    children: Array<{ data: Record<string, unknown> }>,
    subreddit: string,
    audienceSize: number
  ): RawPost[] {
    return children.map((c) => {
      const p = c.data;
      return {
        id: `reddit_${p.id as string}`,
        platform: 'reddit',
        externalPostId: p.id as string,
        externalPostUrl: `https://www.reddit.com${p.permalink as string}`,
        channelId: subreddit,
        channelName: `r/${subreddit}`,
        authorUsername: p.author as string,
        authorFollowers: audienceSize,
        postContent: `${p.title as string}${p.selftext ? '\n' + (p.selftext as string) : ''}`.trim(),
        postPublishedAt: new Date((p.created_utc as number) * 1000),
        metricLikes: 0,
        metricReplies: 0,
        metricRetweets: 0,
        metricQuotes: 0,
        metricBookmarks: 0,
        metricViews: 0,
        metricShares: 0,
        metricSaves: 0,
        metricScore: p.score as number,
        metricUpvoteRatio: p.upvote_ratio as number,
        metricComments: p.num_comments as number,
        rawData: p,
      };
    });
  }

  private _parseRedditRssPosts(xml: string, subreddit: string, audienceSize: number): RawPost[] {
    const results: RawPost[] = [];
    const itemRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let match: RegExpExecArray | null;
    const get = (tag: string, src: string) => {
      const m = src.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
    };
    while ((match = itemRegex.exec(xml)) !== null) {
      const entry = match[1];
      const link = entry.match(/<link[^>]+href="([^"]+)"/)?.[1] ?? '';
      // Derive a STABLE Reddit post id from the permalink. A time-based fallback
      // (`rss_${Date.now()}`) would change every scan, so the same post would be
      // re-inserted as a new EngageOpportunity each cycle (upsert key is
      // [platform, externalPostId]) → duplicate rows. Skip entries we can't key.
      const id = link.split('/comments/')?.[1]?.split('/')?.[0];
      const title = get('title', entry);
      const author = get('name', entry);
      const updated = get('updated', entry);
      if (!title || !id) continue;
      results.push({
        id: `reddit_${id}`,
        platform: 'reddit',
        externalPostId: id,
        externalPostUrl: link,
        channelId: subreddit,
        channelName: `r/${subreddit}`,
        authorUsername: author,
        authorFollowers: audienceSize,
        postContent: title,
        postPublishedAt: updated ? new Date(updated) : new Date(),
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
        rawData: { source: 'rss', title, link, author },
      });
    }
    return results;
  }

  // ─── Fan-out to a single org ──────────────────────────────────────────────

  private async _fanOutToOrg(ctx: OrgContext, allRaw: RawPost[]): Promise<void> {
    const orgKeywords = ctx.keywords;
    if (!orgKeywords.length) return;

    const trackedUsernames = new Set(
      ctx.trackedAccounts.map((a) => a.username.toLowerCase())
    );

    // Mark X posts from this org's tracked accounts so the scorer adds the +5 bonus.
    const orgPosts = allRaw.map((p) =>
      p.platform === 'x' && trackedUsernames.has(p.authorUsername.toLowerCase())
        ? { ...p, isFromTrackedAccount: true }
        : p
    );

    const scored = orgPosts
      .map((p) => scorePost(p, orgKeywords))
      .filter((p): p is ScoredPost => p !== null && p.score >= MIN_SCORE);

    if (scored.length) {
      const classified = await this._classifyIntents(scored);
      await this._persistOpportunities(ctx.organizationId, classified);
      await this._updateKeywordHitCounts(ctx.organizationId, classified, orgKeywords);
    }
    // Expiry runs regardless — quiet scans must not leave stale NEW opportunities alive.
    await this._expireStaleOpportunities(ctx.organizationId);
  }

  // ─── Intent classification ────────────────────────────────────────────────

  private async _classifyIntents(
    scored: ScoredPost[]
  ): Promise<ScoredPost[]> {
    const batchInput = scored.map((p) => ({
      id: p.id,
      content: p.postContent,
    }));
    const results = await this._intentClassifier.classifyBatch(batchInput);
    return scored.map((p) => ({
      ...p,
      intentTags: results[p.id]?.intentTags ?? ['discussion'],
      primaryIntent: results[p.id]?.primaryIntent ?? 'discussion',
      intentScore: results[p.id]?.intentScore ?? 0,
    }));
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private async _persistOpportunities(
    orgId: string,
    posts: ScoredPost[]
  ): Promise<void> {
    if (!posts.length) return;
    this._heartbeat({ stage: 'persist_opportunities', count: posts.length });

    // Phase 1 — upsert the global post rows (shared across all orgs). Content +
    // objective metrics/scores; status/keyword-score are org-specific (phase 2).
    // Idempotent: re-scan refreshes metrics without touching per-org state.
    // Chunked to bound concurrent upserts (see PERSIST_BATCH_SIZE).
    const opportunities: Array<{ id: string }> = [];
    for (const batch of chunk(posts, PERSIST_BATCH_SIZE)) {
      const persisted = await Promise.all(
      batch.map((post) =>
        this._opportunity.model.engageOpportunity.upsert({
          where: {
            platform_externalPostId: {
              platform: post.platform,
              externalPostId: post.externalPostId,
            },
          },
          create: {
            platform: post.platform,
            externalPostId: post.externalPostId,
            externalPostUrl: post.externalPostUrl,
            channelId: post.channelId ?? null,
            channelName: post.channelName ?? null,
            authorUsername: post.authorUsername,
            authorDisplayName: post.authorDisplayName ?? null,
            authorFollowers: post.authorFollowers ?? null,
            authorAvatarUrl: post.authorAvatarUrl ?? null,
            postContent: post.postContent,
            postPublishedAt: post.postPublishedAt,
            scoreHeat: post.scoreHeat,
            scoreAuthority: post.scoreAuthority,
            scoreRecency: post.scoreRecency,
            intentTags: post.intentTags,
            primaryIntent: post.primaryIntent,
            intentScore: post.intentScore ?? null,
            metricLikes: post.metricLikes,
            metricReplies: post.metricReplies,
            metricRetweets: post.metricRetweets,
            metricQuotes: post.metricQuotes,
            metricBookmarks: post.metricBookmarks ?? 0,
            metricViews: post.metricViews ?? 0,
            metricShares: post.metricShares ?? 0,
            metricSaves: post.metricSaves ?? 0,
            metricScore: post.metricScore,
            metricUpvoteRatio: post.metricUpvoteRatio ?? null,
            metricComments: post.metricComments,
            rawData: post.rawData != null ? (post.rawData as Prisma.InputJsonValue) : null,
          },
          update: {
            scoreHeat: post.scoreHeat,
            scoreAuthority: post.scoreAuthority,
            scoreRecency: post.scoreRecency,
            metricLikes: post.metricLikes,
            metricReplies: post.metricReplies,
            metricRetweets: post.metricRetweets,
            metricQuotes: post.metricQuotes,
            metricBookmarks: post.metricBookmarks ?? 0,
            metricViews: post.metricViews ?? 0,
            metricShares: post.metricShares ?? 0,
            metricSaves: post.metricSaves ?? 0,
            metricScore: post.metricScore,
            metricUpvoteRatio: post.metricUpvoteRatio ?? null,
            metricComments: post.metricComments,
            // intentTags / primaryIntent NOT updated — preserve original classification
          },
          select: { id: true },
        })
      )
      );
      opportunities.push(...persisted);
    }

    // Phase 2 — upsert this org's per-post state. Total score is recomputed every
    // scan (heat/authority/recency may have shifted on the global row); status and
    // bookmark are preserved across re-scans. opportunities[i] aligns with posts[i]
    // because phase 1 pushed results in order. Chunked like phase 1.
    const stateInputs = posts.map((post, i) => ({
      post,
      opportunityId: opportunities[i].id,
    }));
    for (const batch of chunk(stateInputs, PERSIST_BATCH_SIZE)) {
      await Promise.all(
        batch.map(({ post, opportunityId }) =>
          this._oppState.model.engageOpportunityState.upsert({
            where: {
              organizationId_opportunityId: {
                organizationId: orgId,
                opportunityId,
              },
            },
            create: {
              organizationId: orgId,
              opportunityId,
              status: 'NEW',
              score: post.score,
              scoreKeyword: post.scoreKeyword,
              scoreTracked: post.scoreTracked,
            },
            update: {
              score: post.score,
              scoreKeyword: post.scoreKeyword,
              scoreTracked: post.scoreTracked,
              // status / bookmarked NOT updated — preserve user state
            },
          })
        )
      );
    }
  }

  private async _updateKeywordHitCounts(
    orgId: string,
    posts: ScoredPost[],
    keywords: EngageKeyword[]
  ): Promise<void> {
    const hitMap = new Map<string, number>();
    for (const post of posts) {
      for (const kw of keywords) {
        // Use word-boundary regex for consistency with engage-scorer.ts.
        // .includes() was a substring match — "react" would match "overreacting".
        const pattern = new RegExp(`\\b${kw.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (kw.enabled && pattern.test(post.postContent)) {
          hitMap.set(kw.id, (hitMap.get(kw.id) ?? 0) + 1);
        }
      }
    }
    if (!hitMap.size) return;

    // Guard against double-counting on Temporal retry: skip keywords whose
    // lastCountedAt is within the last 5 minutes (matching the initial retry
    // backoff). Combined with maximumAttempts:1 on the activity this prevents
    // most double-count scenarios without a schema change.
    const recentCutoff = new Date(Date.now() - 5 * 60 * 1000);
    const kwIds = Array.from(hitMap.keys());
    const existing = await this._keyword.model.engageKeyword.findMany({
      where: { id: { in: kwIds } },
      select: { id: true, lastCountedAt: true },
    });
    const alreadyCounted = new Set(
      existing.filter((k) => k.lastCountedAt && k.lastCountedAt > recentCutoff).map((k) => k.id)
    );

    const now = new Date();
    const ops = Array.from(hitMap, ([kwId, hits]) => {
      if (alreadyCounted.has(kwId)) return null;
      return this._keyword.model.engageKeyword.update({
        where: { id: kwId },
        data: {
          weeklyHitCount: { increment: hits },
          totalHitCount: { increment: hits },
          lastCountedAt: now,
        },
      });
    }).filter((op): op is NonNullable<typeof op> => op !== null);

    if (ops.length) await this._tx.model.$transaction(ops);
  }

  private async _expireStaleOpportunities(orgId: string): Promise<void> {
    const cutoff = dayjs.utc().subtract(OPPORTUNITY_TTL_DAYS, 'day').toDate();
    // createdAt on the state row = when this org first matched the post.
    await this._oppState.model.engageOpportunityState.updateMany({
      where: { organizationId: orgId, status: 'NEW', createdAt: { lt: cutoff } },
      data: { status: 'EXPIRED' },
    });
  }

  private async _updateTrackedAccountAfterScan(
    id: string,
    profile?: { picture?: string; displayName?: string }
  ): Promise<void> {
    await this._trackedAccount.model.engageTrackedAccount.update({
      where: { id },
      data: {
        lastCheckedAt: new Date(),
        ...(profile?.picture && { picture: profile.picture }),
        ...(profile?.displayName && { displayName: profile.displayName }),
      },
    });
  }

  private async _updateAllChannelsLastScannedAt(orgIds: string[]): Promise<void> {
    if (!orgIds.length) return;
    await this._channel.model.engageMonitoredChannel.updateMany({
      where: { organizationId: { in: orgIds }, enabled: true },
      data: { lastScannedAt: new Date() },
    });
  }

  private async _finalizeAllOrgs(orgContexts: OrgContext[]): Promise<void> {
    const now = new Date();
    await Promise.all(
      orgContexts.map((ctx) =>
        this._engageRepository.saveConfig(ctx.organizationId, { lastScanAt: now })
      )
    );
  }

  // ─── Tracked accounts polling ─────────────────────────────────────────────

  private async _fetchUserTweets(
    username: string
  ): Promise<{
    posts: RawPost[];
    profile?: { picture?: string; displayName?: string };
  }> {
    const params = new URLSearchParams({
      max_results: '10',
      'tweet.fields': 'public_metrics,created_at,text,reply_settings',
      'user.fields': 'public_metrics',
    });
    const bearerToken = process.env.X_BEARER_TOKEN;
    if (!bearerToken) return { posts: [] };

    const userParams = new URLSearchParams({
      'user.fields': 'public_metrics,profile_image_url,name',
    });
    const userRes = await fetch(
      `https://api.twitter.com/2/users/by/username/${username}?${userParams}`,
      { headers: { Authorization: `Bearer ${bearerToken}` }, signal: AbortSignal.timeout(10_000) }
    );
    if (!userRes.ok) {
      const body = await userRes.text().catch(() => '<unreadable>');
      this.logger.warn(
        `X /users/by/username returned ${userRes.status} for @${username}: ${body.slice(0, 200)}`
      );
      return { posts: [] };
    }
    const userJson = (await userRes.json()) as {
      data?: {
        id: string;
        name?: string;
        profile_image_url?: string;
        public_metrics?: { followers_count: number };
      };
    };
    const userId = userJson.data?.id;
    if (!userId) return { posts: [] };

    const picture = userJson.data?.profile_image_url?.replace('_normal', '_400x400');
    const profile = {
      ...(picture && { picture }),
      ...(userJson.data?.name && { displayName: userJson.data.name }),
    };

    const tweetsRes = await fetch(
      `https://api.twitter.com/2/users/${userId}/tweets?${params}`,
      { headers: { Authorization: `Bearer ${bearerToken}` }, signal: AbortSignal.timeout(10_000) }
    );
    if (!tweetsRes.ok) {
      const body = await tweetsRes.text().catch(() => '<unreadable>');
      this.logger.warn(
        `X /users/${userId}/tweets returned ${tweetsRes.status} for @${username}: ${body.slice(0, 200)}`
      );
      return { posts: [], profile };
    }
    const json = (await tweetsRes.json()) as {
      data?: Array<{
        id: string;
        text: string;
        created_at: string;
        reply_settings?: string;
        public_metrics?: {
          like_count: number;
          reply_count: number;
          retweet_count: number;
          quote_count: number;
          bookmark_count: number;
        };
      }>;
    };

    const replyable = (json.data ?? []).filter((t) => isXReplyable(t.reply_settings));
    const dropped = (json.data?.length ?? 0) - replyable.length;
    if (dropped > 0) {
      this.logger.log(
        `X @${username}: skipped ${dropped} reply-restricted tweet(s)`
      );
    }
    const posts: RawPost[] = replyable.map((tweet) => ({
      id: `x_${tweet.id}`,
      platform: 'x',
      externalPostId: tweet.id,
      externalPostUrl: `https://x.com/${username}/status/${tweet.id}`,
      authorUsername: username,
      authorDisplayName: profile.displayName,
      authorAvatarUrl: profile.picture,
      authorFollowers: userJson.data?.public_metrics?.followers_count,
      postContent: tweet.text,
      postPublishedAt: new Date(tweet.created_at),
      metricLikes: tweet.public_metrics?.like_count ?? 0,
      metricReplies: tweet.public_metrics?.reply_count ?? 0,
      metricRetweets: tweet.public_metrics?.retweet_count ?? 0,
      metricQuotes: tweet.public_metrics?.quote_count ?? 0,
      metricBookmarks: tweet.public_metrics?.bookmark_count ?? 0,
      metricViews: 0,
      metricShares: 0,
      metricSaves: 0,
      metricScore: 0,
      metricComments: 0,
      rawData: { tweet, user: userJson.data } as Record<string, unknown>,
    }));
    return { posts, profile };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async _findAnyXToken(orgContexts: OrgContext[]): Promise<string | null> {
    for (const ctx of orgContexts) {
      const account = ctx.xReplyAccounts.find((a) => a.engageEnabled);
      if (!account) continue;
      const integration = await this._integration.model.integration.findUnique({
        where: { id: account.integrationId },
        select: { token: true },
      });
      if (integration?.token) {
        return this._extractOauthToken(integration.token as string | Record<string, string>);
      }
    }
    return null;
  }

  private _extractOauthToken(
    token: string | Record<string, string>
  ): string | null {
    if (typeof token === 'string') return token;
    return token.access_token ?? token.token ?? null;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

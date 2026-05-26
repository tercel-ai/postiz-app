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
import { EngageKeyword } from '@prisma/client';
import { getRedditToken, redditAuthHeaders } from '@gitroom/nestjs-libraries/engage/reddit-auth';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

const OPPORTUNITY_TTL_DAYS = Number(process.env.ENGAGE_OPPORTUNITY_TTL_DAYS ?? 7);
const MIN_SCORE = 60;
const X_SEARCH_DELAY_MS = 1000;
const REDDIT_SEARCH_DELAY_MS = 500;

@Injectable()
@Activity()
export class EngageScanActivity {
  private readonly logger = new Logger(EngageScanActivity.name);

  constructor(
    private _engageRepository: EngageRepository,
    private _intentClassifier: EngageIntentClassifierService,
    private _integration: PrismaRepository<'integration'>,
    private _opportunity: PrismaRepository<'engageOpportunity'>,
    private _keyword: PrismaRepository<'engageKeyword'>,
    private _trackedAccount: PrismaRepository<'engageTrackedAccount'>,
    private _channel: PrismaRepository<'engageMonitoredChannel'>,
    private _tx: PrismaTransaction
  ) {}

  // Emit a Temporal heartbeat when running inside the activity worker. The
  // worker may not be present in unit tests; swallow the InvalidArgumentError
  // and continue. With a configured heartbeatTimeout this lets Temporal detect
  // worker death faster than startToCloseTimeout and respect cancellation.
  private _heartbeat(progress?: unknown): void {
    try {
      Context.current().heartbeat(progress);
    } catch {
      // Not running inside a Temporal activity context (e.g. unit tests).
    }
  }

  // ─── Main scan pipeline ──────────────────────────────────────────────────

  @ActivityMethod()
  async runDailyScan(orgId: string, keywordIds?: string[]): Promise<void> {
    const config = await this._engageRepository.getOrCreateConfig(orgId);
    if (!config.enabled) return;

    const allEnabled = config.keywords.filter((k) => k.enabled);
    const enabledKeywords =
      keywordIds?.length
        ? allEnabled.filter((k) => keywordIds.includes(k.id))
        : allEnabled;
    if (!enabledKeywords.length) return;

    const [xPosts, channelPosts] = await Promise.all([
      this._scanXPlatform(orgId, config as never, enabledKeywords),
      this._scanMonitoredChannels(config as never, enabledKeywords),
    ]);

    const allRaw = [...xPosts, ...channelPosts];
    const scored = allRaw
      .map((p) => scorePost(p, enabledKeywords))
      .filter((p): p is ScoredPost => p !== null && p.score >= MIN_SCORE);

    if (!scored.length) return;

    const classified = await this._classifyIntents(scored);
    await this._persistOpportunities(orgId, classified);
    await this._updateKeywordHitCounts(orgId, classified, enabledKeywords);
    await this._expireStaleOpportunities(orgId);
    await this._engageRepository.saveConfig(orgId, { lastScanAt: new Date() });
  }

  @ActivityMethod()
  async runTrackedAccountsScan(orgId: string): Promise<void> {
    const config = await this._engageRepository.getOrCreateConfig(orgId);
    if (!config.enabled) return;

    const enabledKeywords = config.keywords.filter((k) => k.enabled);
    const enabledAccounts = config.trackedAccounts.filter((a) => a.enabled);
    if (!enabledAccounts.length) return;

    const xPosts: RawPost[] = [];
    for (const account of enabledAccounts) {
      this._heartbeat({ stage: 'tracked_fetch', username: account.username });
      try {
        const { posts, profile } = await this._fetchUserTweets(
          account.username,
          account.lastCheckedAt ?? undefined
        );
        xPosts.push(
          ...posts.map((t) => ({ ...t, isFromTrackedAccount: true }))
        );
        await this._updateTrackedAccountAfterScan(account.id, profile);
      } catch (err) {
        this.logger.warn(
          `Failed to fetch tweets for @${account.username}: ${(err as Error).message}`
        );
      }
      // Rate-limit guard: 2 API calls per account; pause to avoid bearer token exhaustion
      await sleep(X_SEARCH_DELAY_MS);
    }

    const scored = xPosts
      .map((p) => scorePost(p, enabledKeywords))
      .filter((p): p is ScoredPost => p !== null && p.score >= MIN_SCORE);

    if (scored.length > 0) {
      const classified = await this._classifyIntents(scored);
      await this._persistOpportunities(orgId, classified);
    }

    // Housekeeping runs unconditionally — independent of whether new posts scored above threshold.
    // Without this, stale NEW opportunities never expire and lastScanAt is never advanced
    // when all fetched tweets score below MIN_SCORE.
    await this._expireStaleOpportunities(orgId);
    await this._engageRepository.saveConfig(orgId, { lastScanAt: new Date() });
  }

  // ─── X platform scan ─────────────────────────────────────────────────────

  private async _scanXPlatform(
    orgId: string,
    config: {
      xReplyAccounts: Array<{
        engageEnabled: boolean;
        integrationId: string;
      }>;
    },
    keywords: EngageKeyword[]
  ): Promise<RawPost[]> {
    const searchAccount = config.xReplyAccounts.find((a) => a.engageEnabled);
    if (!searchAccount) return [];

    const integration = await this._integration.model.integration.findUnique({
      where: { id: searchAccount.integrationId },
      select: { token: true },
    });
    if (!integration?.token) return [];

    const token = this._extractOauthToken(integration.token as string | Record<string, string>);
    if (!token) return [];

    const results: RawPost[] = [];
    for (const keyword of keywords) {
      this._heartbeat({ stage: 'x_search', keyword: keyword.keyword });
      try {
        const tweets = await this._searchXByKeyword(keyword.keyword, token);
        results.push(...tweets);
        await sleep(X_SEARCH_DELAY_MS);
      } catch (err) {
        this.logger.warn(
          `X search failed for keyword "${keyword.keyword}": ${(err as Error).message}`
        );
      }
    }
    return results;
  }

  private async _searchXByKeyword(
    keyword: string,
    accessToken: string
  ): Promise<RawPost[]> {
    const params = new URLSearchParams({
      query: keyword,
      max_results: '50',
      'tweet.fields': 'public_metrics,author_id,created_at,text',
      'user.fields': 'public_metrics,name,username',
      expansions: 'author_id',
    });
    const res = await fetch(
      `https://api.twitter.com/2/tweets/search/recent?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) {
      // Differentiate API failure from "no results" — operators need a signal to
      // detect token expiry / quota exhaustion / 429 rate limiting.
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
        public_metrics?: {
          like_count: number;
          reply_count: number;
          retweet_count: number;
          quote_count: number;
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
    return (json.data ?? []).map((tweet) => {
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
        metricScore: 0,
        metricComments: 0,
      };
    });
  }

  // ─── Monitored channels scan ──────────────────────────────────────────────

  private async _scanMonitoredChannels(
    config: {
      monitoredChannels: Array<{
        id: string;
        platform: string;
        channelId: string;
        channelName: string;
        audienceSize: number;
        enabled: boolean;
      }>;
    },
    keywords: EngageKeyword[]
  ): Promise<RawPost[]> {
    const results: RawPost[] = [];
    for (const channel of config.monitoredChannels.filter((c) => c.enabled)) {
      switch (channel.platform) {
        case 'reddit': {
          let successCount = 0;
          for (const keyword of keywords) {
            this._heartbeat({
              stage: 'reddit_search',
              channel: channel.channelId,
              keyword: keyword.keyword,
            });
            try {
              const posts = await this._searchRedditPosts(
                channel.channelId,
                keyword.keyword,
                channel.audienceSize
              );
              results.push(...posts);
              successCount++;
              await sleep(REDDIT_SEARCH_DELAY_MS);
            } catch (err) {
              this.logger.warn(
                `Reddit scan failed for r/${channel.channelId}: ${(err as Error).message}`
              );
            }
          }
          // Only advance lastScannedAt if at least one fetch succeeded
          if (successCount > 0) {
            await this._updateChannelLastScannedAt(channel.id);
          }
          break;
        }
        // youtube, qq, discord: future platforms — skip for now
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
      // OAuth path — full access, proper rate limits.
      const url = `https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/search?q=${encodeURIComponent(keyword)}&sort=new&t=day&limit=25&restrict_sr=true`;
      const res = await fetch(url, { headers: redditAuthHeaders(token) });
      if (res.ok) {
        const json = (await res.json()) as {
          data?: { children?: Array<{ data: Record<string, unknown> }> };
        };
        return this._parseRedditJsonPosts(json.data?.children ?? [], subreddit, audienceSize);
      }
      const body = await res.text().catch(() => '<unreadable>');
      this.logger.warn(`Reddit OAuth search ${res.status} for r/${subreddit} "${keyword}": ${body.slice(0, 200)}`);
      // fall through to RSS
    }

    // RSS fallback — no credentials required; Reddit RSS is publicly accessible.
    return this._searchRedditPostsViaRss(subreddit, keyword, audienceSize);
  }

  private async _searchRedditPostsViaRss(
    subreddit: string,
    keyword: string,
    audienceSize: number
  ): Promise<RawPost[]> {
    const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.rss?q=${encodeURIComponent(keyword)}&sort=new&t=day&restrict_sr=on`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'AISEE-Engage/1.0' },
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
        postContent: `${p.title as string}\n${p.selftext as string}`.trim(),
        postPublishedAt: new Date((p.created_utc as number) * 1000),
        metricLikes: 0,
        metricReplies: 0,
        metricRetweets: 0,
        metricQuotes: 0,
        metricScore: p.score as number,
        metricUpvoteRatio: p.upvote_ratio as number,
        metricComments: p.num_comments as number,
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
      // Reddit Atom feed uses <link href="..." /> (no rel attribute on search results)
      const link = entry.match(/<link[^>]+href="([^"]+)"/)?.[1] ?? '';
      const id = link.split('/comments/')?.[1]?.split('/')?.[0] ?? `rss_${Date.now()}`;
      const title = get('title', entry);
      const author = get('name', entry);
      const updated = get('updated', entry);
      if (!title) continue;
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
        metricScore: 0,
        metricUpvoteRatio: 0,
        metricComments: 0,
      });
    }
    return results;
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
    // Batch all upserts in one $transaction round-trip instead of N sequential
    // awaits — keeps wall-clock independent of DB latency × row count.
    const ops = posts.map((post) =>
      this._opportunity.model.engageOpportunity.upsert({
        where: {
          organizationId_platform_externalPostId: {
            organizationId: orgId,
            platform: post.platform,
            externalPostId: post.externalPostId,
          },
        },
        create: {
          organizationId: orgId,
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
          score: post.score,
          scoreKeyword: post.scoreKeyword,
          scoreHeat: post.scoreHeat,
          scoreAuthority: post.scoreAuthority,
          scoreRecency: post.scoreRecency,
          scoreTracked: post.scoreTracked,
          intentTags: post.intentTags,
          primaryIntent: post.primaryIntent,
          intentScore: post.intentScore ?? null,
          metricLikes: post.metricLikes,
          metricReplies: post.metricReplies,
          metricRetweets: post.metricRetweets,
          metricQuotes: post.metricQuotes,
          metricScore: post.metricScore,
          metricUpvoteRatio: post.metricUpvoteRatio ?? null,
          metricComments: post.metricComments,
          status: 'NEW',
        },
        update: {
          // Refresh scoring — post may have gained engagement since last scan
          score: post.score,
          scoreKeyword: post.scoreKeyword,
          scoreHeat: post.scoreHeat,
          scoreAuthority: post.scoreAuthority,
          scoreRecency: post.scoreRecency,
          scoreTracked: post.scoreTracked,
          metricLikes: post.metricLikes,
          metricReplies: post.metricReplies,
          metricRetweets: post.metricRetweets,
          metricQuotes: post.metricQuotes,
          metricScore: post.metricScore,
          metricUpvoteRatio: post.metricUpvoteRatio ?? null,
          metricComments: post.metricComments,
          // intentTags / primaryIntent / status NOT updated — preserve user state
        },
      })
    );
    await this._tx.model.$transaction(ops);
  }

  private async _updateKeywordHitCounts(
    orgId: string,
    posts: ScoredPost[],
    keywords: EngageKeyword[]
  ): Promise<void> {
    const hitMap = new Map<string, number>();
    for (const post of posts) {
      for (const kw of keywords) {
        if (kw.enabled && post.postContent.toLowerCase().includes(kw.keyword.toLowerCase())) {
          hitMap.set(kw.id, (hitMap.get(kw.id) ?? 0) + 1);
        }
      }
    }
    if (!hitMap.size) return;
    const now = new Date();
    const ops = Array.from(hitMap, ([kwId, hits]) =>
      this._keyword.model.engageKeyword.update({
        where: { id: kwId },
        data: {
          weeklyHitCount: { increment: hits },
          totalHitCount: { increment: hits },
          lastCountedAt: now,
        },
      })
    );
    await this._tx.model.$transaction(ops);
  }

  private async _expireStaleOpportunities(orgId: string): Promise<void> {
    const cutoff = dayjs.utc().subtract(OPPORTUNITY_TTL_DAYS, 'day').toDate();
    await this._opportunity.model.engageOpportunity.updateMany({
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
        // Backfill avatar / display name from the X user lookup. Only overwrite
        // when the API actually returned a value so a transient gap can't wipe
        // a previously stored picture.
        ...(profile?.picture && { picture: profile.picture }),
        ...(profile?.displayName && { displayName: profile.displayName }),
      },
    });
  }

  private async _updateChannelLastScannedAt(id: string): Promise<void> {
    await this._channel.model.engageMonitoredChannel.update({
      where: { id },
      data: { lastScannedAt: new Date() },
    });
  }

  // ─── Tracked accounts polling ─────────────────────────────────────────────

  private async _fetchUserTweets(
    username: string,
    since?: Date | null
  ): Promise<{
    posts: RawPost[];
    profile?: { picture?: string; displayName?: string };
  }> {
    const params = new URLSearchParams({
      max_results: '10',
      'tweet.fields': 'public_metrics,created_at,text',
      'user.fields': 'public_metrics',
      ...(since && { start_time: since.toISOString() }),
    });
    // Uses app-level bearer token for read-only public timeline
    const bearerToken = process.env.X_BEARER_TOKEN;
    if (!bearerToken) return { posts: [] };

    // profile_image_url + name backfill the tracked account's avatar / display name.
    const userParams = new URLSearchParams({
      'user.fields': 'public_metrics,profile_image_url,name',
    });
    const userRes = await fetch(
      `https://api.twitter.com/2/users/by/username/${username}?${userParams}`,
      { headers: { Authorization: `Bearer ${bearerToken}` } }
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

    // X returns the 48px "_normal" variant; request the 400x400 crop for crisp UI.
    const picture = userJson.data?.profile_image_url?.replace(
      '_normal',
      '_400x400'
    );
    const profile = {
      ...(picture && { picture }),
      ...(userJson.data?.name && { displayName: userJson.data.name }),
    };

    const tweetsRes = await fetch(
      `https://api.twitter.com/2/users/${userId}/tweets?${params}`,
      { headers: { Authorization: `Bearer ${bearerToken}` } }
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
        public_metrics?: {
          like_count: number;
          reply_count: number;
          retweet_count: number;
          quote_count: number;
        };
      }>;
    };

    const posts: RawPost[] = (json.data ?? []).map((tweet) => ({
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
      metricScore: 0,
      metricComments: 0,
    }));
    return { posts, profile };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

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

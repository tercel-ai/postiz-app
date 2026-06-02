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
import { getRedditToken } from '@gitroom/nestjs-libraries/engage/reddit-auth';
import { XScanAdapter } from '@gitroom/nestjs-libraries/engage/scan/x-scan-adapter';
import { RedditScanAdapter } from '@gitroom/nestjs-libraries/engage/scan/reddit-scan-adapter';
import { TokenPool } from '@gitroom/nestjs-libraries/engage/scan/token-pool';
import {
  KEYWORD_GLOBAL_SCAN_KEY,
  PlatformScanAdapter,
  ScanCursor,
  ScanScope,
  ScanType,
} from '@gitroom/nestjs-libraries/engage/scan/platform-scan-adapter';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

const OPPORTUNITY_TTL_DAYS = Number(process.env.ENGAGE_OPPORTUNITY_TTL_DAYS ?? 7);
// Minimum total score for a scored post to become an opportunity. Lower it to
// surface more (noisier) opportunities; raise it to keep only strong matches.
const MIN_SCORE = Number(process.env.ENGAGE_MIN_SCORE ?? 60);
// Max upstream API calls per scan unit per run — caps pagination so a large
// backlog (or a runaway loop) cannot drain the rate-limit budget in one run.
const SCAN_MAX_CALLS = Number(process.env.ENGAGE_SCAN_MAX_CALLS ?? 5);
// Fallback cool-down when a platform rate-limits without a usable retry hint.
const DEFAULT_COOLDOWN_MS = Number(
  process.env.ENGAGE_SCAN_COOLDOWN_MS ?? 15 * 60 * 1000
);

// Max concurrent upserts per phase in _persistOpportunities. The posts array is
// unbounded (union of all matched posts across keywords/subreddits) and persist
// runs once per enabled org, so an un-chunked Promise.all can exhaust the Prisma
// connection pool on a busy scan. Chunking caps in-flight queries.
const PERSIST_BATCH_SIZE = 25;

// Derived from the repository method so the type stays in sync automatically.
type OrgContext = Awaited<ReturnType<EngageRepository['getAllEnabledOrgContexts']>>[number];

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

// Union of all enabled keyword texts across orgs (the scan fetches each keyword
// once, then fan-out filters per org).
function unionKeywords(ctxs: OrgContext[]): string[] {
  const s = new Set<string>();
  for (const c of ctxs) for (const k of c.keywords) s.add(k.keyword);
  return Array.from(s);
}

// Union of all monitored Reddit subreddit ids across orgs.
function unionSubreddits(ctxs: OrgContext[]): string[] {
  const s = new Set<string>();
  for (const c of ctxs)
    for (const ch of c.monitoredChannels)
      if (ch.platform === 'reddit') s.add(ch.channelId);
  return Array.from(s);
}

// Map of lowercased tracked username → the account records (with their org)
// across all orgs, so each unique username is fetched once and the result
// updates every org that tracks it.
function unionTrackedUsernames(
  ctxs: OrgContext[]
): Map<string, Array<{ id: string; orgId: string }>> {
  const m = new Map<string, Array<{ id: string; orgId: string }>>();
  for (const c of ctxs)
    for (const a of c.trackedAccounts) {
      const key = a.username.toLowerCase();
      const arr = m.get(key) ?? [];
      arr.push({ id: a.id, orgId: c.organizationId });
      m.set(key, arr);
    }
  return m;
}

@Injectable()
@Activity()
export class EngageScanActivity {
  private readonly logger = new Logger(EngageScanActivity.name);
  private readonly _xAdapter: PlatformScanAdapter = new XScanAdapter();
  private readonly _redditAdapter: PlatformScanAdapter = new RedditScanAdapter();

  constructor(
    private _engageRepository: EngageRepository,
    private _intentClassifier: EngageIntentClassifierService,
    private _integration: PrismaRepository<'integration'>,
    private _opportunity: PrismaRepository<'engageOpportunity'>,
    private _oppState: PrismaRepository<'engageOpportunityState'>,
    private _keyword: PrismaRepository<'engageKeyword'>,
    private _trackedAccount: PrismaRepository<'engageTrackedAccount'>,
    private _channel: PrismaRepository<'engageMonitoredChannel'>,
    private _tx: PrismaTransaction,
    private _scanCursor: PrismaRepository<'engageScanCursor'>
  ) {}

  private _heartbeat(progress?: unknown): void {
    try {
      Context.current().heartbeat(progress);
    } catch {
      // Not running inside a Temporal activity context (e.g. unit tests).
    }
  }

  // ─── Scan entry points (cursor-driven, adapter-backed) ───────────────────
  //
  // Each scan type resolves to one or more scan UNITS — a (platform, scanType,
  // scanKey) tuple with its own incremental cursor. A unit is fetched once
  // (keywords OR-batched into the query), deduped, then fanned out to every
  // enabled org for per-org scoring/persistence.

  @ActivityMethod()
  async runGlobalKeywordScan(): Promise<void> {
    const orgContexts = await this._engageRepository.getAllEnabledOrgContexts();
    if (!orgContexts.length) return;
    const keywords = unionKeywords(orgContexts);
    if (!keywords.length) return;

    this.logger.log(
      `Keyword scan: ${keywords.length} keyword(s) across ${orgContexts.length} org(s)`
    );
    const xPool = new TokenPool(await this._collectXTokens(orgContexts));
    const redditToken = await getRedditToken();

    const posts: RawPost[] = [];
    posts.push(
      ...(await this._scanUnit({
        platform: 'x',
        scanType: 'keyword',
        scanKey: KEYWORD_GLOBAL_SCAN_KEY,
        scope: { type: 'keyword' },
        keywords,
        xPool,
      }))
    );
    posts.push(
      ...(await this._scanUnit({
        platform: 'reddit',
        scanType: 'keyword',
        scanKey: KEYWORD_GLOBAL_SCAN_KEY,
        scope: { type: 'keyword' },
        keywords,
        redditToken,
      }))
    );

    await this._fanOutAndFinalize(orgContexts, posts);
  }

  @ActivityMethod()
  async runGlobalChannelScan(): Promise<void> {
    const orgContexts = await this._engageRepository.getAllEnabledOrgContexts();
    if (!orgContexts.length) return;
    const keywords = unionKeywords(orgContexts);
    const subreddits = unionSubreddits(orgContexts);
    if (!keywords.length || !subreddits.length) return;

    const redditToken = await getRedditToken();
    const posts: RawPost[] = [];
    for (const subreddit of subreddits) {
      posts.push(
        ...(await this._scanUnit({
          platform: 'reddit',
          scanType: 'channel',
          scanKey: subreddit,
          scope: { type: 'channel', key: subreddit },
          keywords,
          redditToken,
        }))
      );
    }

    await this._fanOutAndFinalize(orgContexts, posts);
    await this._updateAllChannelsLastScannedAt(
      orgContexts.map((c) => c.organizationId)
    );
  }

  @ActivityMethod()
  async runGlobalTrackedAccountsScan(): Promise<void> {
    const orgContexts = await this._engageRepository.getAllEnabledOrgContexts();
    if (!orgContexts.length) return;
    const keywords = unionKeywords(orgContexts);
    const accounts = unionTrackedUsernames(orgContexts);
    if (!keywords.length || !accounts.size) return;

    const xPool = new TokenPool(await this._collectXTokens(orgContexts));
    if (!xPool.size) {
      this.logger.warn(
        `Tracked scan skipped: no usable X token across ${orgContexts.length} org(s)`
      );
      return;
    }

    const posts: RawPost[] = [];
    for (const [username, records] of accounts) {
      const unitPosts = await this._scanUnit({
        platform: 'x',
        scanType: 'tracked',
        scanKey: username,
        scope: { type: 'tracked', key: username },
        keywords,
        xPool,
      });
      posts.push(...unitPosts);
      // Refresh profile + lastCheckedAt for every org tracking this username.
      // The author info rides on any returned post; absent that we still bump
      // lastCheckedAt so the UI shows the account was polled.
      const sample = unitPosts[0];
      const profile = sample
        ? { picture: sample.authorAvatarUrl, displayName: sample.authorDisplayName }
        : undefined;
      for (const rec of records) {
        await this._updateTrackedAccountAfterScan(rec.id, profile);
      }
    }

    await this._fanOutAndFinalize(orgContexts, posts);
  }

  // ─── Cursor-driven scan of one unit ──────────────────────────────────────

  private async _scanUnit(args: {
    platform: 'x' | 'reddit';
    scanType: ScanType;
    scanKey: string;
    scope: ScanScope;
    keywords: string[];
    xPool?: TokenPool;
    redditToken?: string | null;
  }): Promise<RawPost[]> {
    const cursor = await this._claimCursor(
      args.platform,
      args.scanType,
      args.scanKey
    );
    if (!cursor) return []; // cooling down, or already SCANNING (single-flight)

    const adapter = args.platform === 'x' ? this._xAdapter : this._redditAdapter;
    const token =
      args.platform === 'x'
        ? args.xPool?.acquire() ?? null
        : args.redditToken ?? null;
    if (args.platform === 'x' && !token) {
      this.logger.warn(
        `X ${args.scanType} scan for "${args.scanKey}" skipped: token pool exhausted`
      );
      await this._releaseCursor(cursor.id);
      return [];
    }

    try {
      const result = await adapter.searchScoped({
        scope: args.scope,
        keywords: args.keywords,
        cursor: {
          lastSeenExternalId: cursor.lastSeenExternalId,
          lastSeenAt: cursor.lastSeenAt,
        },
        budget: { maxCalls: SCAN_MAX_CALLS },
        token,
        log: {
          log: (m) => this.logger.log(m),
          warn: (m) => this.logger.warn(m),
        },
        heartbeat: (p) => this._heartbeat(p),
      });
      if (args.platform === 'x' && token && args.xPool) {
        args.xPool.report(token, result.rate);
      }

      if (result.rate.limited) {
        const until = new Date(
          Date.now() + (result.rate.retryAfterMs ?? DEFAULT_COOLDOWN_MS)
        );
        // Do NOT advance the cursor — retry from the same point after cool-down.
        await this._cooldownCursor(cursor.id, until);
        this.logger.warn(
          `${args.platform} ${args.scanType} "${args.scanKey}" rate-limited; cooling down until ${until.toISOString()}`
        );
      } else {
        await this._completeCursor(cursor.id, result.nextCursor);
      }
      return result.posts;
    } catch (err) {
      this.logger.warn(
        `Scan unit ${args.platform}/${args.scanType}/${args.scanKey} failed: ${(err as Error).message}`
      );
      await this._releaseCursor(cursor.id);
      return [];
    }
  }

  // ─── EngageScanCursor lifecycle ──────────────────────────────────────────

  // Ensure the unit's cursor row exists, then skip it if it is cooling down or
  // already SCANNING, else atomically claim it (IDLE→SCANNING + stamp
  // lastScanStartedAt). Returns the pre-claim row (carrying the incremental
  // cursor) or null when the unit is not due / lost a single-flight race.
  private async _claimCursor(
    platform: string,
    scanType: string,
    scanKey: string
  ) {
    const now = new Date();
    const row = await this._scanCursor.model.engageScanCursor.upsert({
      where: { platform_scanType_scanKey: { platform, scanType, scanKey } },
      create: { platform, scanType, scanKey, status: 'IDLE' },
      update: {},
    });
    if (row.status === 'SCANNING') return null;
    if (row.cooldownUntil && row.cooldownUntil > now) return null;
    const claimed = await this._scanCursor.model.engageScanCursor.updateMany({
      where: { id: row.id, status: 'IDLE' },
      data: { status: 'SCANNING', lastScanStartedAt: now },
    });
    if (claimed.count !== 1) return null; // lost a concurrent single-flight race
    return row;
  }

  private async _completeCursor(id: string, next: ScanCursor): Promise<void> {
    await this._scanCursor.model.engageScanCursor.update({
      where: { id },
      data: {
        status: 'IDLE',
        lastScannedAt: new Date(),
        lastSeenExternalId: next.lastSeenExternalId ?? null,
        lastSeenAt: next.lastSeenAt ?? null,
        cooldownUntil: null,
      },
    });
  }

  private async _cooldownCursor(id: string, until: Date): Promise<void> {
    await this._scanCursor.model.engageScanCursor.update({
      where: { id },
      data: { status: 'IDLE', cooldownUntil: until },
    });
  }

  private async _releaseCursor(id: string): Promise<void> {
    await this._scanCursor.model.engageScanCursor.update({
      where: { id },
      data: { status: 'IDLE' },
    });
  }

  // ─── Fan-out + finalize (shared by every scan type) ──────────────────────

  private async _fanOutAndFinalize(
    orgContexts: OrgContext[],
    posts: RawPost[]
  ): Promise<void> {
    const deduped = deduplicatePosts(posts);
    this.logger.log(`Scan yield: ${posts.length} raw → ${deduped.length} deduped`);
    if (deduped.length) {
      await Promise.all(orgContexts.map((ctx) => this._fanOutToOrg(ctx, deduped)));
    }
    // Always expire stale opportunities regardless of scan yield.
    await Promise.all(
      orgContexts.map((ctx) => this._expireStaleOpportunities(ctx.organizationId))
    );
    await this._finalizeAllOrgs(orgContexts);
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

    const matched = orgPosts
      .map((p) => scorePost(p, orgKeywords))
      .filter((p): p is ScoredPost => p !== null);
    const scored = matched.filter((p) => p.score >= MIN_SCORE);
    this.logger.log(
      `Fan-out org=${ctx.organizationId}: ${orgPosts.length} raw → ${matched.length} keyword-matched → ${scored.length} scored>=${MIN_SCORE}` +
        (matched.length && !scored.length
          ? ` (top score ${Math.max(...matched.map((p) => p.score))})`
          : '')
    );

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

  // ─── X token pool ──────────────────────────────────────────────────────────

  // Collect every usable X access token to spread scan load across accounts:
  //   1. All posting-capable X integrations across the enabled orgs (connected,
  //      not disabled, not pending refresh/setup).
  //   2. The app-only X_BEARER_TOKEN env var, as an extra pool member.
  // Independent of EngageXReplyAccount — reply accounts only choose who *sends*
  // replies, not which token we *read* the firehose with.
  private async _collectXTokens(orgContexts: OrgContext[]): Promise<string[]> {
    const orgIds = orgContexts.map((c) => c.organizationId);
    const integrations = await this._integration.model.integration.findMany({
      where: {
        organizationId: { in: orgIds },
        providerIdentifier: 'x',
        type: 'social',
        disabled: false,
        deletedAt: null,
        inBetweenSteps: false,
        refreshNeeded: false,
      },
      select: { token: true },
      orderBy: { createdAt: 'asc' },
    });

    const tokens: string[] = [];
    for (const i of integrations) {
      const t = this._extractOauthToken(i.token as string | Record<string, string>);
      if (t) tokens.push(t);
    }
    const bearer = process.env.X_BEARER_TOKEN;
    if (bearer) tokens.push(bearer);

    const unique = Array.from(new Set(tokens));
    this.logger.log(
      `X token pool: ${unique.length} token(s) (${integrations.length} integration(s)${bearer ? ' + bearer' : ''})`
    );
    return unique;
  }

  private _extractOauthToken(
    token: string | Record<string, string>
  ): string | null {
    if (typeof token === 'string') {
      // Token may be stored as a raw string or as a JSON blob.
      const trimmed = token.trim();
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed) as Record<string, string>;
          return parsed.access_token ?? parsed.token ?? null;
        } catch {
          return token;
        }
      }
      return token;
    }
    return token.access_token ?? token.token ?? null;
  }
}

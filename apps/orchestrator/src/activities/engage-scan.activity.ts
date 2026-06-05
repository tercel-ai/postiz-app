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
const INITIAL_SCAN_MAX_UNITS = Number(
  process.env.ENGAGE_KEYWORD_INITIAL_SCAN_MAX_UNITS ?? 5
);
const INITIAL_SCAN_MAX_CALLS = Number(
  process.env.ENGAGE_KEYWORD_INITIAL_SCAN_MAX_CALLS ?? 3
);
const INITIAL_SCAN_LOOKBACK_HOURS = Number(
  process.env.ENGAGE_KEYWORD_INITIAL_SCAN_LOOKBACK_HOURS ?? 24
);
const INITIAL_SCAN_MAX_ATTEMPTS = Number(
  process.env.ENGAGE_KEYWORD_INITIAL_SCAN_MAX_ATTEMPTS ?? 3
);
const INITIAL_SCAN_RETRY_MS = Number(
  process.env.ENGAGE_KEYWORD_INITIAL_SCAN_RETRY_MS ?? 15 * 60 * 1000
);
const INITIAL_SCAN_STALE_MS = Number(
  process.env.ENGAGE_KEYWORD_INITIAL_SCAN_STALE_MS ?? 30 * 60 * 1000
);

// Per-scanType cadence (ms). A single frequent ticker calls runDueScans(); each
// unit is scanned only when lastScanStartedAt + its cadence has elapsed (unless
// forced). This is what makes the per-unit cursor/cooldown granularity matter:
// a rate-limited unit recovers on the next tick after its cooldown, independent
// of the long keyword cadence. Mirrors the repository's getOrgScanStatus.
const CADENCE_MS: Record<ScanType, number> = {
  keyword: Number(process.env.ENGAGE_KEYWORD_SCAN_INTERVAL_HOURS ?? 24) * 3_600_000,
  channel: Number(process.env.ENGAGE_CHANNEL_SCAN_INTERVAL_HOURS ?? 3) * 3_600_000,
  tracked: Number(process.env.ENGAGE_TRACKED_SCAN_INTERVAL_HOURS ?? 3) * 3_600_000,
};

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
    private _scanCursor: PrismaRepository<'engageScanCursor'>,
    private _keywordInitialScan: PrismaRepository<'engageKeywordInitialScan'>
  ) {}

  private _heartbeat(progress?: unknown): void {
    try {
      Context.current().heartbeat(progress);
    } catch {
      // Not running inside a Temporal activity context (e.g. unit tests).
    }
  }

  // ─── Scan entry point (single cadence ticker) ────────────────────────────
  //
  // Called every tick by engageScanTickerWorkflow. Builds every scan UNIT — a
  // (platform, scanType, scanKey) tuple with its own incremental cursor — and
  // scans only the ones whose per-type cadence has elapsed (or all of them when
  // `force`, e.g. a user-triggered immediate scan). All collected posts are
  // deduped and fanned out to every enabled org once. `force` bypasses the
  // cadence gate but NOT the rate-limit cooldown.
  @ActivityMethod()
  async runDueScans(force = false): Promise<void> {
    const orgContexts = await this._engageRepository.getAllEnabledOrgContexts();
    if (!orgContexts.length) return;
    const keywords = unionKeywords(orgContexts);
    if (!keywords.length) return;

    const xPool = new TokenPool(await this._collectXTokens(orgContexts));
    const redditToken = await getRedditToken();

    await this._ensureMissingKeywordInitialScans(orgContexts);
    await this._runPendingKeywordInitialScans(orgContexts, redditToken);

    const posts: RawPost[] = [
      ...(await this._scanKeywordUnits(keywords, xPool, redditToken, force)),
      ...(await this._scanChannelUnits(orgContexts, keywords, redditToken, force)),
      ...(await this._scanTrackedUnits(orgContexts, keywords, xPool, force)),
    ];

    await this._fanOutAndFinalize(orgContexts, posts);
  }

  // ─── Keyword initial scan catch-up ───────────────────────────────────────
  //
  // Initial scans are one-shot keyword catch-up jobs, not durable incremental
  // cursors. Keep their state separate from EngageScanCursor: this table needs
  // DONE/FAILED/attempts/error semantics, while EngageScanCursor owns ongoing
  // position and cadence. RUNNING rows use startedAt as a lease; stale leases are
  // reclaimable so a crashed worker cannot strand a keyword forever.

  private async _runPendingKeywordInitialScans(
    orgContexts: OrgContext[],
    redditToken: string | null
  ): Promise<void> {
    if (!this._keywordInitialScan) return;
    const orgById = new Map(orgContexts.map((ctx) => [ctx.organizationId, ctx]));
    const retryBefore = new Date(Date.now() - INITIAL_SCAN_RETRY_MS);
    const staleBefore = new Date(Date.now() - INITIAL_SCAN_STALE_MS);
    const rows = await this._keywordInitialScan.model.engageKeywordInitialScan.findMany({
      where: {
        platform: 'reddit',
        organizationId: { in: Array.from(orgById.keys()) },
        OR: [
          { status: 'PENDING' },
          {
            status: 'FAILED',
            attempts: { lt: INITIAL_SCAN_MAX_ATTEMPTS },
            updatedAt: { lt: retryBefore },
          },
          {
            status: 'RUNNING',
            startedAt: { lt: staleBefore },
          },
        ],
        keywordRef: { enabled: true, config: { enabled: true } },
      },
      include: { keywordRef: true },
      orderBy: { createdAt: 'asc' },
      take: INITIAL_SCAN_MAX_UNITS,
    });
    if (!rows.length) return;

    for (const row of rows) {
      if (
        row.status === 'RUNNING' &&
        row.attempts >= INITIAL_SCAN_MAX_ATTEMPTS
      ) {
        await this._keywordInitialScan.model.engageKeywordInitialScan.updateMany({
          where: {
            id: row.id,
            status: 'RUNNING',
            startedAt: { lt: staleBefore },
          },
          data: {
            status: 'FAILED',
            error: `Initial scan exceeded ${INITIAL_SCAN_MAX_ATTEMPTS} attempt(s) and the last RUNNING lease became stale`,
          },
        });
        continue;
      }

      const claimed = await this._keywordInitialScan.model.engageKeywordInitialScan.updateMany({
        where: {
          id: row.id,
          OR: [
            { status: 'PENDING' },
            {
              status: 'FAILED',
              attempts: { lt: INITIAL_SCAN_MAX_ATTEMPTS },
              updatedAt: { lt: retryBefore },
            },
            {
              status: 'RUNNING',
              startedAt: { lt: staleBefore },
            },
          ],
        },
        data: {
          status: 'RUNNING',
          startedAt: new Date(),
          completedAt: null,
          error: null,
          keyword: row.keywordRef.keyword,
          attempts: { increment: 1 },
        },
      });
      if (claimed.count !== 1) continue;

      try {
        const ctx = orgById.get(row.organizationId);
        if (!ctx) throw new Error(`org context ${row.organizationId} not enabled`);
        const lookback = new Date(
          Date.now() - INITIAL_SCAN_LOOKBACK_HOURS * 3_600_000
        );
        const result = await this._redditAdapter.searchScoped({
          scope: { type: 'keyword' },
          keywords: [row.keywordRef.keyword],
          cursor: { lastSeenAt: lookback },
          budget: { maxCalls: INITIAL_SCAN_MAX_CALLS },
          token: redditToken,
          log: {
            log: (m) => this.logger.log(`[initial-scan] ${m}`),
            warn: (m) => this.logger.warn(`[initial-scan] ${m}`),
          },
          heartbeat: (p) =>
            this._heartbeat({
              stage: 'keyword_initial_scan',
              keywordId: row.keywordId,
              platform: row.platform,
              progress: p,
            }),
        });
        await this._fanOutToOrg(ctx, deduplicatePosts(result.posts));
        if (result.rate.limited) {
          const retryAfter = result.rate.retryAfterMs
            ? `; retryAfterMs=${result.rate.retryAfterMs}`
            : '';
          throw new Error(`Initial keyword scan rate-limited${retryAfter}`);
        }
        await this._keywordInitialScan.model.engageKeywordInitialScan.update({
          where: { id: row.id },
          data: {
            status: 'DONE',
            completedAt: new Date(),
            error: null,
          },
        });
      } catch (err) {
        await this._keywordInitialScan.model.engageKeywordInitialScan.update({
          where: { id: row.id },
          data: {
            status: 'FAILED',
            error: (err as Error).message.slice(0, 1000),
          },
        });
      }
    }
  }

  private async _ensureMissingKeywordInitialScans(
    orgContexts: OrgContext[]
  ): Promise<void> {
    if (!this._keywordInitialScan) return;
    const rows = orgContexts.flatMap((ctx) =>
      ctx.keywords.map((kw) => ({
        organizationId: ctx.organizationId,
        keywordId: kw.id,
        keyword: kw.keyword,
        platform: 'reddit',
        status: 'PENDING',
      }))
    );
    if (!rows.length) return;
    await this._keywordInitialScan.model.engageKeywordInitialScan.createMany({
      data: rows,
      skipDuplicates: true,
    });
  }

  // X + Reddit global keyword firehose (one cursor per platform).
  private async _scanKeywordUnits(
    keywords: string[],
    xPool: TokenPool,
    redditToken: string | null,
    force: boolean
  ): Promise<RawPost[]> {
    const posts: RawPost[] = [];
    for (const platform of ['x', 'reddit'] as const) {
      const r = await this._scanUnit({
        platform,
        scanType: 'keyword',
        scanKey: KEYWORD_GLOBAL_SCAN_KEY,
        scope: { type: 'keyword' },
        keywords,
        force,
        xPool: platform === 'x' ? xPool : undefined,
        redditToken: platform === 'reddit' ? redditToken : null,
      });
      posts.push(...r.posts);
    }
    return posts;
  }

  // One unit per monitored subreddit (keywords OR-batched, restrict_sr).
  private async _scanChannelUnits(
    orgContexts: OrgContext[],
    keywords: string[],
    redditToken: string | null,
    force: boolean
  ): Promise<RawPost[]> {
    const posts: RawPost[] = [];
    const scanned: string[] = [];
    for (const subreddit of unionSubreddits(orgContexts)) {
      const r = await this._scanUnit({
        platform: 'reddit',
        scanType: 'channel',
        scanKey: subreddit,
        scope: { type: 'channel', key: subreddit },
        keywords,
        redditToken,
        force,
      });
      if (r.ran) scanned.push(subreddit);
      posts.push(...r.posts);
    }
    // Bump EngageMonitoredChannel.lastScannedAt only for subreddits we actually
    // scanned this tick (UI bookkeeping; the cursor is the source of truth).
    if (scanned.length) await this._markChannelsScanned(scanned);
    return posts;
  }

  // One unit per unique tracked username (from:user + keywords).
  private async _scanTrackedUnits(
    orgContexts: OrgContext[],
    keywords: string[],
    xPool: TokenPool,
    force: boolean
  ): Promise<RawPost[]> {
    if (!xPool.size) return [];
    const accounts = unionTrackedUsernames(orgContexts);
    const posts: RawPost[] = [];
    for (const [username, records] of accounts) {
      const r = await this._scanUnit({
        platform: 'x',
        scanType: 'tracked',
        scanKey: username,
        scope: { type: 'tracked', key: username },
        keywords,
        xPool,
        force,
      });
      posts.push(...r.posts);
      // Only touch the account bookkeeping if the unit actually ran this tick.
      if (!r.ran) continue;
      const sample = r.posts[0];
      const profile = sample
        ? { picture: sample.authorAvatarUrl, displayName: sample.authorDisplayName }
        : undefined;
      for (const rec of records) {
        await this._updateTrackedAccountAfterScan(rec.id, profile);
      }
    }
    return posts;
  }

  // ─── Cursor-driven scan of one unit ──────────────────────────────────────

  private async _scanUnit(args: {
    platform: 'x' | 'reddit';
    scanType: ScanType;
    scanKey: string;
    scope: ScanScope;
    keywords: string[];
    force?: boolean;
    xPool?: TokenPool;
    redditToken?: string | null;
  }): Promise<{ ran: boolean; posts: RawPost[] }> {
    const cursor = await this._claimCursor(
      args.platform,
      args.scanType,
      args.scanKey,
      CADENCE_MS[args.scanType],
      args.force ?? false
    );
    // Not due yet, cooling down, or already SCANNING (single-flight).
    if (!cursor) return { ran: false, posts: [] };

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
      return { ran: false, posts: [] };
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
      return { ran: true, posts: result.posts };
    } catch (err) {
      this.logger.warn(
        `Scan unit ${args.platform}/${args.scanType}/${args.scanKey} failed: ${(err as Error).message}`
      );
      await this._releaseCursor(cursor.id);
      return { ran: false, posts: [] };
    }
  }

  // ─── EngageScanCursor lifecycle ──────────────────────────────────────────

  // Ensure the unit's cursor row exists, then skip it unless it is DUE — not
  // SCANNING, not cooling down, and (unless `force`) its cadence has elapsed
  // since lastScanStartedAt. If due, atomically claim it (IDLE→SCANNING + stamp
  // lastScanStartedAt). Returns the pre-claim row (carrying the incremental
  // cursor) or null when not due / lost a single-flight race.
  private async _claimCursor(
    platform: string,
    scanType: string,
    scanKey: string,
    cadenceMs: number,
    force: boolean
  ) {
    const now = new Date();
    const row = await this._scanCursor.model.engageScanCursor.upsert({
      where: { platform_scanType_scanKey: { platform, scanType, scanKey } },
      create: { platform, scanType, scanKey, status: 'IDLE' },
      update: {},
    });
    if (row.status === 'SCANNING') return null;
    if (row.cooldownUntil && row.cooldownUntil > now) return null;
    // Cadence gate: skip if it was scanned within its interval (force bypasses).
    if (
      !force &&
      row.lastScanStartedAt &&
      row.lastScanStartedAt.getTime() + cadenceMs > now.getTime()
    ) {
      return null;
    }
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
      // Isolate per-org: one org's transient persist failure must NOT abort the
      // tick for every other org. Cursors have already advanced in the scan
      // phase, and this activity runs with maximumAttempts:1, so an aborted tick
      // silently drops opportunities org-wide until the next cadence window.
      this._settleByOrg(
        await Promise.allSettled(
          orgContexts.map((ctx) => this._fanOutToOrg(ctx, deduped))
        ),
        orgContexts,
        'fan-out'
      );
    }
    // Always expire stale opportunities regardless of scan yield — also isolated.
    this._settleByOrg(
      await Promise.allSettled(
        orgContexts.map((ctx) => this._expireStaleOpportunities(ctx.organizationId))
      ),
      orgContexts,
      'expire-stale'
    );
    await this._finalizeAllOrgs(orgContexts);
  }

  /** Log per-org rejections from an allSettled fan-out without aborting the tick. */
  private _settleByOrg(
    results: PromiseSettledResult<unknown>[],
    orgContexts: OrgContext[],
    phase: string
  ): void {
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        this.logger.error(
          `Scan ${phase} failed for org=${orgContexts[i].organizationId}: ${
            r.reason instanceof Error ? r.reason.message : String(r.reason)
          }`
        );
      }
    });
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
    // Note: stale-opportunity expiry runs once per org in _fanOutAndFinalize
    // (isolated via allSettled), so it is NOT repeated here — keeping it here too
    // would double the work and, more importantly, couple expiry to fan-out
    // success when expiry must run even if this org's persist threw.
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
              matchedKeywords: post.matchedKeywords,
            },
            update: {
              score: post.score,
              scoreKeyword: post.scoreKeyword,
              scoreTracked: post.scoreTracked,
              // Refresh matched keywords so keyword edits are reflected on re-scan.
              matchedKeywords: post.matchedKeywords,
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

  // Bump lastScannedAt for the monitored-channel rows (across all orgs) whose
  // subreddit was actually scanned this tick. Keyed by channelId, not org.
  private async _markChannelsScanned(subredditIds: string[]): Promise<void> {
    if (!subredditIds.length) return;
    await this._channel.model.engageMonitoredChannel.updateMany({
      where: {
        platform: 'reddit',
        channelId: { in: subredditIds },
        enabled: true,
      },
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

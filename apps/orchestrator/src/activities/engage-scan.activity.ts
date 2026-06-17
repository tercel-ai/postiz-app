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
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import {
  EngageEntitlementService,
  DEFAULT_SCAN_INTERVAL_HOURS,
} from '@gitroom/nestjs-libraries/engage/engage-entitlement.service';
import { EngageScanConfigService } from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';
import { EngageScanIngestService } from '@gitroom/nestjs-libraries/engage/engage-scan-ingest.service';
import { EngageKeyword } from '@prisma/client';
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
const INITIAL_SCAN_PLATFORMS = ['reddit', 'x'] as const;
type InitialScanPlatform = (typeof INITIAL_SCAN_PLATFORMS)[number];
const INITIAL_SCAN_SETTINGS_PREFIX = 'engage.keyword_initial_scan.';
type InitialScanRuntimeSettings = {
  enabledPlatforms: InitialScanPlatform[];
  lookbackHours: number;
  maxAttempts: number;
  retryMs: number;
  staleMs: number;
  budget: Record<InitialScanPlatform, { maxUnits: number; maxCalls: number }>;
};

// Scan cadence is per UNIT, derived from the owning orgs' plan entitlement
// (scan_interval_hours): each unit's effective interval = the MIN across every
// org that contributes it ("whoever scans most often wins" — shared data is
// always fine to refresh sooner). A single frequent ticker calls runDueScans();
// each unit is scanned only when lastScanStartedAt + its cadence has elapsed
// (unless forced), so a rate-limited unit recovers on the next tick after its
// cooldown, independent of the long base cadence. The keyword firehose is
// bucketed by interval so Starter/Developer-only keywords (24h) aren't dragged
// onto the Pro 6h cadence. Falls back to DEFAULT_SCAN_INTERVAL_HOURS when no
// entitlement applies (self-hosted / billing off).
function hoursToMs(hours: number): number {
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_SCAN_INTERVAL_HOURS) * 3_600_000;
}

// Derived from the repository method so the type stays in sync automatically.
type OrgContext = Awaited<ReturnType<EngageRepository['getAllEnabledOrgContexts']>>[number];

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

// Map of lowercased tracked username → the account records (with their org)
// across all orgs, so each unique username is fetched once and the result
// updates every org that tracks it.
function unionTrackedUsernames(
  ctxs: OrgContext[]
): Map<string, Array<{ id: string; orgId: string }>> {
  const m = new Map<string, Array<{ id: string; orgId: string }>>();
  for (const c of ctxs) {
    for (const a of c.trackedAccounts) {
      const key = a.username.toLowerCase();
      const arr = m.get(key) ?? [];
      arr.push({ id: a.id, orgId: c.organizationId });
      m.set(key, arr);
    }
  }
  return m;
}

// Accumulate the minimum interval-hours per key across the orgs that contribute
// it. Used to bucket keyword units and set per-unit channel/tracked cadence.
function minMerge(map: Map<string, number>, key: string, hours: number): void {
  const cur = map.get(key);
  map.set(key, cur === undefined ? hours : Math.min(cur, hours));
}

function settingRaw(
  settings: Map<string, unknown>,
  key: string
): unknown | undefined {
  return settings.has(key) ? settings.get(key) : undefined;
}

function numberSetting(
  settings: Map<string, unknown>,
  key: string,
  envNames: string[],
  fallback: number
): number {
  const raw = settingRaw(settings, key);
  const candidate = raw ?? envNames.map((name) => process.env[name]).find(Boolean);
  const value = Number(candidate ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseInitialScanPlatforms(raw: unknown): InitialScanPlatform[] {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : INITIAL_SCAN_PLATFORMS;
  const enabled = values
    .map((value) => String(value).trim().toLowerCase())
    .filter((value): value is InitialScanPlatform =>
      INITIAL_SCAN_PLATFORMS.includes(value as InitialScanPlatform)
    );
  return Array.from(new Set(enabled));
}

function envPlatformPrefix(platform: string): string {
  return platform.replace(/[^a-z0-9]/gi, '_').toUpperCase();
}

const DEFAULT_INITIAL_SCAN_MAX_UNITS = 10;
const DEFAULT_INITIAL_SCAN_MAX_CALLS = 5;

function platformInitialScanBudget(
  settings: Map<string, unknown>,
  platform: InitialScanPlatform
): { maxUnits: number; maxCalls: number } {
  const envPrefix = envPlatformPrefix(platform);
  return {
    maxUnits: numberSetting(
      settings,
      `engage.keyword_initial_scan.${platform}.max_units`,
      [
        `ENGAGE_${envPrefix}_KEYWORD_INITIAL_SCAN_MAX_UNITS`,
        'ENGAGE_KEYWORD_INITIAL_SCAN_MAX_UNITS',
      ],
      DEFAULT_INITIAL_SCAN_MAX_UNITS
    ),
    maxCalls: numberSetting(
      settings,
      `engage.keyword_initial_scan.${platform}.max_calls`,
      [
        `ENGAGE_${envPrefix}_KEYWORD_INITIAL_SCAN_MAX_CALLS`,
        'ENGAGE_KEYWORD_INITIAL_SCAN_MAX_CALLS',
      ],
      DEFAULT_INITIAL_SCAN_MAX_CALLS
    ),
  };
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
    private _keywordInitialScan: PrismaRepository<'engageKeywordInitialScan'>,
    private _settingsService?: SettingsService,
    private _entitlement?: EngageEntitlementService,
    private _scanConfig?: EngageScanConfigService
  ) { }

  /**
   * Build a scan budget for the WORKFLOW path: keep the existing call cap but
   * take the MIN with the configured maxPages (tighter cap wins), and attach the
   * per-page delay/jitter pacing. Falls back to a bare maxCalls (no delay) when
   * the config service isn't wired or a read fails — pacing must never break a
   * scan.
   */
  private async _pacingBudget(
    platform: 'x' | 'reddit',
    phase: 'initial' | 'incremental',
    maxCalls: number
  ): Promise<{ maxCalls: number; pageDelayMs?: number; jitterMs?: number }> {
    if (!this._scanConfig) return { maxCalls };
    try {
      const p = await this._scanConfig.getPagePacing('workflow', platform, phase);
      return {
        maxCalls: Math.max(1, Math.min(maxCalls, p.maxPages)),
        pageDelayMs: p.pageDelayMs,
        jitterMs: p.jitterMs,
      };
    } catch {
      return { maxCalls };
    }
  }

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
    const initialScanSettings = await this._loadInitialScanSettings();

    await this._ensureMissingKeywordInitialScans(
      orgContexts,
      initialScanSettings.enabledPlatforms
    );
    await this._runPendingKeywordInitialScans(
      orgContexts,
      redditToken,
      xPool,
      initialScanSettings
    );

    // Resolve each org's plan scan interval once, then derive per-unit cadence.
    const intervalByOrg = await this._orgIntervalHours(orgContexts);

    const posts: RawPost[] = [
      ...(await this._scanKeywordUnits(orgContexts, intervalByOrg, xPool, redditToken, force)),
      ...(await this._scanChannelUnits(orgContexts, intervalByOrg, keywords, redditToken, force)),
      ...(await this._scanTrackedUnits(orgContexts, intervalByOrg, keywords, xPool, force)),
    ];

    await this._fanOutAndFinalize(orgContexts, posts);
  }

  // ─── Per-plan scan cadence ───────────────────────────────────────────────
  //
  // Resolve each enabled org's scan_interval_hours from its plan entitlement.
  // Cached inside EngageEntitlementService, so this is cheap across a tick. When
  // the entitlement service is absent (unit tests / billing off) every org falls
  // back to DEFAULT_SCAN_INTERVAL_HOURS, preserving the legacy single-cadence
  // behaviour.
  private async _orgIntervalHours(
    ctxs: OrgContext[]
  ): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    for (const c of ctxs) {
      let hours = DEFAULT_SCAN_INTERVAL_HOURS;
      if (this._entitlement) {
        try {
          hours = await this._entitlement.getScanIntervalHours(c.organizationId);
        } catch (err) {
          this.logger.warn(
            `Scan interval lookup failed for org=${c.organizationId}; using ${DEFAULT_SCAN_INTERVAL_HOURS}h: ${(err as Error).message}`
          );
        }
      }
      m.set(c.organizationId, hours);
    }
    return m;
  }

  private _orgHours(intervalByOrg: Map<string, number>, orgId: string): number {
    return intervalByOrg.get(orgId) ?? DEFAULT_SCAN_INTERVAL_HOURS;
  }

  // ─── Keyword initial scan catch-up ───────────────────────────────────────
  //
  // Initial scans are one-shot keyword catch-up jobs, not durable incremental
  // cursors. Keep their state separate from EngageScanCursor: this table needs
  // DONE/FAILED/attempts/error semantics, while EngageScanCursor owns ongoing
  // position and cadence. RUNNING rows use startedAt as a lease; stale leases are
  // reclaimable so a crashed worker cannot strand a keyword forever.

  private async _loadInitialScanSettings(): Promise<InitialScanRuntimeSettings> {
    const records = this._settingsService
      ? await this._settingsService.listByPrefix(INITIAL_SCAN_SETTINGS_PREFIX)
      : [];
    const settings = new Map<string, unknown>(
      records.map((record: any) => [
        record.key,
        record.value ?? record.default ?? undefined,
      ])
    );
    const platformsRaw =
      settingRaw(settings, 'engage.keyword_initial_scan.enabled_platforms') ??
      process.env.ENGAGE_KEYWORD_INITIAL_SCAN_PLATFORMS;
    const enabledPlatforms = parseInitialScanPlatforms(platformsRaw);
    const budget = Object.fromEntries(
      enabledPlatforms.map((platform) => [
        platform,
        platformInitialScanBudget(settings, platform),
      ])
    ) as Record<InitialScanPlatform, { maxUnits: number; maxCalls: number }>;
    return {
      enabledPlatforms,
      lookbackHours: numberSetting(
        settings,
        'engage.keyword_initial_scan.lookback_hours',
        ['ENGAGE_KEYWORD_INITIAL_SCAN_LOOKBACK_HOURS'],
        24
      ),
      maxAttempts: numberSetting(
        settings,
        'engage.keyword_initial_scan.max_attempts',
        ['ENGAGE_KEYWORD_INITIAL_SCAN_MAX_ATTEMPTS'],
        3
      ),
      retryMs: numberSetting(
        settings,
        'engage.keyword_initial_scan.retry_ms',
        ['ENGAGE_KEYWORD_INITIAL_SCAN_RETRY_MS'],
        15 * 60 * 1000
      ),
      staleMs: numberSetting(
        settings,
        'engage.keyword_initial_scan.stale_ms',
        ['ENGAGE_KEYWORD_INITIAL_SCAN_STALE_MS'],
        30 * 60 * 1000
      ),
      budget,
    };
  }

  private async _runPendingKeywordInitialScans(
    orgContexts: OrgContext[],
    redditToken: string | null,
    xPool: TokenPool,
    settings: InitialScanRuntimeSettings
  ): Promise<void> {
    for (const platform of settings.enabledPlatforms) {
      await this._runPendingPlatformKeywordInitialScans(
        platform,
        orgContexts,
        redditToken,
        xPool,
        settings
      );
    }
  }

  private async _runPendingPlatformKeywordInitialScans(
    platform: InitialScanPlatform,
    orgContexts: OrgContext[],
    redditToken: string | null,
    xPool: TokenPool,
    settings: InitialScanRuntimeSettings
  ): Promise<void> {
    if (!this._keywordInitialScan) return;
    if (platform === 'x' && (!xPool.size || xPool.available() <= 0)) return;
    const orgById = new Map(orgContexts.map((ctx) => [ctx.organizationId, ctx]));
    const retryBefore = new Date(Date.now() - settings.retryMs);
    const staleBefore = new Date(Date.now() - settings.staleMs);
    const budget = settings.budget[platform];
    const rows = await this._keywordInitialScan.model.engageKeywordInitialScan.findMany({
      where: {
        platform,
        organizationId: { in: Array.from(orgById.keys()) },
        OR: [
          { status: 'PENDING' },
          {
            status: 'FAILED',
            attempts: { lt: settings.maxAttempts },
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
      take: budget.maxUnits,
    });
    if (!rows.length) return;

    const claimedRows: typeof rows = [];
    for (const row of rows) {
      if (
        row.status === 'RUNNING' &&
        row.attempts >= settings.maxAttempts
      ) {
        await this._keywordInitialScan.model.engageKeywordInitialScan.updateMany({
          where: {
            id: row.id,
            status: 'RUNNING',
            startedAt: { lt: staleBefore },
          },
          data: {
            status: 'FAILED',
            error: `Initial scan exceeded ${settings.maxAttempts} attempt(s) and the last RUNNING lease became stale`,
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
              attempts: { lt: settings.maxAttempts },
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
      claimedRows.push(row);
    }
    if (!claimedRows.length) return;

    const claimedIds = claimedRows.map((row) => row.id);
    const claimedOrgIds = Array.from(
      new Set(claimedRows.map((row) => row.organizationId))
    );
    const claimedKeywords = Array.from(
      new Set(claimedRows.map((row) => row.keywordRef.keyword))
    );

    try {
      const token = platform === 'x' ? xPool.acquire() : redditToken;
      if (platform === 'x' && !token) {
        await this._keywordInitialScan.model.engageKeywordInitialScan.updateMany({
          where: { id: { in: claimedIds } },
          data: {
            status: 'PENDING',
            startedAt: null,
            error: 'X initial scan skipped: token pool exhausted',
          },
        });
        return;
      }
      const lookback = new Date(
        Date.now() - settings.lookbackHours * 3_600_000
      );
      const adapter = platform === 'x' ? this._xAdapter : this._redditAdapter;
      const result = await adapter.searchScoped({
        scope: { type: 'keyword' },
        keywords: claimedKeywords,
        cursor: platform === 'reddit' ? { lastSeenAt: lookback } : {},
        budget: await this._pacingBudget(platform, 'initial', budget.maxCalls),
        token,
        log: {
          log: (m) => this.logger.log(`[initial-scan] ${m}`),
          warn: (m) => this.logger.warn(`[initial-scan] ${m}`),
        },
        heartbeat: (p) =>
          this._heartbeat({
            stage: 'keyword_initial_scan',
            keywordIds: claimedRows.map((row) => row.keywordId),
            platform,
            progress: p,
          }),
      });
      if (platform === 'x' && token) {
        xPool.report(token, result.rate);
      }

      const posts = deduplicatePosts(result.posts);
      const failedOrgIds: string[] = [];
      for (const orgId of claimedOrgIds) {
        const ctx = orgById.get(orgId);
        if (!ctx) {
          failedOrgIds.push(orgId);
          continue;
        }
        try {
          await this._fanOutToOrg(ctx, posts);
        } catch (err) {
          failedOrgIds.push(orgId);
          this.logger.warn(
            `[initial-scan] fan-out failed for org=${orgId}: ${(err as Error).message}`
          );
        }
      }

      if (result.rate.limited) {
        const retryAfter = result.rate.retryAfterMs
          ? `; retryAfterMs=${result.rate.retryAfterMs}`
          : '';
        throw new Error(`${platform} initial keyword scan rate-limited${retryAfter}`);
      }
      if (result.backlogRemaining) {
        throw new Error(
          `${platform} initial keyword scan hit call budget; backlog remains`
        );
      }

      const completedAt = new Date();
      const failedIds = claimedRows
        .filter((row) => failedOrgIds.includes(row.organizationId))
        .map((row) => row.id);
      const doneIds = claimedIds.filter((id) => !failedIds.includes(id));
      if (doneIds.length) {
        await this._keywordInitialScan.model.engageKeywordInitialScan.updateMany({
          where: { id: { in: doneIds } },
          data: {
            status: 'DONE',
            completedAt,
            error: null,
          },
        });
      }
      if (failedIds.length) {
        await this._keywordInitialScan.model.engageKeywordInitialScan.updateMany({
          where: { id: { in: failedIds } },
          data: {
            status: 'FAILED',
            error: 'Initial keyword scan fan-out failed for this org',
          },
        });
      }
    } catch (err) {
      await this._keywordInitialScan.model.engageKeywordInitialScan.updateMany({
        where: { id: { in: claimedIds } },
        data: {
          status: 'FAILED',
          error: (err as Error).message.slice(0, 1000),
        },
      });
    }
  }

  private async _ensureMissingKeywordInitialScans(
    orgContexts: OrgContext[],
    enabledPlatforms: InitialScanPlatform[]
  ): Promise<void> {
    if (!this._keywordInitialScan) return;
    const rows = orgContexts.flatMap((ctx) =>
      ctx.keywords.flatMap((kw) =>
        enabledPlatforms.map((platform) => ({
          organizationId: ctx.organizationId,
          keywordId: kw.id,
          keyword: kw.keyword,
          platform,
          status: 'PENDING',
        }))
      )
    );
    if (!rows.length) return;
    await this._keywordInitialScan.model.engageKeywordInitialScan.createMany({
      data: rows,
      skipDuplicates: true,
    });
  }

  // X + Reddit keyword firehose, bucketed by scan interval. Each keyword lands in
  // the bucket of its MIN owning-org interval, so a keyword shared with a Pro org
  // (6h) is scanned at 6h while Starter/Developer-only keywords stay at 24h. One
  // cursor per (platform, bucket), keyed __global__:<hours>.
  private async _scanKeywordUnits(
    orgContexts: OrgContext[],
    intervalByOrg: Map<string, number>,
    xPool: TokenPool,
    redditToken: string | null,
    force: boolean
  ): Promise<RawPost[]> {
    // keyword text → min interval hours across orgs that enabled it.
    const minByKeyword = new Map<string, number>();
    for (const c of orgContexts) {
      const hours = this._orgHours(intervalByOrg, c.organizationId);
      for (const k of c.keywords) minMerge(minByKeyword, k.keyword, hours);
    }
    // Group keywords into interval buckets.
    const buckets = new Map<number, string[]>();
    for (const [keyword, hours] of minByKeyword) {
      const arr = buckets.get(hours) ?? [];
      arr.push(keyword);
      buckets.set(hours, arr);
    }

    const posts: RawPost[] = [];
    for (const [hours, bucketKeywords] of buckets) {
      if (!bucketKeywords.length) continue;
      const cadenceMs = hoursToMs(hours);
      for (const platform of ['x', 'reddit'] as const) {
        const r = await this._scanUnit({
          platform,
          scanType: 'keyword',
          // Bucketed key. NOTE: this replaced a single bare `__global__` cursor.
          // On upgrade, any pre-existing bare-`__global__` keyword cursor row is
          // orphaned (no writer/reader references it again); each new bucket
          // starts from a null cursor and re-scans once within the recent,
          // SCAN_MAX_CALLS-bounded window (no full-history storm — X has no
          // since_id, upserts dedup on platform_externalPostId). Self-healing;
          // intentional. To preserve the old incremental position instead, run a
          // one-off: UPDATE "EngageScanCursor" SET "scanKey"='__global__:24'
          //          WHERE "scanType"='keyword' AND "scanKey"='__global__';
          scanKey: `${KEYWORD_GLOBAL_SCAN_KEY}:${hours}`,
          scope: { type: 'keyword' },
          keywords: bucketKeywords,
          cadenceMs,
          force,
          xPool: platform === 'x' ? xPool : undefined,
          redditToken: platform === 'reddit' ? redditToken : null,
        });
        posts.push(...r.posts);
      }
    }
    return posts;
  }

  // One unit per monitored subreddit (keywords OR-batched, restrict_sr). Cadence
  // = min interval across the orgs monitoring that subreddit.
  private async _scanChannelUnits(
    orgContexts: OrgContext[],
    intervalByOrg: Map<string, number>,
    keywords: string[],
    redditToken: string | null,
    force: boolean
  ): Promise<RawPost[]> {
    const minBySubreddit = new Map<string, number>();
    for (const c of orgContexts) {
      const hours = this._orgHours(intervalByOrg, c.organizationId);
      for (const ch of c.monitoredChannels) {
        if (ch.platform === 'reddit') minMerge(minBySubreddit, ch.channelId, hours);
      }
    }

    const posts: RawPost[] = [];
    const scanned: string[] = [];
    for (const [subreddit, hours] of minBySubreddit) {
      const r = await this._scanUnit({
        platform: 'reddit',
        scanType: 'channel',
        scanKey: subreddit,
        scope: { type: 'channel', key: subreddit },
        keywords,
        cadenceMs: hoursToMs(hours),
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

  // One unit per unique tracked username (from:user + keywords). Cadence = min
  // interval across the orgs tracking that username.
  private async _scanTrackedUnits(
    orgContexts: OrgContext[],
    intervalByOrg: Map<string, number>,
    keywords: string[],
    xPool: TokenPool,
    force: boolean
  ): Promise<RawPost[]> {
    if (!xPool.size) return [];
    const accounts = unionTrackedUsernames(orgContexts);
    // username (lowercased) → min interval hours across tracking orgs.
    const minByUsername = new Map<string, number>();
    for (const c of orgContexts) {
      const hours = this._orgHours(intervalByOrg, c.organizationId);
      for (const a of c.trackedAccounts) {
        minMerge(minByUsername, a.username.toLowerCase(), hours);
      }
    }
    const posts: RawPost[] = [];
    for (const [username, records] of accounts) {
      const r = await this._scanUnit({
        platform: 'x',
        scanType: 'tracked',
        scanKey: username,
        scope: { type: 'tracked', key: username },
        keywords,
        cadenceMs: hoursToMs(
          minByUsername.get(username) ?? DEFAULT_SCAN_INTERVAL_HOURS
        ),
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
    /** Effective cadence for this unit (derived from owning orgs' plan). */
    cadenceMs: number;
    force?: boolean;
    xPool?: TokenPool;
    redditToken?: string | null;
  }): Promise<{ ran: boolean; posts: RawPost[] }> {
    const cursor = await this._claimCursor(
      args.platform,
      args.scanType,
      args.scanKey,
      args.cadenceMs,
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
      // Reset lastScanStartedAt so the cadence gate doesn't treat a skipped scan
      // as a completed one — next tick will retry as soon as tokens are available.
      await this._releaseCursor(cursor.id, { resetStartedAt: true });
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
        budget: await this._pacingBudget(args.platform, 'incremental', SCAN_MAX_CALLS),
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
      } else if (result.backlogRemaining) {
        await this._releaseCursor(cursor.id);
        this.logger.warn(
          `${args.platform} ${args.scanType} "${args.scanKey}" hit call budget; backlog remains`
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

  private async _releaseCursor(
    id: string,
    opts: { resetStartedAt?: boolean } = {}
  ): Promise<void> {
    await this._scanCursor.model.engageScanCursor.update({
      where: { id },
      data: {
        status: 'IDLE',
        ...(opts.resetStartedAt && { lastScanStartedAt: null }),
      },
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
          `Scan ${phase} failed for org=${orgContexts[i].organizationId}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)
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
    // Subreddits this org monitors → a Reddit post landing in one earns the +5
    // tracked bonus (重点频道命中), parallel to X tracked accounts. Fires regardless
    // of scan path (keyword OR channel scan) because channelId is the subreddit on
    // every Reddit RawPost.
    const monitoredSubreddits = new Set(
      ctx.monitoredChannels
        .filter((c) => c.platform === 'reddit')
        .map((c) => c.channelId.toLowerCase())
    );

    // Mark posts from this org's tracked sources so the scorer adds the +5 bonus.
    const orgPosts = allRaw.map((p) => {
      const tracked =
        (p.platform === 'x' &&
          trackedUsernames.has(p.authorUsername.toLowerCase())) ||
        (p.platform === 'reddit' &&
          !!p.channelId &&
          monitoredSubreddits.has(p.channelId.toLowerCase()));
      return tracked ? { ...p, isFromTrackedAccount: true } : p;
    });

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

  // The post-scoring ingest pipeline (intent classify → two-table persist →
  // keyword hit counts) is owned by the SHARED EngageScanIngestService so the
  // workflow and the extension scan-ingest endpoint write through one path.
  // Built lazily from the activity's own injected repos so construction (and the
  // unit tests that build this activity directly) stay unchanged.
  private _ingestService?: EngageScanIngestService;
  private get _ingest(): EngageScanIngestService {
    return (this._ingestService ??= new EngageScanIngestService(
      this._opportunity,
      this._oppState,
      this._keyword,
      this._intentClassifier,
      this._tx
    ));
  }

  private _classifyIntents(scored: ScoredPost[]): Promise<ScoredPost[]> {
    return this._ingest.classifyIntents(scored);
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private async _persistOpportunities(
    orgId: string,
    posts: ScoredPost[]
  ): Promise<void> {
    if (!posts.length) return;
    this._heartbeat({ stage: 'persist_opportunities', count: posts.length });

    // Delegated to the shared EngageScanIngestService (one write path for the
    // workflow and the extension scan-ingest endpoint).
    await this._ingest.persistOpportunities(orgId, posts);
  }

  private _updateKeywordHitCounts(
    orgId: string,
    posts: ScoredPost[],
    keywords: EngageKeyword[]
  ): Promise<void> {
    return this._ingest.updateKeywordHitCounts(orgId, posts, keywords);
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

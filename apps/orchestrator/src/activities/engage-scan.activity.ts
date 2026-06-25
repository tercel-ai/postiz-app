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
import {
  EngageScanLeaseService,
  normalizeKeyword,
  normalizeUsername,
} from '@gitroom/nestjs-libraries/engage/engage-scan-lease.service';
import { EngageKeyword } from '@prisma/client';
import { getRedditToken } from '@gitroom/nestjs-libraries/engage/reddit-auth';
import {
  BIZ_USAGE,
  runWithBizUsage,
} from '@gitroom/nestjs-libraries/database/prisma/api-usage/api-usage.service';
import { XScanAdapter } from '@gitroom/nestjs-libraries/engage/scan/x-scan-adapter';
import { RedditScanAdapter } from '@gitroom/nestjs-libraries/engage/scan/reddit-scan-adapter';
import { TokenPool } from '@gitroom/nestjs-libraries/engage/scan/token-pool';
import {
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

// Tracked-account activity backoff. Per-account scanning is cheap but costs N
// calls/tick, so a DORMANT account (no post SEEN in a while — derived from its
// own cursor's lastSeenAt, no schema column) is scanned less often: the cadence
// multiplier grows with dormancy, capped at 4×. A brand-new account (null
// lastSeenAt) uses the base cadence so it establishes a baseline promptly. This
// is what cuts the redundant re-fetching of quiet accounts.
const TRACKED_DORMANT_2X_MS = 2 * 86_400_000; // quiet ≥ 2 days → 2× cadence
const TRACKED_DORMANT_4X_MS = 7 * 86_400_000; // quiet ≥ 7 days → 4× cadence
function trackedBackoffCadenceMs(
  baseMs: number,
  lastSeenAt: Date | null,
  now: Date
): number {
  if (!lastSeenAt) return baseMs;
  const dormantMs = now.getTime() - lastSeenAt.getTime();
  if (dormantMs >= TRACKED_DORMANT_4X_MS) return baseMs * 4;
  if (dormantMs >= TRACKED_DORMANT_2X_MS) return baseMs * 2;
  return baseMs;
}

// X scanning kill switch for the orchestrator (workflow) path. Historically only
// the extension path honoured ENGAGE_SUPPORTED_PLATFORMS, so setting it to
// `reddit` silently left this workflow still hitting the X API. This unifies the
// two: X is OFF when ENGAGE_X_SCAN_ENABLED=false (explicit per-platform toggle)
// OR when ENGAGE_SUPPORTED_PLATFORMS is set and does not list 'x'. When off,
// every X unit (keyword bucket / tracked / initial scan) is skipped; Reddit is
// unaffected. Protects the X account from automation-risk rate-limiting.
export function xScanEnabled(): boolean {
  if ((process.env.ENGAGE_X_SCAN_ENABLED ?? '').trim().toLowerCase() === 'false') {
    return false;
  }
  const allow = process.env.ENGAGE_SUPPORTED_PLATFORMS;
  if (allow && allow.trim()) {
    const set = new Set(
      allow.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean)
    );
    if (!set.has('x')) return false;
  }
  return true;
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

// Map of NORMALIZED tracked username → the account records (with their org)
// across all orgs, so each unique account is fetched once and the result updates
// every org that tracks it. Keyed identically to the per-account scan unit
// (normalizeUsername) so attribution lookups line up.
function unionTrackedUsernames(
  ctxs: OrgContext[]
): Map<string, Array<{ id: string; orgId: string }>> {
  const m = new Map<string, Array<{ id: string; orgId: string }>>();
  for (const c of ctxs) {
    for (const a of c.trackedAccounts) {
      const key = normalizeUsername('x', a.username);
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
// One page by default (no pagination). Overridable per platform via
// `engage.keyword_initial_scan.<platform>.max_calls`. Per-keyword units mean a
// hot keyword no longer needs extra pages to avoid starving others — its own
// newest page within the freshness window is enough.
const DEFAULT_INITIAL_SCAN_MAX_CALLS = 1;

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
  // Freshness windows (ms) per platform, resolved once per tick in runDueScans.
  // Caps how far back a scan looks (now - window) on first scan / long gaps; the
  // adapters apply it (X via start_time, Reddit via its sort=new stop line).
  // Undefined when the platform is disabled or the config service is absent.
  private _xFreshnessWindowMs?: number;
  private _redditFreshnessWindowMs?: number;

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
  /**
   * Per-call page size (X `max_results`) for a scan, resolved from settings
   * (engage.keyword_x_scan_max_results → env → default). X only — Reddit pages on
   * its own size and ignores this. Undefined when not X or when scan config is
   * unavailable (e.g. unit tests build the activity without it), so the adapter
   * falls back to its own default. Never throws — telemetry-grade config read.
   */
  private async _xMaxResults(
    platform: 'x' | 'reddit'
  ): Promise<number | undefined> {
    if (platform !== 'x' || !this._scanConfig) return undefined;
    try {
      return await this._scanConfig.getXScanMaxResults();
    } catch {
      return undefined;
    }
  }

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

    // X kill switch: when X scanning is disabled, never collect X tokens (so the
    // pool is empty) and drop 'x' from every platform list below. Reddit keeps
    // running untouched.
    const xEnabled = xScanEnabled();
    if (!xEnabled) {
      this.logger.log(
        'X scanning disabled (ENGAGE_X_SCAN_ENABLED=false or ENGAGE_SUPPORTED_PLATFORMS excludes x); scanning Reddit only'
      );
    }
    const xPool = new TokenPool(
      xEnabled ? await this._collectXTokens(orgContexts) : []
    );
    const redditToken = await getRedditToken();
    const initialScanSettings = await this._loadInitialScanSettings();
    if (!xEnabled) {
      initialScanSettings.enabledPlatforms =
        initialScanSettings.enabledPlatforms.filter((p) => p !== 'x');
    }

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

    // Resolve the freshness windows once for this tick (settings → env → 24h).
    this._xFreshnessWindowMs =
      xEnabled && this._scanConfig
        ? await this._scanConfig.getFreshnessWindowMs('x')
        : undefined;
    this._redditFreshnessWindowMs = this._scanConfig
      ? await this._scanConfig.getFreshnessWindowMs('reddit')
      : undefined;

    // Resolve each org's plan scan interval once, then derive per-unit cadence.
    const intervalByOrg = await this._orgIntervalHours(orgContexts);

    const posts: RawPost[] = [
      ...(await this._scanKeywordUnits(orgContexts, intervalByOrg, xPool, redditToken, force, xEnabled)),
      ...(await this._scanChannelUnits(orgContexts, intervalByOrg, keywords, redditToken, force)),
      ...(xEnabled
        ? await this._scanTrackedUnits(orgContexts, intervalByOrg, keywords, xPool, force)
        : []),
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
      // Scan API cost is a SHARED/system cost: one search serves every org that
      // subscribes to these keywords (the per-org value is the score
      // distribution recorded in EngageScoreTick during fan-out). So attribute
      // it to org '' (system), not to any single org.
      const result = await runWithBizUsage(
        { bizCategory: BIZ_USAGE.ENGAGE_SCAN },
        async () =>
          adapter.searchScoped({
            scope: { type: 'keyword' },
            keywords: claimedKeywords,
            cursor: platform === 'reddit' ? { lastSeenAt: lookback } : {},
            budget: await this._pacingBudget(platform, 'initial', budget.maxCalls),
            // Per-call page size (X max_results), settings-resolved; Reddit ignores.
            maxResults: await this._xMaxResults(platform),
            // X has no time-cursor here (cursor:{}), so bound the lookback via the
            // adapter's start_time floor — mirrors Reddit's `lastSeenAt: lookback`.
            freshnessWindowMs:
              platform === 'x' ? settings.lookbackHours * 3_600_000 : undefined,
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
          })
      );
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

  // X + Reddit keyword firehose, ONE unit PER KEYWORD (not OR-merged). Each
  // keyword is its own global scan unit keyed by its normalized form, so it
  // shares a single cursor across orgs AND with the extension path (whoever
  // scans first advances it for everyone). This is what kills cross-keyword
  // starvation: a hot keyword can no longer eat a low-volume keyword's page
  // budget, because every keyword paginates on its own cursor + budget. Cadence
  // = MIN interval across the orgs that enabled that keyword (a keyword shared
  // with a Pro 6h org scans at 6h; Starter-only keywords stay at 24h).
  //
  // Migration note: this replaces the old bucketed `__global__:<hours>` cursor.
  // On upgrade those bucket rows are orphaned (nothing references them again);
  // each per-keyword cursor starts from null and re-scans once within the
  // freshness window (bounded by SCAN_MAX_CALLS + start_time), so no full-history
  // storm. Self-healing; intentional.
  private async _scanKeywordUnits(
    orgContexts: OrgContext[],
    intervalByOrg: Map<string, number>,
    xPool: TokenPool,
    redditToken: string | null,
    force: boolean,
    xEnabled = true
  ): Promise<RawPost[]> {
    // normalized keyword (= the global per-keyword cursor key) → min interval
    // hours across the orgs that enabled it. Normalising collapses "AI"/" ai "
    // to one unit, matching the extension path's keying.
    const minByKeyword = new Map<string, number>();
    for (const c of orgContexts) {
      const hours = this._orgHours(intervalByOrg, c.organizationId);
      for (const k of c.keywords) {
        const scanKey = normalizeKeyword(k.keyword);
        if (scanKey) minMerge(minByKeyword, scanKey, hours);
      }
    }

    const platforms: ReadonlyArray<'x' | 'reddit'> = xEnabled
      ? ['x', 'reddit']
      : ['reddit'];
    const posts: RawPost[] = [];
    for (const [keyword, hours] of minByKeyword) {
      const cadenceMs = hoursToMs(hours);
      for (const platform of platforms) {
        const r = await this._scanUnit({
          platform,
          scanType: 'keyword',
          scanKey: keyword,
          scope: { type: 'keyword' },
          keywords: [keyword],
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

  // Tracked accounts: ONE unit PER account (not OR-merged), keyed by the
  // normalized username so the cursor is shared across orgs AND with the
  // extension path. This kills the merged-bucket starvation (a high-volume
  // account could push the shared since_id past a quiet account's posts) and the
  // 512-char author-clause split that starved later batches. Each account runs
  // `from:<account> (kw...)` on its own cursor + 1-page budget; tracked is
  // X-only (Reddit has no tracked scope). Cadence = MIN interval across the orgs
  // tracking it. Migration: old `__tracked__:<hours>` bucket cursors are orphaned
  // on upgrade (self-healing; per-account cursors re-scan once within the
  // freshness window). Post→account attribution is recovered at ingest time.
  private async _scanTrackedUnits(
    orgContexts: OrgContext[],
    intervalByOrg: Map<string, number>,
    keywords: string[],
    xPool: TokenPool,
    force: boolean
  ): Promise<RawPost[]> {
    if (!xPool.size) return [];
    const accounts = unionTrackedUsernames(orgContexts);
    if (!accounts.size) return [];
    // normalized username (= per-account cursor key) → min interval hours.
    const minByUsername = new Map<string, number>();
    for (const c of orgContexts) {
      const hours = this._orgHours(intervalByOrg, c.organizationId);
      for (const a of c.trackedAccounts) {
        minMerge(minByUsername, normalizeUsername('x', a.username), hours);
      }
    }

    const posts: RawPost[] = [];
    for (const [username, hours] of minByUsername) {
      const r = await this._scanUnit({
        platform: 'x',
        scanType: 'tracked',
        scanKey: username,
        scope: { type: 'tracked', key: username },
        keywords,
        cadenceMs: hoursToMs(hours),
        // Back off dormant accounts (scanned less often the longer they've been
        // quiet), keyed off this account's own cursor lastSeenAt.
        cadenceFn: (row, now) =>
          trackedBackoffCadenceMs(hoursToMs(hours), row.lastSeenAt, now),
        xPool,
        force,
      });
      posts.push(...r.posts);
      // Only touch the account bookkeeping if the unit actually ran this tick.
      if (!r.ran) continue;
      await this._updateTrackedAccountsFromPosts([username], accounts, r.posts);
    }
    return posts;
  }

  // After a tracked scan, bump lastCheckedAt for the scanned account(s) and
  // refresh avatar/display-name for any that actually authored a post this run —
  // matched by author handle, normalized the same way as the unit key.
  private async _updateTrackedAccountsFromPosts(
    usernames: string[],
    accounts: Map<string, Array<{ id: string; orgId: string }>>,
    posts: RawPost[]
  ): Promise<void> {
    // normalized author handle → first seen profile this run.
    const profileByUser = new Map<
      string,
      { picture?: string; displayName?: string }
    >();
    for (const p of posts) {
      const u = p.authorUsername ? normalizeUsername('x', p.authorUsername) : '';
      if (!u || profileByUser.has(u)) continue;
      profileByUser.set(u, {
        picture: p.authorAvatarUrl,
        displayName: p.authorDisplayName,
      });
    }
    for (const username of usernames) {
      const records = accounts.get(username);
      if (!records) continue;
      const profile = profileByUser.get(username);
      for (const rec of records) {
        await this._updateTrackedAccountAfterScan(rec.id, profile);
      }
    }
  }

  // ─── Cursor-driven scan of one unit ──────────────────────────────────────

  private async _scanUnit(args: {
    platform: 'x' | 'reddit';
    scanType: ScanType;
    scanKey: string;
    scope: ScanScope;
    keywords: string[];
    /** Base cadence for this unit (derived from owning orgs' plan). */
    cadenceMs: number;
    /** Optional per-unit dynamic cadence (e.g. dormant-account backoff). */
    cadenceFn?: (row: { lastSeenAt: Date | null }, now: Date) => number;
    force?: boolean;
    xPool?: TokenPool;
    redditToken?: string | null;
  }): Promise<{ ran: boolean; posts: RawPost[] }> {
    const cursor = await this._lease.claim({
      platform: args.platform,
      scanType: args.scanType,
      scanKey: args.scanKey,
      cadenceMs: args.cadenceMs,
      cadenceFn: args.cadenceFn,
      force: args.force ?? false,
    });
    // Not due yet, cooling down, actively leased, or lost a single-flight race.
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
      await this._lease.release(cursor.id, { resetStartedAt: true });
      return { ran: false, posts: [] };
    }

    try {
      // Shared/system scan cost (one unit serves all subscribing orgs); see the
      // initial-scan note above. org '' = system.
      const result = await runWithBizUsage(
        { bizCategory: BIZ_USAGE.ENGAGE_SCAN },
        async () =>
          adapter.searchScoped({
            scope: args.scope,
            keywords: args.keywords,
            cursor: {
              lastSeenExternalId: cursor.lastSeenExternalId,
              lastSeenAt: cursor.lastSeenAt,
            },
            budget: await this._pacingBudget(
              args.platform,
              'incremental',
              SCAN_MAX_CALLS
            ),
            // Per-call page size (X max_results), settings-resolved; Reddit ignores.
            maxResults: await this._xMaxResults(args.platform),
            // Freshness cap per platform (X via start_time, Reddit via its sort=new
            // stop line); undefined ⇒ adapter keeps legacy (uncapped) behaviour.
            freshnessWindowMs:
              args.platform === 'x'
                ? this._xFreshnessWindowMs
                : this._redditFreshnessWindowMs,
            token,
            log: {
              log: (m) => this.logger.log(m),
              warn: (m) => this.logger.warn(m),
            },
            heartbeat: (p) => this._heartbeat(p),
          })
      );
      if (args.platform === 'x' && token && args.xPool) {
        args.xPool.report(token, result.rate);
      }

      if (result.rate.limited) {
        const until = new Date(
          Date.now() + (result.rate.retryAfterMs ?? DEFAULT_COOLDOWN_MS)
        );
        // Do NOT advance the cursor — retry from the same point after cool-down.
        await this._lease.cooldown(cursor.id, until);
        this.logger.warn(
          `${args.platform} ${args.scanType} "${args.scanKey}" rate-limited; cooling down until ${until.toISOString()}`
        );
      } else if (result.backlogRemaining) {
        // Budget exhausted with more pages available. Under 1-page incremental
        // pacing, NOT advancing would re-fetch the SAME newest page every cadence
        // (the cursor never moves) and a hot unit would never progress — wasteful
        // and stuck. Advance to the newest seen so the unit always moves forward;
        // the unscanned middle of this window is intentionally bounded by the
        // per-unit budget + freshness window (newest-first is what engagement
        // wants anyway). Rate-limit (above) still does NOT advance.
        await this._lease.complete(cursor.id, result.nextCursor);
        this.logger.warn(
          `${args.platform} ${args.scanType} "${args.scanKey}" hit call budget; advanced cursor to newest (backlog dropped)`
        );
      } else {
        await this._lease.complete(cursor.id, result.nextCursor);
      }
      return { ran: true, posts: result.posts };
    } catch (err) {
      this.logger.warn(
        `Scan unit ${args.platform}/${args.scanType}/${args.scanKey} failed: ${(err as Error).message}`
      );
      await this._lease.release(cursor.id);
      return { ran: false, posts: [] };
    }
  }

  // ─── EngageScanCursor lifecycle ──────────────────────────────────────────
  // The cursor claim/complete/cooldown/release is owned by the SHARED
  // EngageScanLeaseService (one implementation for the workflow and the
  // extension scan path). Built lazily from this activity's own injected
  // scan-cursor repo so construction (and the unit tests that build this
  // activity directly) stay unchanged. Using the shared `claim` gives the
  // workflow the stale-SCANNING reclaim it previously lacked: a worker that
  // crashes mid-scan no longer strands the unit in SCANNING forever — the lease
  // self-heals after SCAN_LEASE_TTL_MS.
  private _leaseService?: EngageScanLeaseService;
  private get _lease(): EngageScanLeaseService {
    return (this._leaseService ??= new EngageScanLeaseService(this._scanCursor));
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

    // Score-distribution telemetry (EngageScoreTick), mirroring ingestForOrg so
    // the workflow scan populates it too. 'scanned' = every keyword-matched post
    // (incl. below the gate → the low buckets); recorded even when nothing
    // reaches MIN_SCORE so an empty-yield window is still visible.
    this._ingest.recordScoreDistribution(ctx.organizationId, 'scanned', matched);

    if (scored.length) {
      this._ingest.recordScoreDistribution(ctx.organizationId, 'persisted', scored);
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

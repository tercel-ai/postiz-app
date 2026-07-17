import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, EngageOpportunity, EngageOpportunityStatus } from '@prisma/client';
import { PrismaRepository, PrismaTransaction, PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  AddKeywordDto,
  AddKeywordsBulkDto,
  AddMonitoredChannelDto,
  AddTrackedAccountDto,
  ListOpportunitiesDto,
  ListSentDto,
  LocateOpportunityDto,
  LocateSentReplyDto,
  OpportunityCountsDto,
  SetupEngageDto,
  UpdateKeywordDto,
  UpdateMonitoredChannelDto,
  UpdateReplyAccountDto,
  UpdateTrackedAccountDto,
} from '@gitroom/nestjs-libraries/engage/dtos/engage.dto';
import { DEFAULT_SCAN_INTERVAL_HOURS } from '@gitroom/nestjs-libraries/engage/engage-entitlement.service';
import {
  normalizeKeyword,
  normalizeUsername,
  isValidUsername,
} from '@gitroom/nestjs-libraries/engage/engage-scan-lease.service';
import {
  pickXReplyIntegration,
  XReplyResolution,
} from '@gitroom/nestjs-libraries/engage/resolve-x-reply-integration';
import { classifyReplyMetric, normalizeReplyMetrics } from '@gitroom/nestjs-libraries/engage/engage-metrics-stats';
import { parseXTweetId } from '@gitroom/nestjs-libraries/engage/x-tweet';
import { EngageAuthorProfile } from '@gitroom/nestjs-libraries/engage/engage-author';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import utc from 'dayjs/plugin/utc';

dayjs.extend(isoWeek);
dayjs.extend(utc);

// getOrgScanStatus derives "next scan" = lastScanStartedAt + cadence (or
// cooldownUntil, whichever is later). The activity/workflows own the actual
// scheduling; this only reports the derived timing to the UI. Cadence is the
// org's plan scan_interval_hours, passed in by the caller (single interval for
// keyword/channel/tracked alike); falls back to DEFAULT_SCAN_INTERVAL_HOURS.
const INITIAL_SCAN_PLATFORMS = ['reddit', 'x'] as const;

// Default minimum score for the opportunities feed (list/locate) when the caller
// omits `minScore`. Deliberately SEPARATE from the ingest gate ENGAGE_MIN_SCORE
// (engage-scan-ingest.service.ts): that gate controls what gets persisted (now
// 0 = persist everything, e.g. for full cost accounting), while this is the
// display quality bar. Defaults to 60 to preserve the pre-change feed behaviour
// (when the ingest gate was 60, the unfiltered feed effectively showed >=60).
// Pass minScore=0 explicitly to surface everything.
const LIST_DEFAULT_MIN_SCORE = Number(
  process.env.ENGAGE_LIST_DEFAULT_MIN_SCORE ?? 60
);

// Only NEW/AUTO_QUEUED opportunities can be replied to. Every other status is a
// terminal/non-actionable state — map each to a precise, human-readable reason
// (code + message) so the reply gate can tell the user *why* generation is
// blocked instead of a generic 404. The gate trusts this persisted status; it
// never recomputes expiry from the post's age.
const NON_ACTIONABLE_REPLY_REASONS: Record<
  EngageOpportunityStatus,
  { code: string; message: string } | null
> = {
  NEW: null,
  AUTO_QUEUED: null,
  EXPIRED: {
    code: 'engage_opportunity_expired',
    message:
      'This opportunity has expired and can no longer be replied to. It dropped out of the actionable feed because it is no longer fresh.',
  },
  REPLIED: {
    code: 'engage_opportunity_replied',
    message: 'You have already replied to this opportunity.',
  },
  SCHEDULED: {
    code: 'engage_opportunity_scheduled',
    message:
      'A reply to this opportunity is already scheduled. Cancel the scheduled reply before generating a new draft.',
  },
  DISMISSED: {
    code: 'engage_opportunity_dismissed',
    message:
      'This opportunity was dismissed. Restore it from the feed before replying.',
  },
};

export interface ScanTiming {
  lastScanAt: Date | null; // most recent successful completion
  nextScanAt: Date | null; // earliest upcoming scan (derived, not stored)
}

// One entry in EngageOpportunityState.generationHistory — a single AI reply draft
// the org generated for the opportunity. Appended on every successful generation
// (the user may regenerate many times), so the whole array is the version history.
// `billingTaskId` links to the BillingRecord (taskId) charged for THIS generation,
// closing the audit loop between "what was generated" and "what was billed".
export interface GenerationHistoryEntry {
  // Provenance of this entry's content: 'ai' = produced by a charged generateDraft
  // call (the live path always writes 'ai'); 'manual' = hand-typed / hand-saved with
  // no AI charge (only ever produced by the historical backfill, which infers it from
  // the absence of an engage_reply BillingRecord). Lets the UI label each version.
  source: 'ai' | 'manual';
  content: string;
  strategy: string;
  brandStrength: number;
  mentions?: string[];
  createdAt: string; // ISO timestamp
  // AI-only fields — absent on 'manual' entries (hand-typed work has no length
  // tier and is NEVER charged, so it has no BillingRecord). `billingTaskId` present
  // ⟺ a real engage_reply charge exists (the audit link to BillingRecord.taskId).
  length?: 'short' | 'medium' | 'long';
  cost?: number; // credits charged for this generation
  billingTaskId?: string; // → BillingRecord.taskId
  // Set ONLY by the historical backfill script; absent on live entries. Lets a
  // re-run tell its own reconstructed rows apart from live-generated ones (a live
  // 'ai' draft lives only here, so it must not be clobbered by a re-backfill).
  backfilled?: boolean;
}

// Coerce the stored generationHistory Json (null | unknown[]) into a clean,
// newest-first GenerationHistoryEntry[]. Tolerant of legacy/malformed rows: a
// non-array stored value yields [] rather than throwing in a list response.
function normalizeGenerationHistory(value: unknown): GenerationHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return (value as GenerationHistoryEntry[]).slice().reverse();
}

export interface OrgScanStatus {
  lastScanAt: Date | null;
  nextScanAt: Date | null;
  keyword: ScanTiming; // org-independent global firehose (X + Reddit)
  channel: ScanTiming; // this org's monitored subreddits
  tracked: ScanTiming; // this org's tracked accounts
}

type ScanCursorTiming = {
  lastScanStartedAt: Date | null;
  lastScannedAt: Date | null;
  cooldownUntil: Date | null;
};

// next = max(lastScanStartedAt + cadence, cooldownUntil). Anchored to scan
// START (not duration) so scan length never affects the next-due time; a unit
// never scanned is due now. cooldownUntil pushes it out under rate-limit.
function deriveNext(row: ScanCursorTiming, cadenceMs: number, now: number): number {
  const base = row.lastScanStartedAt
    ? row.lastScanStartedAt.getTime() + cadenceMs
    : now;
  const cd = row.cooldownUntil ? row.cooldownUntil.getTime() : 0;
  return Math.max(base, cd);
}

function aggregateScan(
  rows: ScanCursorTiming[],
  cadenceMs: number,
  now: number
): ScanTiming {
  if (!rows.length) return { lastScanAt: null, nextScanAt: null };
  const lasts = rows
    .map((r) => r.lastScannedAt?.getTime())
    .filter((n): n is number => n != null);
  const nexts = rows.map((r) => deriveNext(r, cadenceMs, now));
  return {
    lastScanAt: lasts.length ? new Date(Math.max(...lasts)) : null,
    nextScanAt: nexts.length ? new Date(Math.min(...nexts)) : null,
  };
}

function maxDate(ds: (Date | null)[]): Date | null {
  const ts = ds.filter((d): d is Date => d != null).map((d) => d.getTime());
  return ts.length ? new Date(Math.max(...ts)) : null;
}

function minDate(ds: (Date | null)[]): Date | null {
  const ts = ds.filter((d): d is Date => d != null).map((d) => d.getTime());
  return ts.length ? new Date(Math.min(...ts)) : null;
}

/**
 * Pull the reply author (engageAuthor) out of a Post.settings JSON blob. Returns
 * null when settings is absent/unparseable or carries no engageAuthor.
 */
function parseEngageAuthor(settings: string | null): EngageAuthorProfile | null {
  if (!settings) return null;
  try {
    const parsed = JSON.parse(settings) as { engageAuthor?: EngageAuthorProfile };
    return parsed?.engageAuthor ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a single, unified `replyAuthor` (who posted the reply) so the frontend
 * reads one field regardless of source. settings.engageAuthor is the source of
 * truth — it records who ACTUALLY posted (e.g. the browser extension's in-browser
 * X session under Option A, which can differ from the selected integration). Only
 * when no engageAuthor is recorded do we fall back to the connected integration.
 */
function resolveReplyAuthor(
  integration:
    | { profile: string | null; internalId: string | null; name: string | null; picture: string | null }
    | null
    | undefined,
  settings: string | null
): EngageAuthorProfile | null {
  const fromSettings = parseEngageAuthor(settings);
  if (fromSettings) return fromSettings;

  if (integration) {
    return {
      handle: (integration.profile ?? '').replace(/^@/, ''),
      ...(integration.internalId ? { id: integration.internalId } : {}),
      ...(integration.name ? { name: integration.name } : {}),
      ...(integration.picture ? { avatarUrl: integration.picture } : {}),
    };
  }
  return null;
}

@Injectable()
export class EngageRepository {
  constructor(
    private _config: PrismaRepository<'engageConfig'>,
    private _keyword: PrismaRepository<'engageKeyword'>,
    private _channel: PrismaRepository<'engageMonitoredChannel'>,
    private _trackedAccount: PrismaRepository<'engageTrackedAccount'>,
    private _replyAccount: PrismaRepository<'engageXReplyAccount'>,
    private _opportunity: PrismaRepository<'engageOpportunity'>,
    private _oppState: PrismaRepository<'engageOpportunityState'>,
    private _sentReply: PrismaRepository<'engageSentReply'>,
    private _integration: PrismaRepository<'integration'>,
    private _post: PrismaRepository<'post'>,
    private _tx: PrismaTransaction,
    private _scanCursor: PrismaRepository<'engageScanCursor'>,
    private _keywordInitialScan: PrismaRepository<'engageKeywordInitialScan'>
  ) {}

  // Runs a create that may hit a unique constraint and converts the resulting
  // Prisma P2002 into a readable 409 ConflictException instead of letting it
  // bubble up as a generic 500. `label` describes the duplicated entity, e.g.
  // `Keyword "nestjs"`.
  private async _createOrConflict<T>(
    label: string,
    op: () => Promise<T>
  ): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(`${label} already exists`);
      }
      throw err;
    }
  }

  // ─── Config ────────────────────────────────────────────────────────────────

  async getOrCreateConfig(organizationId: string, projectId: string | null = null) {
    const include = {
      keywords: {
        orderBy: { createdAt: 'asc' as const },
        include: { initialScans: { orderBy: { platform: 'asc' as const } } },
      },
      monitoredChannels: { orderBy: { createdAt: 'asc' as const } },
      trackedAccounts: { orderBy: { createdAt: 'asc' as const } },
      xReplyAccounts: {
        include: {
          integration: {
            select: {
              id: true,
              name: true,
              providerIdentifier: true,
              picture: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' as const },
      },
    };

    if (projectId != null) {
      // Atomic upsert: two concurrent first-call requests would otherwise both
      // miss findFirst and race on create → Prisma P2002 unique violation.
      return this._config.model.engageConfig.upsert({
        where: { organizationId_projectId: { organizationId, projectId } },
        create: { organizationId, projectId, enabled: false },
        update: {},
        include,
      });
    }

    // Legacy null-project row: a nullable column can never satisfy a
    // compound-unique upsert (Postgres NULL != NULL) — same accepted
    // transient-migration race as EngageScanIngestService's
    // _upsertOpportunityState (collapses away once projectId is required,
    // §11 step 8). Not a behavior change today: this is the only path any
    // current caller exercises (none pass a real projectId yet).
    const existing = await this._config.model.engageConfig.findFirst({
      where: { organizationId, projectId: null },
      include,
    });
    if (existing) return existing;
    return this._config.model.engageConfig.create({
      data: { organizationId, projectId: null, enabled: false },
      include,
    });
  }

  async getAllEnabledOrgContexts() {
    return this._config.model.engageConfig.findMany({
      where: { enabled: true },
      include: {
        keywords: {
          where: { enabled: true },
          orderBy: { createdAt: 'asc' },
        },
        monitoredChannels: {
          where: { enabled: true },
          orderBy: { createdAt: 'asc' },
        },
        trackedAccounts: {
          where: { enabled: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  /**
   * One project's enabled engage context (keywords/channels/tracked) for unit
   * enumeration. Null when that project has no enabled engage config.
   *
   * projectId defaults to null (the legacy, pre-project config row) because
   * every current caller — the browser-extension scan-ingest endpoints — is
   * still org-scoped end to end, not yet project-scoped (§14 step 6). An org
   * with more than one project's config enabled would only ever surface the
   * null-project one here; that is unchanged behavior, not a regression this
   * step introduces.
   */
  async getEnabledOrgContext(organizationId: string, projectId: string | null = null) {
    return this._config.model.engageConfig.findFirst({
      where: { organizationId, projectId, enabled: true },
      include: {
        keywords: { where: { enabled: true }, orderBy: { createdAt: 'asc' } },
        monitoredChannels: { where: { enabled: true }, orderBy: { createdAt: 'asc' } },
        trackedAccounts: { where: { enabled: true }, orderBy: { createdAt: 'asc' } },
      },
    });
  }

  /**
   * Recent non-deleted global opportunities on the given platforms, newest
   * first, capped. Source for back-attributing existing opportunities to a newly
   * subscribed org (no platform fetch). `since` bounds it to the monitoring
   * window; `limit` bounds the re-score cost.
   */
  async getRecentGlobalOpportunities(
    platforms: string[],
    since: Date,
    limit: number
  ) {
    return this._opportunity.model.engageOpportunity.findMany({
      where: {
        platform: { in: platforms },
        deletedAt: null,
        postPublishedAt: { gte: since },
      },
      orderBy: { postPublishedAt: 'desc' },
      take: limit,
      select: {
        id: true, platform: true, externalPostId: true, externalPostUrl: true,
        channelId: true, channelName: true, channelFollowers: true,
        authorUsername: true, authorDisplayName: true, authorFollowers: true,
        authorAvatarUrl: true, postContent: true, postPublishedAt: true,
        metricLikes: true, metricReplies: true, metricRetweets: true,
        metricQuotes: true, metricBookmarks: true, metricViews: true,
        metricShares: true, metricSaves: true, metricScore: true,
        metricUpvoteRatio: true, metricComments: true,
      },
    });
  }

  /** Resolve a SCANNING scan cursor by its lease token (the extension's taskId).
   * Returns the unit identity needed to fan out; null when the token is
   * invalid/expired/rotated. */
  async findScanCursorByToken(leaseToken: string) {
    return this._scanCursor.model.engageScanCursor.findFirst({
      where: { leaseToken, status: 'SCANNING' },
      select: { id: true, platform: true, scanType: true, scanKey: true },
    });
  }

  /**
   * Org contexts SUBSCRIBED to one global scan unit — i.e. the orgs a freshly
   * scanned unit should fan out to. Used by the extension scan-ingest endpoint:
   * the browser scans a unit once, and the server scores+persists for every org
   * that subscribes to it (keyword enabled / subreddit monitored / author
   * tracked), so one fetch benefits everyone (cross-org dedup).
   *
   * For keyword, the unit key is the NORMALIZED keyword. Keywords are
   * trim+collapse normalised at write time (AddKeywordDto), so a stored value
   * differs from its normalised key only in CASE — hence the SQL
   * `equals … insensitive` pre-filter is sufficient, and the in-code
   * normalizeKeyword filter is a belt-and-braces guard for any legacy rows
   * persisted before write-time normalisation existed.
   */
  async getOrgContextsForUnit(
    platform: string,
    scanType: 'keyword' | 'channel' | 'tracked',
    scanKey: string
  ) {
    const include = {
      keywords: { where: { enabled: true }, orderBy: { createdAt: 'asc' as const } },
      monitoredChannels: { where: { enabled: true }, orderBy: { createdAt: 'asc' as const } },
      trackedAccounts: { where: { enabled: true }, orderBy: { createdAt: 'asc' as const } },
    };

    if (scanType === 'channel') {
      return this._config.model.engageConfig.findMany({
        where: {
          enabled: true,
          monitoredChannels: { some: { enabled: true, platform, channelId: scanKey } },
        },
        include,
      });
    }

    if (scanType === 'tracked') {
      return this._config.model.engageConfig.findMany({
        where: {
          enabled: true,
          trackedAccounts: {
            some: {
              enabled: true,
              platform,
              username: { equals: scanKey, mode: 'insensitive' },
            },
          },
        },
        include,
      });
    }

    const configs = await this._config.model.engageConfig.findMany({
      where: {
        enabled: true,
        keywords: {
          some: { enabled: true, keyword: { equals: scanKey, mode: 'insensitive' } },
        },
      },
      include,
    });
    return configs.filter((c) =>
      c.keywords.some((k) => k.enabled && normalizeKeyword(k.keyword) === scanKey)
    );
  }

  /**
   * Per-keyword ACTIVATED-subscriber counts across all orgs. "Activated" means
   * the keyword actually runs: EngageConfig.enabled = true AND
   * EngageKeyword.enabled = true. Merely ADDING a keyword to a disabled config,
   * or disabling the keyword, does NOT count. Keys are NORMALIZED
   * (normalizeKeyword), so case/whitespace variants of the same keyword collapse
   * into one row — matching the global scan-unit key. `activatedOrgs` is the
   * distinct org count (engage is per-org); `variants` lists the raw spellings
   * that mapped in. Sorted by activatedOrgs desc. Deliberately a LIVE query, not
   * a persisted counter, so it never drifts as orgs enable/disable. Super-admin
   * / global use only.
   */
  async getKeywordActivationStats(): Promise<
    Array<{ keyword: string; activatedOrgs: number; variants: string[] }>
  > {
    const rows = await this._keyword.model.engageKeyword.findMany({
      where: { enabled: true, config: { enabled: true } },
      select: { keyword: true, organizationId: true },
    });
    // Group by normalized key → distinct orgs + the raw spellings seen.
    const byKey = new Map<
      string,
      { orgs: Set<string>; variants: Set<string> }
    >();
    for (const r of rows) {
      const key = normalizeKeyword(r.keyword);
      if (!key) continue;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { orgs: new Set(), variants: new Set() };
        byKey.set(key, entry);
      }
      entry.orgs.add(r.organizationId);
      entry.variants.add(r.keyword);
    }
    return Array.from(byKey, ([keyword, { orgs, variants }]) => ({
      keyword,
      activatedOrgs: orgs.size,
      variants: Array.from(variants),
    })).sort((a, b) => b.activatedOrgs - a.activatedOrgs);
  }

  async saveConfig(
    organizationId: string,
    data: Partial<{ enabled: boolean; lastScanAt: Date }>,
    projectId: string | null = null
  ) {
    if (projectId != null) {
      return this._config.model.engageConfig.upsert({
        where: { organizationId_projectId: { organizationId, projectId } },
        create: { organizationId, projectId, ...data },
        update: data,
      });
    }
    // Legacy null-project row — see getOrCreateConfig's note (nullable column
    // can't back a compound-unique upsert).
    const existing = await this._config.model.engageConfig.findFirst({
      where: { organizationId, projectId: null },
      select: { id: true },
    });
    if (existing) {
      return this._config.model.engageConfig.update({
        where: { id: existing.id },
        data,
      });
    }
    return this._config.model.engageConfig.create({
      data: { organizationId, projectId: null, ...data },
    });
  }

  async resetConfig(organizationId: string, projectId: string | null = null) {
    if (projectId != null) {
      return this._config.model.engageConfig.update({
        where: { organizationId_projectId: { organizationId, projectId } },
        data: { enabled: false },
      });
    }
    const existing = await this._config.model.engageConfig.findFirst({
      where: { organizationId, projectId: null },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException('Engage config not found');
    }
    return this._config.model.engageConfig.update({
      where: { id: existing.id },
      data: { enabled: false },
    });
  }

  // Per-org scan timing, derived from the shared EngageScanCursor rows. The
  // keyword firehose is org-independent (one cursor per platform), while
  // channel/tracked timing comes from the cursors for THIS org's monitored
  // subreddits / tracked usernames. "Next scan" is derived (lastScanStartedAt +
  // env cadence, or cooldownUntil) — never stored — so changing the cadence env
  // is reflected immediately. A scoped type the org hasn't configured reports
  // null/null. NOTE: a keyword/subreddit shared with a more aggressive org is
  // scanned on that org's cadence, so the reported time can be fresher than this
  // org's own interval — intentional (shared data, always fresher is fine).
  async getOrgScanStatus(
    organizationId: string,
    scanIntervalHours: number = DEFAULT_SCAN_INTERVAL_HOURS
  ): Promise<OrgScanStatus> {
    const now = Date.now();
    const cadenceMs =
      (Number.isFinite(scanIntervalHours) && scanIntervalHours > 0
        ? scanIntervalHours
        : DEFAULT_SCAN_INTERVAL_HOURS) * 3_600_000;

    const [subs, tracked, keywords] = await Promise.all([
      this._channel.model.engageMonitoredChannel.findMany({
        where: { organizationId, platform: 'reddit', enabled: true },
        select: { channelId: true },
      }),
      this._trackedAccount.model.engageTrackedAccount.findMany({
        where: { organizationId, enabled: true },
        select: { username: true },
      }),
      this._keyword.model.engageKeyword.findMany({
        where: { organizationId, enabled: true },
        select: { keyword: true },
      }),
    ]);
    const subredditIds = subs.map((s) => s.channelId);
    // Tracked accounts are scanned as per-account X units keyed by their
    // normalized username (matching the writer + extension), so look up cursors
    // by those keys.
    const usernames = tracked.map((t) => normalizeUsername('x', t.username));
    // Keywords are scanned as per-keyword global units keyed by their normalized
    // form (shared across orgs + the extension path), so look up THIS org's
    // keyword cursors by those keys — mirroring the channel/tracked lookups.
    const keywordKeys = Array.from(
      new Set(keywords.map((k) => normalizeKeyword(k.keyword)).filter(Boolean))
    );

    const [keywordCursors, channelCursors, trackedCursors] = await Promise.all([
      keywordKeys.length
        ? this._scanCursor.model.engageScanCursor.findMany({
            where: { scanType: 'keyword', scanKey: { in: keywordKeys } },
          })
        : Promise.resolve([]),
      subredditIds.length
        ? this._scanCursor.model.engageScanCursor.findMany({
            where: {
              platform: 'reddit',
              scanType: 'channel',
              scanKey: { in: subredditIds },
            },
          })
        : Promise.resolve([]),
      usernames.length
        ? this._scanCursor.model.engageScanCursor.findMany({
            where: {
              platform: 'x',
              scanType: 'tracked',
              scanKey: { in: usernames },
            },
          })
        : Promise.resolve([]),
    ]);

    const keyword = aggregateScan(keywordCursors, cadenceMs, now);
    const channel = aggregateScan(channelCursors, cadenceMs, now);
    const trackedAgg = aggregateScan(trackedCursors, cadenceMs, now);

    return {
      lastScanAt: maxDate([keyword.lastScanAt, channel.lastScanAt, trackedAgg.lastScanAt]),
      nextScanAt: minDate([keyword.nextScanAt, channel.nextScanAt, trackedAgg.nextScanAt]),
      keyword,
      channel,
      tracked: trackedAgg,
    };
  }

  /**
   * Per-keyword per-platform scan cursor times for this org's active keywords.
   * Returns a map: normalizedKey → array of { platform, lastScannedAt, lastScanStartedAt, cooldownUntil }.
   * Used by getConfig to annotate each keyword with its actual scan history.
   */
  async getKeywordCursors(
    keywordKeys: string[],
    cadenceMs: number,
    now: number = Date.now()
  ): Promise<
    Record<
      string,
      { platform: string; lastScannedAt: Date | null; nextScanAt: Date | null }[]
    >
  > {
    if (!keywordKeys.length) return {};
    const rows = await this._scanCursor.model.engageScanCursor.findMany({
      where: { scanType: 'keyword', scanKey: { in: keywordKeys } },
      select: {
        platform: true,
        scanKey: true,
        lastScannedAt: true,
        lastScanStartedAt: true,
        cooldownUntil: true,
      },
    });
    const out: Record<
      string,
      { platform: string; lastScannedAt: Date | null; nextScanAt: Date | null }[]
    > = {};
    for (const row of rows) {
      const next = new Date(deriveNext(row, cadenceMs, now));
      (out[row.scanKey] ??= []).push({
        platform: row.platform,
        lastScannedAt: row.lastScannedAt,
        nextScanAt: next,
      });
    }
    return out;
  }

  /**
   * Per-channel scan cursor times for this org's monitored subreddits. Mirrors
   * getKeywordCursors so the config API reports the SAME source of truth
   * (EngageScanCursor) for channels as for keywords — NOT the per-row
   * EngageMonitoredChannel.lastScannedAt bookkeeping field, which only the
   * workflow writes (so a unit advanced by the extension scan path left it stale
   * and the UI showed an old "last scanned" while the cursor was fresh).
   * Keyed by the caller's original `${platform}:${channelId}`.
   */
  async getChannelCursors(
    channels: { platform: string; channelId: string }[],
    cadenceMs: number,
    now: number = Date.now()
  ): Promise<
    Record<string, { lastScannedAt: Date | null; nextScanAt: Date | null }>
  > {
    if (!channels.length) return {};
    const keys = Array.from(new Set(channels.map((c) => c.channelId)));
    const rows = await this._scanCursor.model.engageScanCursor.findMany({
      where: { scanType: 'channel', scanKey: { in: keys } },
      select: {
        platform: true,
        scanKey: true,
        lastScannedAt: true,
        lastScanStartedAt: true,
        cooldownUntil: true,
      },
    });
    const out: Record<
      string,
      { lastScannedAt: Date | null; nextScanAt: Date | null }
    > = {};
    for (const row of rows) {
      out[`${row.platform}:${row.scanKey}`] = {
        lastScannedAt: row.lastScannedAt,
        nextScanAt: new Date(deriveNext(row, cadenceMs, now)),
      };
    }
    return out;
  }

  /**
   * Per-account scan cursor times for this org's tracked accounts. Same rationale
   * as getChannelCursors: report EngageScanCursor truth, not the workflow-only
   * EngageTrackedAccount.lastCheckedAt. The cursor scanKey is the NORMALIZED
   * username; normalisation is done here so the caller (getConfig) can key by the
   * ORIGINAL `${platform}:${username}` and needs no normaliser of its own.
   */
  async getTrackedCursors(
    accounts: { platform: string; username: string }[],
    cadenceMs: number,
    now: number = Date.now()
  ): Promise<
    Record<string, { lastScannedAt: Date | null; nextScanAt: Date | null }>
  > {
    if (!accounts.length) return {};
    const keys = Array.from(
      new Set(accounts.map((a) => normalizeUsername(a.platform ?? 'x', a.username)))
    );
    const rows = await this._scanCursor.model.engageScanCursor.findMany({
      where: { scanType: 'tracked', scanKey: { in: keys } },
      select: {
        platform: true,
        scanKey: true,
        lastScannedAt: true,
        lastScanStartedAt: true,
        cooldownUntil: true,
      },
    });
    const byNorm = new Map<
      string,
      { lastScannedAt: Date | null; nextScanAt: Date | null }
    >();
    for (const row of rows) {
      byNorm.set(`${row.platform}:${row.scanKey}`, {
        lastScannedAt: row.lastScannedAt,
        nextScanAt: new Date(deriveNext(row, cadenceMs, now)),
      });
    }
    const out: Record<
      string,
      { lastScannedAt: Date | null; nextScanAt: Date | null }
    > = {};
    for (const a of accounts) {
      const platform = a.platform ?? 'x';
      const hit = byNorm.get(`${platform}:${normalizeUsername(platform, a.username)}`);
      if (hit) out[`${platform}:${a.username}`] = hit;
    }
    return out;
  }

  // ─── Keywords ──────────────────────────────────────────────────────────────

  async addKeyword(
    configId: string,
    organizationId: string,
    dto: AddKeywordDto
  ) {
    // Unique violation on (configId, keyword) → 409 with a readable message.
    return this._createOrConflict(`Keyword "${dto.keyword}"`, () =>
      this._keyword.model.engageKeyword.create({
        data: {
          configId,
          organizationId,
          keyword: dto.keyword,
          type: dto.type ?? null,
          enabled: dto.enabled ?? true,
          ...((dto.enabled ?? true) && {
            initialScans: {
              create: INITIAL_SCAN_PLATFORMS.map((platform) => ({
                organizationId,
                platform,
                keyword: dto.keyword,
                status: 'PENDING',
              })),
            },
          }),
        },
      })
    );
  }

  // Atomic bulk-add — used by the setup wizard so a partial-commit mid-loop
  // cannot leave the user in a half-initialized state. createMany compiles to
  // a single INSERT … ON CONFLICT DO NOTHING (skipDuplicates), so repeating a
  // setup attempt with overlapping keywords is safe.
  async addKeywordsBulk(
    configId: string,
    organizationId: string,
    dto: AddKeywordsBulkDto
  ) {
    const data = dto.keywords.map((kw) => ({
      configId,
      organizationId,
      keyword: kw.keyword,
      type: kw.type ?? null,
      enabled: kw.enabled ?? true,
    }));
    const result = await this._keyword.model.engageKeyword.createMany({
      data,
      skipDuplicates: true,
    });
    await this._ensureInitialScansForEnabledKeywords(configId, organizationId);
    return result;
  }

  /**
   * Map keyword TEXTS to their `EngageKeyword.id` for a project, creating any
   * that don't exist yet. Lets operation-plan generation key
   * `engagePolicies[].keywordTargets` by real `EngageKeyword.id` instead of raw
   * text (the plan's upstream analysis only knows keyword text). Ensures the
   * project's `EngageConfig` exists first.
   *
   * Matching is by `normalizeKeyword` (case/whitespace-insensitive), so "AI"
   * and "ai" collapse to one row. Returns a map keyed by the ORIGINAL input
   * text → the resolved/created id; blank inputs are skipped. Newly created
   * keywords go through `addKeyword`, so they get the same initial-scan seeding
   * and (configId, keyword) conflict handling as a manual add — i.e. this WRITES
   * rows (and enqueues initial scans); do not call it on a read-only/preview
   * path.
   */
  async resolveOrCreateKeywordIds(
    organizationId: string,
    projectId: string | null,
    keywords: string[]
  ): Promise<Record<string, string>> {
    // Dedup inputs by normalized form; keep the first raw spelling to create with.
    const normToRaw = new Map<string, string>();
    for (const raw of keywords ?? []) {
      const text = (raw ?? '').trim();
      if (!text) continue;
      const norm = normalizeKeyword(text);
      if (!norm || normToRaw.has(norm)) continue;
      normToRaw.set(norm, text);
    }
    if (!normToRaw.size) return {};

    const config = await this.getOrCreateConfig(organizationId, projectId);
    const configId = config.id;

    // Existing keywords under this config, indexed by normalized form.
    const existing = await this._keyword.model.engageKeyword.findMany({
      where: { configId, organizationId },
      select: { id: true, keyword: true },
    });
    const normToId = new Map<string, string>();
    for (const row of existing) normToId.set(normalizeKeyword(row.keyword), row.id);

    for (const [norm, text] of normToRaw) {
      if (normToId.has(norm)) continue;
      try {
        const created = await this.addKeyword(configId, organizationId, {
          keyword: text,
        } as AddKeywordDto);
        normToId.set(norm, created.id);
      } catch {
        // Lost a concurrent create race (P2002 → ConflictException); the row
        // now exists, so re-read it by its normalized text.
        const row = await this._keyword.model.engageKeyword.findFirst({
          where: { configId, organizationId, keyword: { equals: text, mode: 'insensitive' } },
          select: { id: true, keyword: true },
        });
        if (row) normToId.set(normalizeKeyword(row.keyword), row.id);
      }
    }

    // Key the result by the ORIGINAL input text (post-trim), preserving each
    // caller-supplied spelling even when several collapse to one id.
    const out: Record<string, string> = {};
    for (const raw of keywords ?? []) {
      const text = (raw ?? '').trim();
      if (!text) continue;
      const id = normToId.get(normalizeKeyword(text));
      if (id) out[text] = id;
    }
    return out;
  }

  async updateKeyword(
    organizationId: string,
    id: string,
    dto: UpdateKeywordDto
  ) {
    const kw = await this._keyword.model.engageKeyword.findFirst({
      where: { id, organizationId },
    });
    if (!kw) throw new NotFoundException('Keyword not found');
    const shouldResetInitialScan =
      dto.enabled === true && kw.enabled === false;
    const updated = await this._keyword.model.engageKeyword.update({
      where: { id },
      data: {
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
      },
    });
    if (shouldResetInitialScan) {
      await this._resetInitialScansForKeyword(
        updated.id,
        organizationId,
        updated.keyword
      );
    }
    return updated;
  }

  private async _ensureInitialScansForEnabledKeywords(
    configId: string,
    organizationId: string
  ): Promise<void> {
    const keywords = await this._keyword.model.engageKeyword.findMany({
      where: { configId, organizationId, enabled: true },
      select: { id: true, keyword: true },
    });
    if (!keywords.length) return;
    await this._keywordInitialScan.model.engageKeywordInitialScan.createMany({
      data: keywords.flatMap((kw) =>
        INITIAL_SCAN_PLATFORMS.map((platform) => ({
          organizationId,
          keywordId: kw.id,
          keyword: kw.keyword,
          platform,
          status: 'PENDING',
        }))
      ),
      skipDuplicates: true,
    });
  }

  private async _resetInitialScansForKeyword(
    keywordId: string,
    organizationId: string,
    keyword: string
  ): Promise<void> {
    for (const platform of INITIAL_SCAN_PLATFORMS) {
      await this._keywordInitialScan.model.engageKeywordInitialScan.upsert({
        where: { keywordId_platform: { keywordId, platform } },
        create: {
          organizationId,
          keywordId,
          keyword,
          platform,
          status: 'PENDING',
        },
        update: {
          keyword,
          status: 'PENDING',
          startedAt: null,
          completedAt: null,
          error: null,
          attempts: 0,
        },
      });
    }
  }

  async deleteKeyword(organizationId: string, id: string) {
    const kw = await this._keyword.model.engageKeyword.findFirst({
      where: { id, organizationId },
    });
    if (!kw) throw new NotFoundException('Keyword not found');
    return this._keyword.model.engageKeyword.delete({ where: { id } });
  }

  async getKeywordPosts(organizationId: string, keywordId: string, limit = 8) {
    const kw = await this._keyword.model.engageKeyword.findFirst({
      where: { id: keywordId, organizationId },
    });
    if (!kw) throw new NotFoundException('Keyword not found');
    // Posts are global now — preview any post whose content matches the keyword.
    // The trigram GIN index on postContent backs this ILIKE.
    return this._opportunity.model.engageOpportunity.findMany({
      where: {
        deletedAt: null,
        postContent: { contains: kw.keyword, mode: 'insensitive' },
      },
      orderBy: { postPublishedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        platform: true,
        externalPostUrl: true,
        authorUsername: true,
        postContent: true,
        postPublishedAt: true,
        metricScore: true,
        metricComments: true,
        metricLikes: true,
        scoreHeat: true,
      },
    });
  }

  // ─── Monitored Channels ───────────────────────────────────────────────────

  async addMonitoredChannel(
    configId: string,
    organizationId: string,
    dto: AddMonitoredChannelDto
  ) {
    // Unique violation on (configId, platform, channelId) → 409.
    return this._createOrConflict(
      `Channel "${dto.channelName ?? dto.channelId}"`,
      () =>
        this._channel.model.engageMonitoredChannel.create({
          data: {
            configId,
            organizationId,
            platform: dto.platform,
            channelId: dto.channelId,
            channelName: dto.channelName,
            enabled: dto.enabled ?? true,
            audienceSize: dto.audienceSize ?? 0,
            ...(dto.metadata && {
              metadata: dto.metadata as Prisma.InputJsonValue,
            }),
          },
        })
    );
  }

  async listMonitoredChannels(organizationId: string, projectId: string | null = null) {
    return this._channel.model.engageMonitoredChannel.findMany({
      where: { organizationId, config: { projectId } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateMonitoredChannel(
    organizationId: string,
    id: string,
    dto: UpdateMonitoredChannelDto
  ) {
    const channel = await this._channel.model.engageMonitoredChannel.findFirst(
      { where: { id, organizationId } }
    );
    if (!channel) throw new NotFoundException('Channel not found');
    return this._channel.model.engageMonitoredChannel.update({
      where: { id },
      data: {
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        ...(dto.channelName !== undefined && { channelName: dto.channelName }),
        ...(dto.audienceSize !== undefined && {
          audienceSize: dto.audienceSize,
        }),
      },
    });
  }

  async removeMonitoredChannel(organizationId: string, id: string) {
    const channel = await this._channel.model.engageMonitoredChannel.findFirst(
      { where: { id, organizationId } }
    );
    if (!channel) throw new NotFoundException('Channel not found');
    return this._channel.model.engageMonitoredChannel.delete({ where: { id } });
  }

  // ─── Tracked Accounts ─────────────────────────────────────────────────────

  async addTrackedAccount(
    configId: string,
    organizationId: string,
    dto: AddTrackedAccountDto
  ) {
    const platform = dto.platform ?? 'x';
    // Reject usernames that aren't a plain handle BEFORE they can reach the
    // `from:<username>` search query — a crafted value (parens/operators/spaces)
    // could otherwise shape the X search. Validate the normalized form.
    if (!isValidUsername(platform, normalizeUsername(platform, dto.username))) {
      throw new BadRequestException(
        `Invalid ${platform} username "${dto.username}": use a plain handle (letters, digits, _${platform === 'reddit' ? ', -' : ''}).`
      );
    }
    // Unique violation on (configId, platform, username) → 409.
    return this._createOrConflict(`Account "${dto.username}"`, () =>
      this._trackedAccount.model.engageTrackedAccount.create({
        data: {
          configId,
          organizationId,
          platform: dto.platform ?? 'x',
          username: dto.username,
          ...(dto.picture && { picture: dto.picture }),
          ...(dto.categoryLabel && { categoryLabel: dto.categoryLabel }),
          ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        },
      })
    );
  }

  async listTrackedAccounts(organizationId: string, projectId: string | null = null) {
    return this._trackedAccount.model.engageTrackedAccount.findMany({
      where: { organizationId, config: { projectId } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateTrackedAccount(
    organizationId: string,
    id: string,
    dto: UpdateTrackedAccountDto
  ) {
    const account =
      await this._trackedAccount.model.engageTrackedAccount.findFirst({
        where: { id, organizationId },
      });
    if (!account) throw new NotFoundException('Tracked account not found');
    return this._trackedAccount.model.engageTrackedAccount.update({
      where: { id },
      data: {
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        ...(dto.picture !== undefined && { picture: dto.picture }),
        ...(dto.categoryLabel !== undefined && {
          categoryLabel: dto.categoryLabel,
        }),
      },
    });
  }

  async removeTrackedAccount(organizationId: string, id: string) {
    const account =
      await this._trackedAccount.model.engageTrackedAccount.findFirst({
        where: { id, organizationId },
      });
    if (!account) throw new NotFoundException('Tracked account not found');
    return this._trackedAccount.model.engageTrackedAccount.delete({
      where: { id },
    });
  }

  // ─── Reply Accounts ───────────────────────────────────────────────────────

  async getRedditIntegrationToken(organizationId: string): Promise<string | null> {
    const integration = await this._integration.model.integration.findFirst({
      where: {
        organizationId,
        providerIdentifier: 'reddit',
        deletedAt: null,
        disabled: false,
      },
      select: { token: true },
      orderBy: { createdAt: 'desc' },
    });
    return integration?.token ?? null;
  }

  async listXIntegrationsWithReplySettings(
    organizationId: string,
    projectId: string | null = null
  ) {
    const integrations = await this._integration.model.integration.findMany({
      where: {
        organizationId,
        providerIdentifier: 'x',
        deletedAt: null,
        disabled: false,
        type: 'social',
      },
      // engageXReplyAccount(s) is plural now: the same integration may carry
      // one reply-settings row per project (configId,integrationId) — a
      // global UNIQUE(integrationId) no longer exists (project-scoped-post-
      // engage-design.md §3.1). Scoped to THIS project's config so the
      // response still surfaces at most one row per integration, matching
      // the shape every caller of this method already expects.
      include: {
        engageXReplyAccounts: {
          where: { config: { organizationId, projectId } },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return integrations.map(({ engageXReplyAccounts, ...integration }) => ({
      ...integration,
      engageXReplyAccount: engageXReplyAccounts[0] ?? null,
    }));
  }

  async updateReplyAccount(
    organizationId: string,
    integrationId: string,
    dto: UpdateReplyAccountDto,
    projectId: string | null = null
  ) {
    // Verify the integration belongs to this org before upserting engage settings
    const integration = await this._integration.model.integration.findFirst({
      where: { id: integrationId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!integration) throw new NotFoundException('Integration not found');

    const configId = await this._getConfigId(organizationId, projectId);
    return this._replyAccount.model.engageXReplyAccount.upsert({
      where: { configId_integrationId: { configId, integrationId } },
      create: {
        configId,
        organizationId,
        integrationId,
        engageEnabled: dto.engageEnabled ?? true,
        autoReplyEnabled: dto.autoReplyEnabled ?? false,
        autoReplyTimeStart: dto.autoReplyTimeStart ?? null,
        autoReplyTimeEnd: dto.autoReplyTimeEnd ?? null,
        autoReplyTimezone: dto.autoReplyTimezone ?? null,
        defaultStrategy: dto.defaultStrategy ?? 'EXPERT_ANSWER',
      },
      update: {
        ...(dto.engageEnabled !== undefined && {
          engageEnabled: dto.engageEnabled,
        }),
        ...(dto.autoReplyEnabled !== undefined && {
          autoReplyEnabled: dto.autoReplyEnabled,
        }),
        ...(dto.autoReplyTimeStart !== undefined && {
          autoReplyTimeStart: dto.autoReplyTimeStart,
        }),
        ...(dto.autoReplyTimeEnd !== undefined && {
          autoReplyTimeEnd: dto.autoReplyTimeEnd,
        }),
        ...(dto.autoReplyTimezone !== undefined && {
          autoReplyTimezone: dto.autoReplyTimezone,
        }),
        ...(dto.defaultStrategy !== undefined && {
          defaultStrategy: dto.defaultStrategy,
        }),
      },
    });
  }

  // ─── Opportunities ────────────────────────────────────────────────────────

  // Flatten a per-org state row + its global opportunity into the legacy
  // EngageOpportunity response shape the API/frontend expect. `id` stays the
  // opportunity id (the value the controller's :id routes operate on).
  //
  // Fields are listed explicitly (not via `...opportunity`) so the compiler
  // catches any future schema migration that accidentally moves a score field
  // to the wrong table — the global/per-org boundary is enforced at the type
  // level by naming each field's source.
  private _merge<
    T extends {
      status: EngageOpportunityStatus;
      bookmarked: boolean;
      score: number;
      scoreKeyword: number;
      scoreTracked: number;
      matchedKeywords: string[];
      createdAt: Date;
      opportunity: EngageOpportunity;
    }
  >(state: T) {
    const {
      opportunity,
      status,
      bookmarked,
      score,
      scoreKeyword,
      scoreTracked,
      matchedKeywords,
      createdAt,
    } = state;
    return {
      // ── Global fields (EngageOpportunity) ──────────────────────────────────
      id: opportunity.id,
      platform: opportunity.platform,
      externalPostId: opportunity.externalPostId,
      externalPostUrl: opportunity.externalPostUrl,
      channelId: opportunity.channelId,
      channelName: opportunity.channelName,
      channelFollowers: opportunity.channelFollowers,
      authorUsername: opportunity.authorUsername,
      authorDisplayName: opportunity.authorDisplayName,
      authorFollowers: opportunity.authorFollowers,
      authorAvatarUrl: opportunity.authorAvatarUrl,
      postContent: opportunity.postContent,
      postPublishedAt: opportunity.postPublishedAt,
      // Objective scores — identical across all orgs
      scoreHeat: opportunity.scoreHeat,
      scoreAuthority: opportunity.scoreAuthority,
      scoreRecency: opportunity.scoreRecency,
      intentTags: opportunity.intentTags,
      primaryIntent: opportunity.primaryIntent,
      intentScore: opportunity.intentScore,
      metricLikes: opportunity.metricLikes,
      metricReplies: opportunity.metricReplies,
      metricRetweets: opportunity.metricRetweets,
      metricQuotes: opportunity.metricQuotes,
      metricBookmarks: opportunity.metricBookmarks,
      metricViews: opportunity.metricViews,
      metricShares: opportunity.metricShares,
      metricSaves: opportunity.metricSaves,
      metricScore: opportunity.metricScore,
      metricUpvoteRatio: opportunity.metricUpvoteRatio,
      metricComments: opportunity.metricComments,
      // rawData (full platform JSON payload) is intentionally NOT exposed: no
      // client or downstream service reads it, and returning it per item bloats
      // every _merge-based response (notably the paginated opportunities list).
      // Per-org createdAt (when this org first saw the opportunity).
      createdAt,
      updatedAt: opportunity.updatedAt,
      deletedAt: opportunity.deletedAt,
      // ── Per-org fields (EngageOpportunityState) ───────────────────────────
      status,
      bookmarked,
      score,
      scoreKeyword,
      scoreTracked,
      matchedKeywords,
    };
  }

  // Shared by listOpportunities/locateOpportunity so their postPublishedAt
  // window can't drift out of sync. Two independent ways to set the lower
  // bound: the `date` calendar preset (today/week, UTC day/isoWeek start), or
  // an exact `startDate` instant, which takes priority if both are given —
  // callers doing a rolling window (e.g. "last 24h") need hour precision that
  // `date` can't express. `endDate` is the exact upper-bound instant, applied
  // as-is with no rounding: pass a full timestamp for a precise cutoff, or a
  // bare date for its UTC midnight.
  private _postPublishedAtFilter(dto: {
    date?: 'today' | 'week';
    startDate?: string;
    endDate?: string;
  }): Prisma.DateTimeFilter | undefined {
    const filter: Prisma.DateTimeFilter = {};
    if (dto.startDate) {
      filter.gte = dayjs.utc(dto.startDate).toDate();
    } else if (dto.date === 'today') {
      filter.gte = dayjs.utc().startOf('day').toDate();
    } else if (dto.date === 'week') {
      filter.gte = dayjs.utc().startOf('isoWeek').toDate();
    }
    if (dto.endDate) {
      filter.lte = dayjs.utc(dto.endDate).toDate();
    }
    return Object.keys(filter).length ? filter : undefined;
  }

  async listOpportunities(organizationId: string, dto: ListOpportunitiesDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;

    const channelSpecific = dto.channels?.length ? dto.channels : undefined;
    const authorSpecificList = dto.authors?.length ? dto.authors : undefined;
    const postPublishedAtFilter = this._postPublishedAtFilter(dto);

    // State-table filters (per-org) + nested opportunity filters (global).
    const where: Prisma.EngageOpportunityStateWhereInput = {
      organizationId,
      projectId: dto.projectId ?? null,
      ...(dto.status?.length && { status: { in: dto.status } }),
      ...(dto.bookmarked !== undefined && { bookmarked: dto.bookmarked }),
      score: { gte: dto.minScore ?? LIST_DEFAULT_MIN_SCORE },
      ...(dto.minScoreKeyword !== undefined && {
        scoreKeyword: { gte: dto.minScoreKeyword },
      }),
      // Keyword filter — exact match against this org's matchedKeywords. `keyword`
      // (single) and `keywords` (multi) union into one OR set (hasSome), so either
      // or both params work and a match on any listed keyword keeps the row.
      ...((() => {
        const set = [
          ...(dto.keyword ? [dto.keyword] : []),
          ...(dto.keywords ?? []),
        ];
        return set.length ? { matchedKeywords: { hasSome: set } } : {};
      })()),
      opportunity: {
        deletedAt: null,
        ...(dto.platform?.length && { platform: { in: dto.platform } }),
        ...(channelSpecific && { channelId: { in: channelSpecific } }),
        ...(authorSpecificList?.length && {
          OR: authorSpecificList.map((a) => ({
            authorUsername: { equals: a, mode: 'insensitive' as const },
          })),
        }),
        ...(dto.intent?.length && { intentTags: { hasSome: dto.intent } }),
        ...(dto.minScoreHeat !== undefined && {
          scoreHeat: { gte: dto.minScoreHeat },
        }),
        ...(dto.minScoreAuthority !== undefined && {
          scoreAuthority: { gte: dto.minScoreAuthority },
        }),
        ...(postPublishedAtFilter && { postPublishedAt: postPublishedAtFilter }),
      },
    };

    // Route sort field to the table that owns it.
    const stateSortFields = new Set([
      'score',
      'scoreKeyword',
      'scoreTracked',
    ]);
    const oppSortFields = new Set([
      'scoreHeat',
      'scoreAuthority',
      'scoreRecency',
      'postPublishedAt',
    ]);
    const sortBy =
      dto.sortBy && (stateSortFields.has(dto.sortBy) || oppSortFields.has(dto.sortBy))
        ? dto.sortBy
        : 'score';
    const sortOrder = dto.sortOrder ?? 'desc';
    const primaryOrderBy = oppSortFields.has(sortBy)
      ? { opportunity: { [sortBy]: sortOrder } }
      : { [sortBy]: sortOrder };
    // Apply a stable tiebreaker so equal primary-sort values fall back to a
    // deterministic order: postPublishedAt-sorted lists break ties by highest
    // score, every other sort breaks ties by newest-published-first.
    const tiebreaker =
      sortBy === 'postPublishedAt'
        ? { score: 'desc' as const }
        : { opportunity: { postPublishedAt: 'desc' as const } };
    // Stable tiebreaker so `locateOpportunity` can reproduce the exact page
    // index for rows sharing the same primary + secondary sort values.
    // EngageOpportunityState has composite PK (organizationId+opportunityId),
    // so opportunityId is the per-org unique discriminator.
    const orderBy = [primaryOrderBy, tiebreaker, { opportunityId: 'desc' as const }];

    const [rows, total] = await Promise.all([
      this._oppState.model.engageOpportunityState.findMany({
        where,
        include: { opportunity: true },
        orderBy,
        skip: offset,
        take: limit,
      }),
      this._oppState.model.engageOpportunityState.count({ where }),
    ]);

    // Both lookups below depend only on `rows`, not on each other, so fan them
    // out in one round trip.
    const oppIds = rows.map((r) => r.opportunity.id);
    // Subreddit avatars live on the monitored channel's metadata
    // (`metadata.avatar`), keyed by this org's (platform=reddit, channelId).
    // Only Reddit rows carry a channel avatar; every other platform resolves to
    // null. One bounded query for the channels referenced by the current page.
    const redditChannelIds = [
      ...new Set(
        rows
          .filter((r) => r.opportunity.platform === 'reddit' && r.opportunity.channelId)
          .map((r) => r.opportunity.channelId)
      ),
    ];

    const [replies, channels] = await Promise.all([
      oppIds.length
        ? this._sentReply.model.engageSentReply
            .findMany({
              // Exclude unsent DRAFT working-copies: a saved draft must NOT make the
              // signal feed show "replied / link pending" for an opportunity the user
              // hasn't actually replied to yet.
              where: {
                organizationId,
                projectId: dto.projectId ?? null,
                opportunityId: { in: oppIds },
                post: { state: { not: 'DRAFT' } },
              },
              orderBy: { createdAt: 'desc' },
              select: { id: true, opportunityId: true, post: { select: { releaseURL: true } } },
            })
            .then((r) => r ?? [])
        : Promise.resolve([]),
      redditChannelIds.length
        ? this._channel.model.engageMonitoredChannel.findMany({
            // The subreddit avatar is a global property of the subreddit, not
            // per-org, so match on (platform, channelId) only. Scoping by
            // organizationId would miss the avatar whenever this org's own
            // channel row lacks the cached metadata — e.g. the post surfaced via
            // keyword scan for a subreddit this org doesn't monitor but another
            // org does, or this org's row was added without the search metadata.
            where: {
              platform: 'reddit',
              channelId: { in: redditChannelIds },
            },
            select: { channelId: true, metadata: true },
          })
        : Promise.resolve([]),
    ]);

    // The manual-reply link status lets the feed show "replied, link pending"
    // and offer a backfill. The latest reply per opportunity wins (per-post
    // tracking means an opportunity may have several replies). `replyLink` is
    // the stored Post.releaseURL (null = not yet submitted); `sentReplyId` is
    // what the backfill endpoint (PATCH /sent/:id/reply-url) needs.
    const latestByOpp = new Map<string, { id: string; replyLink: string | null }>();
    for (const rep of replies) {
      if (!latestByOpp.has(rep.opportunityId)) {
        latestByOpp.set(rep.opportunityId, { id: rep.id, replyLink: rep.post?.releaseURL ?? null });
      }
    }

    const channelAvatarById = new Map<string, string | null>();
    for (const ch of channels) {
      const meta = ch.metadata as Record<string, unknown> | null;
      const avatar =
        meta && typeof meta === 'object' && typeof meta.avatar === 'string'
          ? (meta.avatar as string)
          : null;
      // Several orgs may track the same subreddit; keep the first non-null
      // avatar so a metadata-less row never clobbers a good one.
      if (avatar !== null || !channelAvatarById.has(ch.channelId)) {
        channelAvatarById.set(ch.channelId, avatar);
      }
    }

    const items = rows.map((r) => {
      const merged = this._merge(r);
      const rep = latestByOpp.get(merged.id);
      return {
        ...merged,
        sentReplyId: rep?.id ?? null,
        replyLink: rep?.replyLink ?? null,
        channelAvatar: channelAvatarById.get(merged.channelId) ?? null,
      };
    });

    return { items, total, page, limit };
  }

  // Single round trip replacing what the frontend used to do with N separate
  // `listOpportunities({ platform: 'x', limit: 1 })`-style calls just to read
  // `.total` for a tab/platform badge. Mirrors listOpportunities' scoping
  // filters (channels/authors/keywords/date/minScore*/bookmarked/intent) but
  // omits `platform`/`status`/pagination/sort — those are the two dimensions
  // broken down below, not a further narrowing.
  async getOpportunityCounts(organizationId: string, dto: OpportunityCountsDto) {
    const channelSpecific = dto.channels?.length ? dto.channels : undefined;
    const authorSpecificList = dto.authors?.length ? dto.authors : undefined;
    const postPublishedAtFilter = this._postPublishedAtFilter(dto);

    // Declared with its own explicit type so it can be spread again below to
    // inject `platform` — spreading `where.opportunity` directly would widen to
    // the field's declared union type (EngageOpportunityWhereInput |
    // EngageOpportunityScalarRelationFilter) and no longer accept `platform`.
    const oppFilter: Prisma.EngageOpportunityWhereInput = {
      deletedAt: null,
      ...(channelSpecific && { channelId: { in: channelSpecific } }),
      ...(authorSpecificList?.length && {
        OR: authorSpecificList.map((a) => ({
          authorUsername: { equals: a, mode: 'insensitive' as const },
        })),
      }),
      ...(dto.intent?.length && { intentTags: { hasSome: dto.intent } }),
      ...(dto.minScoreHeat !== undefined && {
        scoreHeat: { gte: dto.minScoreHeat },
      }),
      ...(dto.minScoreAuthority !== undefined && {
        scoreAuthority: { gte: dto.minScoreAuthority },
      }),
      ...(postPublishedAtFilter && { postPublishedAt: postPublishedAtFilter }),
    };

    const where: Prisma.EngageOpportunityStateWhereInput = {
      organizationId,
      projectId: dto.projectId ?? null,
      ...(dto.bookmarked !== undefined && { bookmarked: dto.bookmarked }),
      score: { gte: dto.minScore ?? LIST_DEFAULT_MIN_SCORE },
      ...(dto.minScoreKeyword !== undefined && {
        scoreKeyword: { gte: dto.minScoreKeyword },
      }),
      ...((() => {
        const set = [
          ...(dto.keyword ? [dto.keyword] : []),
          ...(dto.keywords ?? []),
        ];
        return set.length ? { matchedKeywords: { hasSome: set } } : {};
      })()),
      opportunity: oppFilter,
    };

    // `status` lives on EngageOpportunityState itself, so it groups in one
    // query. `platform` lives on the joined EngageOpportunity, which Prisma's
    // groupBy can't traverse — two scoped counts stand in for that breakdown,
    // same pattern as getSentStats/getSentCounts below.
    const [total, statusGroups, x, reddit] = await Promise.all([
      this._oppState.model.engageOpportunityState.count({ where }),
      this._oppState.model.engageOpportunityState.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      this._oppState.model.engageOpportunityState.count({
        where: { ...where, opportunity: { ...oppFilter, platform: 'x' } },
      }),
      this._oppState.model.engageOpportunityState.count({
        where: { ...where, opportunity: { ...oppFilter, platform: 'reddit' } },
      }),
    ]);

    const byStatus = Object.fromEntries(
      Object.values(EngageOpportunityStatus).map((s) => [s, 0])
    ) as Record<EngageOpportunityStatus, number>;
    for (const g of statusGroups) byStatus[g.status] = g._count._all;

    return { total, byStatus, byPlatform: { x, reddit } };
  }

  async locateOpportunity(organizationId: string, dto: LocateOpportunityDto) {
    const limit = dto.limit ?? 20;
    const postPublishedAtFilter = this._postPublishedAtFilter(dto);

    // Mirror the `where` from `listOpportunities` exactly.
    const where: Prisma.EngageOpportunityStateWhereInput = {
      organizationId,
      projectId: dto.projectId ?? null,
      ...(dto.status?.length && { status: { in: dto.status } }),
      ...(dto.bookmarked !== undefined && { bookmarked: dto.bookmarked }),
      score: { gte: dto.minScore ?? LIST_DEFAULT_MIN_SCORE },
      ...(dto.minScoreKeyword !== undefined && {
        scoreKeyword: { gte: dto.minScoreKeyword },
      }),
      ...((() => {
        const set = [
          ...(dto.keyword ? [dto.keyword] : []),
          ...(dto.keywords ?? []),
        ];
        return set.length ? { matchedKeywords: { hasSome: set } } : {};
      })()),
      opportunity: {
        deletedAt: null,
        ...(dto.platform?.length && { platform: { in: dto.platform } }),
        ...(dto.channels?.length && { channelId: { in: dto.channels } }),
        ...(dto.authors?.length && {
          OR: dto.authors.map((a) => ({
            authorUsername: { equals: a, mode: 'insensitive' as const },
          })),
        }),
        ...(dto.intent?.length && { intentTags: { hasSome: dto.intent } }),
        ...(dto.minScoreHeat !== undefined && {
          scoreHeat: { gte: dto.minScoreHeat },
        }),
        ...(dto.minScoreAuthority !== undefined && {
          scoreAuthority: { gte: dto.minScoreAuthority },
        }),
        ...(postPublishedAtFilter && { postPublishedAt: postPublishedAtFilter }),
      },
    };

    const stateSortFields = new Set([
      'score',
      'scoreKeyword',
      'scoreTracked',
    ]);
    const oppSortFields = new Set([
      'scoreHeat',
      'scoreAuthority',
      'scoreRecency',
      'postPublishedAt',
    ]);
    const sortBy =
      dto.sortBy && (stateSortFields.has(dto.sortBy) || oppSortFields.has(dto.sortBy))
        ? dto.sortBy
        : 'score';
    const sortOrder = dto.sortOrder ?? 'desc';
    const isOppField = oppSortFields.has(sortBy);

    // Find the target state row — must pass all the same filters as listOpportunities.
    // EngageOpportunityState uses a composite PK (organizationId + opportunityId), so
    // dto.opportunityId is the opportunityId.
    const target = await this._oppState.model.engageOpportunityState.findFirst({
      where: { ...where, opportunityId: dto.opportunityId },
    });

    if (!target) {
      const total = await this._oppState.model.engageOpportunityState.count({
        where,
      });
      return {
        found: false as const,
        page: null as number | null,
        position: null as number | null,
        total,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    }

    // Tiebreaker mirrors listOpportunities: postPublishedAt sort → score desc,
    // else → postPublishedAt desc. `score` lives on the state row; `postPublishedAt`
    // lives on the linked opportunity.
    const tbField = sortBy === 'postPublishedAt' ? 'score' : 'postPublishedAt';
    const tbIsOppField = tbField === 'postPublishedAt';

    // Fetch the linked opportunity once, whenever the primary sort field or the
    // tiebreaker needs a value that lives there instead of on the state row.
    const opp =
      isOppField || tbIsOppField
        ? await this._opportunity.model.engageOpportunity.findFirst({
            where: { id: target.opportunityId },
            select: {
              scoreHeat: true,
              scoreAuthority: true,
              scoreRecency: true,
              postPublishedAt: true,
            },
          })
        : null;

    const sortValue = isOppField
      ? opp
        ? (opp as Record<string, unknown>)[sortBy]
        : null
      : (target as Record<string, unknown>)[sortBy];
    const tbValue = tbIsOppField
      ? opp
        ? (opp as Record<string, unknown>)[tbField]
        : null
      : (target as Record<string, unknown>)[tbField];

    const cmp = sortOrder === 'desc' ? ('gt' as const) : ('lt' as const);
    const baseOpp = (where.opportunity ?? {}) as Prisma.EngageOpportunityWhereInput;

    // Merge a field condition into `base`, routing it onto the nested
    // `opportunity` relation when the field lives there instead of on the
    // state row — and preserving whatever `opportunity` filter is already on
    // `base` (e.g. the primary sort's own condition), rather than overwriting it.
    const withField = (
      base: Prisma.EngageOpportunityStateWhereInput,
      field: string,
      isOpp: boolean,
      condition: unknown
    ): Prisma.EngageOpportunityStateWhereInput =>
      isOpp
        ? {
            ...base,
            opportunity: {
              ...((base.opportunity as Prisma.EngageOpportunityWhereInput) ?? baseOpp),
              [field]: condition,
            },
          }
        : { ...base, [field]: condition };

    // Build "strictly before" condition for the primary sort field.
    const precedingByValueWhere = withField(where, sortBy, isOppField, {
      [cmp]: sortValue,
    });

    // Equal primary value.
    const equalPrimaryWhere = withField(where, sortBy, isOppField, sortValue);

    // Stable 3rd tiebreaker: opportunityId desc (mirrors listOpportunities orderBy).
    const [precedingByValue, precedingByTie, precedingByOppId, total] =
      await Promise.all([
        this._oppState.model.engageOpportunityState.count({
          where: precedingByValueWhere,
        }),
        // Equal primary, strictly better tiebreaker (always desc).
        this._oppState.model.engageOpportunityState.count({
          where: withField(equalPrimaryWhere, tbField, tbIsOppField, { gt: tbValue }),
        }),
        // Equal primary, equal tiebreaker, opportunityId comes before target (desc).
        this._oppState.model.engageOpportunityState.count({
          where: {
            ...withField(equalPrimaryWhere, tbField, tbIsOppField, tbValue),
            opportunityId: { gt: target.opportunityId },
          },
        }),
        this._oppState.model.engageOpportunityState.count({ where }),
      ]);

    const position = precedingByValue + precedingByTie + precedingByOppId + 1;
    const page = Math.ceil(position / limit);

    return {
      found: true as const,
      page,
      position,
      total,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async dismissOpportunity(organizationId: string, id: string, projectId?: string | null) {
    // Atomic: only dismiss actionable opportunities. Replied/scheduled rows are protected.
    // `id` is the opportunity id; status lives on this org's (+project's) state row.
    const result = await this._oppState.model.engageOpportunityState.updateMany({
      where: {
        organizationId,
        projectId: projectId ?? null,
        opportunityId: id,
        status: { in: ['NEW', 'AUTO_QUEUED'] },
      },
      data: { status: 'DISMISSED' },
    });
    if (result.count === 0) {
      throw new NotFoundException('Opportunity not found or no longer actionable');
    }
    // Not findUnique: projectId is nullable, and a nullable column can never
    // satisfy a compound-unique lookup (Postgres NULL != NULL) — see the
    // schema comment on EngageOpportunityState's surrogate id.
    const row = await this._oppState.model.engageOpportunityState.findFirst({
      where: { organizationId, projectId: projectId ?? null, opportunityId: id },
      include: { opportunity: true },
    });
    return row ? this._merge(row) : null;
  }

  // Atomic claim — only one concurrent caller succeeds. Prevents the orphan-Post + duplicate-X-reply
  // race where two concurrent reply attempts both pass a non-locking findFirst then both invoke
  // PostsService.createPost.
  //
  // Returns the opportunity plus the `priorStatus` (NEW | AUTO_QUEUED) so the caller can restore
  // the original status on rollback — preventing the loss of AUTO_QUEUED markers when the
  // auto-reply worker had pre-queued the opportunity.
  async claimOpportunityForReply(
    organizationId: string,
    id: string,
    claimStatus: 'REPLIED' | 'SCHEDULED',
    projectId?: string | null
  ) {
    // Read prior status (snapshot for rollback). The followup updateMany is conditional
    // on this exact status — if a concurrent claimer flipped it between the read and
    // the update, the conditional update yields count=0 and we throw.
    // Not findUnique: projectId is nullable — see dismissOpportunity's note.
    const existing = await this._oppState.model.engageOpportunityState.findFirst({
      where: { organizationId, projectId: projectId ?? null, opportunityId: id },
      select: { status: true },
    });
    // Give each failure its OWN status code so the frontend can tell them apart,
    // mirroring getOpportunityForReply (the generateDraft gate):
    //   • genuinely missing per-org state row → 404 Not Found
    //   • exists but no longer actionable (replied / scheduled / dismissed /
    //     expired) → 403 Forbidden carrying the precise {code, message} reason
    // The old single "Opportunity not found or already replied" 404 hid "you already
    // replied to this" behind the same code, so the UI could only show a generic
    // error and couldn't surface the real reason.
    if (!existing) {
      throw new NotFoundException('Opportunity not found');
    }
    const blockReason = NON_ACTIONABLE_REPLY_REASONS[existing.status];
    if (blockReason) {
      throw new ForbiddenException(blockReason);
    }
    const priorStatus = existing.status as 'NEW' | 'AUTO_QUEUED';

    const result = await this._oppState.model.engageOpportunityState.updateMany({
      where: { organizationId, projectId: projectId ?? null, opportunityId: id, status: priorStatus },
      data: { status: claimStatus },
    });
    if (result.count === 0) {
      throw new ConflictException('Opportunity already claimed by another request');
    }
    const row = await this._oppState.model.engageOpportunityState.findFirst({
      where: { organizationId, projectId: projectId ?? null, opportunityId: id },
      include: { opportunity: true },
    });
    if (!row) throw new NotFoundException('Opportunity not found');
    return { opp: this._merge(row), priorStatus };
  }

  // Delete any saved working DRAFT reply for an opportunity. Deleting the Post
  // cascades to its EngageSentReply (onDelete: Cascade). No-op when none exist.
  private async _deleteDraftsForOpportunity(
    organizationId: string,
    opportunityId: string,
    projectId?: string | null
  ): Promise<void> {
    const drafts = await this._sentReply.model.engageSentReply.findMany({
      where: {
        organizationId,
        projectId: projectId ?? null,
        opportunityId,
        post: { state: 'DRAFT' },
      },
      select: { postId: true },
    });
    if (!drafts.length) return;
    await this._post.model.post.deleteMany({
      where: { id: { in: drafts.map((d) => d.postId) } },
    });
  }

  // Upsert the single working DRAFT reply for an opportunity. Stored as a
  // Post(state=DRAFT, source=engage) + EngageSentReply so it flows through the same
  // machinery as sent replies and surfaces in /sent?status=awaiting — but it is NOT
  // a sent reply: no releaseURL, it never claims the opportunity, and every
  // "sent reply" count/analytic excludes DRAFT (only `awaiting` includes it).
  async upsertDraft(
    organizationId: string,
    opportunityId: string,
    data: { platform: string; content: string; inputData: object },
    projectId?: string | null
  ) {
    const { randomUUID } = await import('crypto');
    // Atomic: the existing-draft lookup and the Post + EngageSentReply writes run in
    // ONE transaction, so a mid-write failure can never leave an orphan DRAFT Post
    // without its tracking row. (A read-committed transaction does NOT by itself stop
    // two concurrent saves from both seeing no draft and inserting two — that needs a
    // DB-level partial unique index, deliberately skipped to avoid a migration; the
    // realistic trigger is a double-click, which the client should debounce.)
    return this._tx.model.$transaction(async (tx) => {
      const existing = await tx.engageSentReply.findFirst({
        where: {
          organizationId,
          projectId: projectId ?? null,
          opportunityId,
          post: { state: 'DRAFT' },
        },
        select: { id: true, postId: true },
      });

      if (existing) {
        await tx.post.update({
          where: { id: existing.postId },
          data: { content: data.content },
        });
        return tx.engageSentReply.update({
          where: { id: existing.id },
          data: { inputData: data.inputData as Prisma.InputJsonValue },
          include: { post: { select: { id: true, content: true, state: true } } },
        });
      }

      const post = await tx.post.create({
        data: {
          organizationId,
          projectId: projectId ?? null,
          content: data.content,
          publishDate: new Date(),
          state: 'DRAFT',
          source: 'engage',
          image: '[]',
          settings: JSON.stringify({ __type: data.platform === 'x' ? 'x' : 'reddit' }),
          group: randomUUID(),
          delay: 0,
        },
      });
      return tx.engageSentReply.create({
        data: {
          organizationId,
          projectId: projectId ?? null,
          opportunityId,
          postId: post.id,
          inputData: data.inputData as Prisma.InputJsonValue,
        },
        include: { post: { select: { id: true, content: true, state: true } } },
      });
    });
  }

  // Append one AI-generation entry to the opportunity's per-org generationHistory
  // (every successful generation is kept, so the user can review/re-use any past
  // version). Implemented as an atomic jsonb concat (COALESCE(...,'[]') || entry)
  // so two near-simultaneous generations can't clobber each other via a
  // read-modify-write race. No-op (0 rows) when no state row exists for the org —
  // best-effort; an actionable opportunity always has one, but losing an audit
  // entry must never fail an already-delivered draft.
  async appendGenerationHistory(
    organizationId: string,
    opportunityId: string,
    entry: GenerationHistoryEntry,
    projectId?: string | null
  ): Promise<void> {
    // `model` is typed to the model accessor only, but the runtime object is the
    // full PrismaClient — cast to reach $executeRaw for the atomic jsonb concat.
    // IS NOT DISTINCT FROM (not =) so a nullable projectId still matches NULL rows.
    await (this._oppState.model as unknown as PrismaService).$executeRaw`
      UPDATE "EngageOpportunityState"
      SET "generationHistory" =
            COALESCE("generationHistory", '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb,
          "updatedAt" = NOW()
      WHERE "organizationId" = ${organizationId}
        AND "opportunityId" = ${opportunityId}
        AND "projectId" IS NOT DISTINCT FROM ${projectId ?? null}
    `;
  }

  // Record a hand-typed/edited draft as a 'manual' version in generationHistory so
  // the version history is complete (AI + manual), each tagged by source. Deduped:
  // skips the append when the content matches the most-recent entry — saving an
  // unchanged AI draft, or an autosave, must not spawn a duplicate version. Returns
  // whether an entry was actually appended. Best-effort read-modify-write: save-draft
  // is a deliberate single-user action, so the dedup read racing a concurrent write
  // is negligible (and the append itself is still the atomic concat).
  async recordManualGeneration(
    organizationId: string,
    opportunityId: string,
    entry: GenerationHistoryEntry,
    projectId?: string | null
  ): Promise<boolean> {
    const state = await this._oppState.model.engageOpportunityState.findFirst({
      where: { organizationId, projectId: projectId ?? null, opportunityId },
      select: { generationHistory: true },
    });
    if (!state) return false; // no per-org row to store onto
    const history = Array.isArray(state.generationHistory)
      ? (state.generationHistory as unknown as GenerationHistoryEntry[])
      : [];
    const last = history[history.length - 1];
    if (last && last.content === entry.content) return false; // unchanged → skip
    await this.appendGenerationHistory(organizationId, opportunityId, entry, projectId);
    return true;
  }

  // Rollback helper — restores an opportunity to its prior status after a failed
  // post-claim operation. Best-effort; never throws.
  async releaseOpportunityClaim(
    organizationId: string,
    id: string,
    priorStatus: 'NEW' | 'AUTO_QUEUED' = 'NEW',
    projectId?: string | null
  ) {
    try {
      await this._oppState.model.engageOpportunityState.updateMany({
        where: { organizationId, projectId: projectId ?? null, opportunityId: id },
        data: { status: priorStatus },
      });
    } catch {
      // swallow — caller is already handling an error
    }
  }

  // Resets a SCHEDULED opportunity back to NEW so that sendReply can claim it.
  // Used by cancelAndSendNow after the scheduled post has been deleted.
  async resetScheduledOpportunity(
    organizationId: string,
    opportunityId: string,
    projectId?: string | null
  ) {
    const result = await this._oppState.model.engageOpportunityState.updateMany({
      where: { organizationId, projectId: projectId ?? null, opportunityId, status: 'SCHEDULED' },
      data: { status: 'NEW' },
    });
    if (result.count === 0) {
      throw new BadRequestException('Opportunity is not in SCHEDULED state');
    }
  }

  async deletePostById(postId: string) {
    try {
      await this._post.model.post.delete({ where: { id: postId } });
    } catch {
      // swallow — best-effort cleanup
    }
  }

  async toggleBookmark(organizationId: string, id: string, projectId?: string | null) {
    const row = await this._oppState.model.engageOpportunityState.findFirst({
      where: { organizationId, projectId: projectId ?? null, opportunityId: id },
    });
    if (!row) throw new NotFoundException('Opportunity not found');
    // Update by the resolved surrogate id — projectId is nullable so it can't
    // back a compound-unique `where` (see dismissOpportunity's note).
    const updated = await this._oppState.model.engageOpportunityState.update({
      where: { id: row.id },
      data: { bookmarked: !row.bookmarked },
      include: { opportunity: true },
    });
    return this._merge(updated);
  }

  async getScoreStats(
    organizationId: string,
    date?: 'today' | 'week' | 'month',
    platform?: string,
    projectId?: string | null
  ) {
    // Date/platform filters live on the global opportunity; per-org membership is
    // expressed via the state relation. Two aggregates: org-specific scores from
    // the state table, objective scores from the opportunity table.
    const oppFilter: Prisma.EngageOpportunityWhereInput = {
      deletedAt: null,
      ...(platform && { platform }),
      ...(date === 'today' && {
        postPublishedAt: { gte: dayjs.utc().startOf('day').toDate() },
      }),
      ...(date === 'week' && {
        postPublishedAt: { gte: dayjs.utc().startOf('isoWeek').toDate() },
      }),
      ...(date === 'month' && {
        postPublishedAt: { gte: dayjs.utc().startOf('month').toDate() },
      }),
    };
    const stateWhere: Prisma.EngageOpportunityStateWhereInput = {
      organizationId,
      projectId: projectId ?? null,
      opportunity: oppFilter,
    };
    const oppWhere: Prisma.EngageOpportunityWhereInput = {
      ...oppFilter,
      states: { some: { organizationId, projectId: projectId ?? null } },
    };

    const round1 = (n: number | null | undefined) =>
      n == null ? 0 : Math.round(n * 10) / 10;

    const [stateAgg, oppAgg, distRows, trackedCount, bestKeyword, bestHeat, bestAuthority] =
      await Promise.all([
        this._oppState.model.engageOpportunityState.aggregate({
          where: stateWhere,
          _count: { _all: true },
          _avg: { score: true, scoreKeyword: true, scoreTracked: true },
        }),
        this._opportunity.model.engageOpportunity.aggregate({
          where: oppWhere,
          _avg: { scoreHeat: true, scoreAuthority: true, scoreRecency: true },
        }),
        this._oppState.model.engageOpportunityState.findMany({
          where: stateWhere,
          select: { score: true },
          take: 10_000,
        }),
        this._oppState.model.engageOpportunityState.count({
          where: { ...stateWhere, scoreTracked: { gt: 0 } },
        }),
        this._oppState.model.engageOpportunityState.findFirst({
          where: stateWhere,
          orderBy: { scoreKeyword: 'desc' },
          select: {
            opportunityId: true,
            scoreKeyword: true,
            opportunity: { select: { postContent: true } },
          },
        }),
        this._opportunity.model.engageOpportunity.findFirst({
          where: oppWhere,
          orderBy: { scoreHeat: 'desc' },
          select: { id: true, scoreHeat: true, postContent: true },
        }),
        this._opportunity.model.engageOpportunity.findFirst({
          where: oppWhere,
          orderBy: { scoreAuthority: 'desc' },
          select: { id: true, scoreAuthority: true, postContent: true },
        }),
      ]);

    const total = stateAgg._count._all;
    if (total === 0) {
      return {
        total: 0,
        avgScore: 0,
        avgScoreKeyword: 0,
        avgScoreHeat: 0,
        avgScoreAuthority: 0,
        avgScoreRecency: 0,
        avgScoreTracked: 0,
        distribution: [] as Array<{ range: string; count: number; pct: number }>,
        topByKeyword: null as null | { id: string; score: number; title: string },
        topByHeat: null as null | { id: string; score: number; title: string },
        topByAuthority: null as null | { id: string; score: number; title: string },
        trackedCount: 0,
      };
    }

    const buckets = [
      { range: '85-100' as const, min: 85, max: 100 },
      { range: '70-84' as const, min: 70, max: 84 },
      { range: '60-69' as const, min: 60, max: 69 },
    ];
    const distSampleSize = distRows.length;
    const distribution = buckets.map(({ range, min, max }) => {
      const count = distRows.filter((o) => o.score >= min && o.score <= max).length;
      return {
        range,
        count,
        pct: distSampleSize > 0
          ? Math.round((count / distSampleSize) * 100)
          : 0,
      };
    });

    return {
      total,
      avgScore: round1(stateAgg._avg.score),
      avgScoreKeyword: round1(stateAgg._avg.scoreKeyword),
      avgScoreHeat: round1(oppAgg._avg.scoreHeat),
      avgScoreAuthority: round1(oppAgg._avg.scoreAuthority),
      avgScoreRecency: round1(oppAgg._avg.scoreRecency),
      avgScoreTracked: round1(stateAgg._avg.scoreTracked),
      distribution,
      topByKeyword: bestKeyword && {
        id: bestKeyword.opportunityId,
        score: bestKeyword.scoreKeyword,
        title: bestKeyword.opportunity.postContent.slice(0, 80),
      },
      topByHeat: bestHeat && {
        id: bestHeat.id,
        score: bestHeat.scoreHeat,
        title: bestHeat.postContent.slice(0, 80),
      },
      topByAuthority: bestAuthority && {
        id: bestAuthority.id,
        score: bestAuthority.scoreAuthority,
        title: bestAuthority.postContent.slice(0, 80),
      },
      trackedCount,
    };
  }

  async getOpportunityById(organizationId: string, id: string, projectId?: string | null) {
    const row = await this._oppState.model.engageOpportunityState.findFirst({
      where: { organizationId, projectId: projectId ?? null, opportunityId: id },
      include: { opportunity: true },
    });
    if (!row) throw new NotFoundException('Opportunity not found');

    const merged = this._merge(row);
    const [sentReply, channel] = await Promise.all([
      this._sentReply.model.engageSentReply.findFirst({
        where: {
          organizationId,
          opportunityId: id,
          post: { state: { not: 'DRAFT' } },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, post: { select: { releaseURL: true } } },
      }),
      row.opportunity.platform === 'reddit' && row.opportunity.channelId
        ? this._channel.model.engageMonitoredChannel.findFirst({
            where: {
              platform: 'reddit',
              channelId: row.opportunity.channelId,
            },
            select: { metadata: true },
          })
        : Promise.resolve(null),
    ]);

    const metadata = channel?.metadata as Record<string, unknown> | null | undefined;
    const channelAvatar =
      metadata && typeof metadata === 'object' && typeof metadata.avatar === 'string'
        ? metadata.avatar
        : null;

    return {
      ...merged,
      sentReplyId: sentReply?.id ?? null,
      replyLink: sentReply?.post?.releaseURL ?? null,
      channelAvatar,
    };
  }

  async getOpportunityDetail(organizationId: string, id: string, projectId?: string | null) {
    const row = await this._oppState.model.engageOpportunityState.findFirst({
      where: { organizationId, projectId: projectId ?? null, opportunityId: id },
      include: { opportunity: true },
    });
    if (!row) throw new NotFoundException('Opportunity not found');

    const merged = this._merge(row);

    if (row.status === 'SCHEDULED' || row.status === 'REPLIED') {
      // An opportunity may now carry several replies (batch send); surface the
      // most recent for the detail panel.
      const sentReply = await this._sentReply.model.engageSentReply.findFirst({
        where: { organizationId, opportunityId: id },
        orderBy: { createdAt: 'desc' },
        include: {
          post: {
            select: {
              id: true,
              content: true,
              state: true,
              releaseURL: true,
              publishDate: true,
              impressions: true,
              trafficScore: true,
              analytics: true,
              lastMetricsFetchAt: true,
              integration: {
                select: {
                  id: true,
                  name: true,
                  providerIdentifier: true,
                  picture: true,
                },
              },
            },
          },
          opportunity: {
            select: {
              id: true,
              platform: true,
              externalPostUrl: true,
              postContent: true,
              authorUsername: true,
              authorDisplayName: true,
            },
          },
        },
      });
      return { ...merged, sentReply };
    }

    return { ...merged, sentReply: null };
  }

  async getOpportunityForReply(organizationId: string, id: string, projectId?: string | null) {
    const row = await this._oppState.model.engageOpportunityState.findFirst({
      where: { organizationId, projectId: projectId ?? null, opportunityId: id },
      include: { opportunity: true },
    });
    if (!row) {
      throw new NotFoundException('Opportunity not found');
    }
    // Gate purely on the persisted status — never recompute expiry from the
    // post's age here. Every non-actionable status (EXPIRED/REPLIED/SCHEDULED/
    // DISMISSED) surfaces its own precise reason so the UI can tell the user why
    // generation is blocked, instead of a generic 404.
    const blockReason = NON_ACTIONABLE_REPLY_REASONS[row.status];
    if (blockReason) {
      throw new ForbiddenException(blockReason);
    }
    return this._merge(row);
  }

  // ─── Sent Replies ─────────────────────────────────────────────────────────

  async createSentReply(data: {
    organizationId: string;
    projectId?: string | null;
    opportunityId: string;
    postId: string;
    inputData: object;
    // Send-time snapshot of which keyword(s) this opportunity matched for
    // this project — copied from EngageOpportunityState.matchedKeywords by
    // the caller (schema.prisma's EngageSentReply.matchedKeywords comment).
    // Never recomputed here.
    matchedKeywords?: string[];
  }) {
    // Tracking is keyed per-post (postId is @unique), so a batch that sends N
    // replies to one opportunity records N rows. There is no per-opportunity
    // unique to collide on, so this is a plain create.
    const reply = await this._sentReply.model.engageSentReply.create({
      data: {
        organizationId: data.organizationId,
        projectId: data.projectId ?? null,
        opportunityId: data.opportunityId,
        postId: data.postId,
        inputData: data.inputData as Prisma.InputJsonValue,
        matchedKeywords: data.matchedKeywords ?? [],
      },
    });
    // A committed real reply obsoletes any saved working DRAFT for this opportunity.
    // Done HERE (after the reply row exists) rather than at claim time so a FAILED
    // publish — which rolls the claim back — leaves the saved draft intact. Best-
    // effort: the reply is already live/scheduled, so a cleanup failure must not fail
    // the flow.
    await this._deleteDraftsForOpportunity(
      data.organizationId,
      data.opportunityId,
      data.projectId
    ).catch(() => undefined);
    return reply;
  }

  // §6.1 per-account daily send cap: live count of one integration's sent
  // replies since `since` (the caller passes today's UTC start). No
  // dedicated capacity table — the cap VALUE lives in Settings, this is just
  // the "how many so far" half (project-scoped-post-engage-design.md §3.4).
  async countAccountSentRepliesToday(
    integrationId: string,
    since: Date,
    until?: Date
  ): Promise<number> {
    return this._sentReply.model.engageSentReply.count({
      where: {
        post: {
          integrationId,
          publishDate: { gte: since, ...(until && { lt: until }) },
          state: { in: ['QUEUE', 'PUBLISHED'] },
        },
      },
    });
  }

  // §6 project daily target gate: live count of this project's sent replies
  // on one platform since `since`. `qualifiedReplyCount` in the design doc's
  // formulas — always a live COUNT, never a maintained counter.
  async countProjectSentRepliesToday(
    organizationId: string,
    projectId: string,
    platform: string,
    since: Date,
    until?: Date
  ): Promise<number> {
    return this._sentReply.model.engageSentReply.count({
      where: {
        organizationId,
        projectId,
        post: {
          publishDate: { gte: since, ...(until && { lt: until }) },
          state: { in: ['QUEUE', 'PUBLISHED'] },
        },
        opportunity: { platform },
      },
    });
  }

  // §3.4/§6 per-keyword daily target gate: same window/state semantics as
  // countProjectSentRepliesToday, additionally narrowed to replies whose
  // send-time `matchedKeywords` snapshot contains `keyword`. A reply matching
  // three keywords counts toward each of their three per-keyword tallies (the
  // `has` array filter is the single-table `unnest` the design's §3.3bis calls
  // for) — it still counts as one unit toward the aggregate target above.
  async countProjectKeywordSentRepliesToday(
    organizationId: string,
    projectId: string,
    platform: string,
    keyword: string,
    since: Date,
    until?: Date
  ): Promise<number> {
    return this._sentReply.model.engageSentReply.count({
      where: {
        organizationId,
        projectId,
        matchedKeywords: { has: keyword },
        post: {
          publishDate: { gte: since, ...(until && { lt: until }) },
          state: { in: ['QUEUE', 'PUBLISHED'] },
        },
        opportunity: { platform },
      },
    });
  }

  // Shared filter for the sent-reply LIST and STATS so both apply identical
  // date/platform/status semantics. No `date` → all-time (no publishDate window),
  // mirroring /engage/sent. Returns both the Post-scoped and SentReply-scoped where.
  //
  // `includeDrafts` ONLY affects the no-status ("All") branch: the LIST passes true
  // so the default feed shows saved DRAFT working-copies too (otherwise `awaiting`
  // could return MORE rows than the unfiltered list, since DRAFTs live only there —
  // confusing). STATS leaves it false because the cards are "发出回复" (sent-reply)
  // performance — a never-sent draft has no impressions, drags down the response
  // rate, and isn't a reply that went out. All explicit status filters are
  // unaffected (each pins its own state).
  private _buildSentReplyFilter(
    organizationId: string,
    dto: { date?: string; platform?: string; status?: string; projectId?: string },
    opts: { includeDrafts?: boolean } = {}
  ): { postWhere: Prisma.PostWhereInput; sentWhere: Prisma.EngageSentReplyWhereInput } {
    // Single source of truth for the date→publishDate window (shared with
    // getDashboardSummary), so /sent, /sent/stats and /dashboard/summary all
    // accept the same vocabulary (all | day | today | week | month).
    const postWhere: Prisma.PostWhereInput = {
      source: 'engage',
      ...this._engageDateWindow(dto.date),
    };

    // Narrows the linked EngageOpportunity beyond the plain platform filter.
    // Only 'awaiting-draft' / 'awaiting-expired' set this — they key off this
    // org's EngageOpportunityState.status (EXPIRED = the draft's source post aged
    // out of the actionable feed and can no longer be turned into a real reply).
    let opportunityWhere: Prisma.EngageOpportunityWhereInput | undefined;

    if (dto.status === 'published') {
      postWhere.state = 'PUBLISHED';
      postWhere.releaseURL = { not: null };
    } else if (dto.status === 'scheduled') postWhere.state = 'QUEUE';
    else if (dto.status === 'error') postWhere.state = 'ERROR';
    else if (dto.status === 'draft') postWhere.state = 'DRAFT';
    else if (dto.status === 'manual') {
      postWhere.state = 'PUBLISHED';
      postWhere.releaseURL = null;
    } else if (dto.status === 'awaiting') {
      // "Awaiting review": has content but not yet live — a saved working DRAFT
      // (generated/typed but never sent), manual link-pending (PUBLISHED with no
      // releaseURL), OR a failed publish (ERROR). This is the ONLY filter that
      // surfaces DRAFT working-copies; the OR ANDs with source=engage + the date
      // window above. (Replaces the former GET /engage/awaiting-review endpoint.)
      postWhere.OR = [
        { state: 'DRAFT' },
        { state: 'PUBLISHED', releaseURL: null },
        { state: 'ERROR' },
      ];
    } else if (dto.status === 'awaiting-draft') {
      // Awaiting-review tab "Drafts": a saved working DRAFT whose source
      // opportunity is still actionable for this org.
      postWhere.state = 'DRAFT';
      opportunityWhere = {
        states: {
          some: {
            organizationId,
            projectId: dto.projectId ?? null,
            status: { not: 'EXPIRED' },
          },
        },
      };
    } else if (dto.status === 'awaiting-expired') {
      // Awaiting-review tab "Expired": a saved working DRAFT whose source
      // opportunity aged out of the actionable feed for this org — read-only.
      postWhere.state = 'DRAFT';
      opportunityWhere = {
        states: {
          some: { organizationId, projectId: dto.projectId ?? null, status: 'EXPIRED' },
        },
      };
    } else if (dto.status === 'awaiting-link') {
      // Awaiting-review tab "Awaiting link": needs the user to act before the
      // reply counts as sent — a manual link-pending publish (PUBLISHED with no
      // releaseURL) OR a failed publish attempt (ERROR).
      postWhere.OR = [
        { state: 'PUBLISHED', releaseURL: null },
        { state: 'ERROR' },
      ];
    } else if (dto.status === 'settled') {
      // "Settled" (已处理): no further user action needed — published & live
      // (PUBLISHED with a releaseURL) OR scheduled to auto-fire (QUEUE). The exact
      // complement of `awaiting` over the four sent/attempted states; the OR ANDs
      // with source=engage and the date window above.
      postWhere.OR = [
        { state: 'PUBLISHED', releaseURL: { not: null } },
        { state: 'QUEUE' },
      ];
    } else if (!opts.includeDrafts) {
      // No status filter, STATS scope = "All" SENT replies: exclude unsent DRAFT
      // working-copies — a saved draft is not a sent reply, so it must not pollute
      // the "发出回复" / response-rate / impression cards (and the dashboards, which
      // also exclude DRAFT). The LIST scope passes includeDrafts:true and skips this
      // branch entirely, so the default feed shows every engage item (incl. DRAFT)
      // and `awaiting`/`settled` stay subsets of it.
      postWhere.state = { not: 'DRAFT' };
    }

    const sentWhere: Prisma.EngageSentReplyWhereInput = {
      organizationId,
      projectId: dto.projectId ?? null,
      post: postWhere,
      // Apply platform filter via the linked opportunity's platform field, merged
      // with the EXPIRED-state sub-filter above when both are present.
      ...((dto.platform || opportunityWhere) && {
        opportunity: {
          ...(dto.platform && { platform: dto.platform }),
          ...opportunityWhere,
        },
      }),
    };

    return { postWhere, sentWhere };
  }

  async listSentReplies(organizationId: string, dto: ListSentDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;

    // The list shows DRAFT working-copies in the default "All" view too, so
    // `awaiting` (which always includes DRAFT) can never return more rows than the
    // unfiltered list.
    const { sentWhere: where } = this._buildSentReplyFilter(organizationId, dto, {
      includeDrafts: true,
    });

    const [items, total] = await Promise.all([
      this._sentReply.model.engageSentReply.findMany({
        where,
        include: {
          post: {
            select: {
              id: true,
              content: true,
              state: true,
              releaseURL: true,
              publishDate: true,
              impressions: true,
              trafficScore: true,
              analytics: true,
              lastMetricsFetchAt: true,
              // settings carries engageAuthor for manual replies posted from an
              // account that isn't a connected integration (integrationId=null).
              settings: true,
              integration: {
                select: {
                  id: true,
                  name: true,
                  providerIdentifier: true,
                  picture: true,
                  // profile (@handle) + internalId (numeric X id) let us build a
                  // unified replyAuthor from the integration when it authored the reply.
                  profile: true,
                  internalId: true,
                },
              },
            },
          },
          opportunity: {
            select: {
              id: true,
              platform: true,
              externalPostUrl: true,
              postContent: true,
              authorUsername: true,
              authorDisplayName: true,
              authorFollowers: true,
              authorAvatarUrl: true,
              postPublishedAt: true,
            },
          },
        },
        // Stable tiebreaker so `locateSentReply` can reproduce the exact page
        // index for replies sharing the same createdAt.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: limit,
      }),
      this._sentReply.model.engageSentReply.count({ where }),
    ]);

    // Attach the keywords this org matched on the opportunity (shown on the sent
    // card so the user remembers why they replied). matchedKeywords is per-org,
    // living on EngageOpportunityState — joined here by (organizationId,
    // opportunityId) rather than via the opportunity, since the SentReply links
    // to the shared opportunity, not the org's state row. One bounded query.
    const oppIds = items.map((it) => it.opportunity.id);
    const states = oppIds.length
      ? (await this._oppState.model.engageOpportunityState.findMany({
          where: {
            organizationId,
            projectId: dto.projectId ?? null,
            opportunityId: { in: oppIds },
          },
          select: {
            opportunityId: true,
            matchedKeywords: true,
            // Per-org lifecycle status of the opportunity (NEW/REPLIED/SCHEDULED/…),
            // surfaced on the sent card so the frontend can reflect the org's state.
            status: true,
            // The org's full version history of AI-generated reply drafts for this
            // opportunity — returned so the frontend can show past generations.
            generationHistory: true,
          },
        })) ?? []
      : [];
    const keywordsByOpp = new Map(
      states.map((s) => [s.opportunityId, s.matchedKeywords])
    );
    // Per-org opportunity status, attached to the opportunity object below.
    const statusByOpp = new Map(states.map((s) => [s.opportunityId, s.status]));
    // newest-first so the UI lists the most recent generation at the top.
    const historyByOpp = new Map(
      states.map((s) => [
        s.opportunityId,
        normalizeGenerationHistory(s.generationHistory),
      ])
    );

    // Attach a flat, frontend-friendly `metrics` object (every per-platform field
    // present) derived from the verbose Post.analytics array, so the UI can read
    // e.g. metrics.bookmarks directly. Post.analytics is kept for compatibility.
    const itemsWithMetrics = items.map((it) => {
      const opportunity = {
        ...it.opportunity,
        status: statusByOpp.get(it.opportunity.id) ?? null,
        matchedKeywords: keywordsByOpp.get(it.opportunity.id) ?? [],
        generationHistory: historyByOpp.get(it.opportunity.id) ?? [],
      };
      if (!it.post) return { ...it, opportunity };
      // Surface the reply author (the account that posted the reply) as a clean
      // `replyAuthor` field, and drop the raw `settings` blob from the response.
      const { settings, ...postRest } = it.post;
      return {
        ...it,
        opportunity,
        post: {
          ...postRest,
          replyAuthor: resolveReplyAuthor(it.post.integration, settings),
          metrics: normalizeReplyMetrics(
            it.opportunity.platform,
            it.post.analytics,
            it.post.impressions,
            it.post.trafficScore
          ),
        },
      };
    });

    return { items: itemsWithMetrics, total, page, limit };
  }

  async locateSentReply(organizationId: string, dto: LocateSentReplyDto) {
    const limit = dto.limit ?? 20;

    // Mirror the `where` from `listSentReplies` exactly — including DRAFT in the
    // "All" view, so a draft row can be located on the same page the list shows it.
    const { sentWhere: where } = this._buildSentReplyFilter(organizationId, dto, {
      includeDrafts: true,
    });

    const target = await this._sentReply.model.engageSentReply.findFirst({
      where: { ...where, id: dto.sentReplyId },
      select: { id: true, createdAt: true },
    });

    if (!target) {
      const total = await this._sentReply.model.engageSentReply.count({ where });
      return {
        found: false as const,
        page: null as number | null,
        position: null as number | null,
        total,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    }

    const [precedingByCreatedAt, precedingById, total] = await Promise.all([
      // Replies with strictly newer createdAt come before target in desc order.
      this._sentReply.model.engageSentReply.count({
        where: { ...where, createdAt: { gt: target.createdAt } },
      }),
      // Ties on createdAt: id desc, so higher id = earlier in list.
      this._sentReply.model.engageSentReply.count({
        where: {
          ...where,
          createdAt: target.createdAt,
          id: { gt: target.id },
        },
      }),
      this._sentReply.model.engageSentReply.count({ where }),
    ]);

    const position = precedingByCreatedAt + precedingById + 1;
    const page = Math.ceil(position / limit);

    return {
      found: true as const,
      page,
      position,
      total,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // Aggregate stats for sent replies, scoped by the same date/platform/status
  // filters as listSentReplies (no `date` → all-time). repliesCount, responseRate,
  // totalImpressions and avgLikes all reflect the selected window. NOTE: unlike the
  // list, the no-status ("All") scope here EXCLUDES DRAFT (includeDrafts defaults
  // false) — these are "发出回复" / sent-reply performance numbers, and a never-sent
  // draft has no impressions and would deflate the response rate.
  async getSentStats(
    organizationId: string,
    dto: { date?: string; platform?: string; status?: string } = {}
  ) {
    const { postWhere, sentWhere } = this._buildSentReplyFilter(organizationId, dto);

    // Totals and response rate via DB aggregation — no row cap.
    const [total, repliedCount, impressionsAgg, likeSample] = await Promise.all([
      this._sentReply.model.engageSentReply.count({ where: sentWhere }),
      this._sentReply.model.engageSentReply.count({
        where: { ...sentWhere, authorReplied: true },
      }),
      // Impressions live on Post; sum across the windowed engage posts. The
      // platform filter goes through the post→engageSentReply→opportunity link.
      this._post.model.post.aggregate({
        where: {
          organizationId,
          ...postWhere,
          ...(dto.platform
            ? { engageSentReply: { is: { opportunity: { platform: dto.platform } } } }
            : {}),
        },
        _sum: { impressions: true, trafficScore: true },
      }),
      // Analytics is a JSON column; aggregating inside is database-specific.
      // Keep a bounded recent sample (1_000 most recent replies) just for the
      // avgLikes derivation — total/responseRate/impressions are now exact.
      this._sentReply.model.engageSentReply.findMany({
        where: sentWhere,
        orderBy: { createdAt: 'desc' },
        take: 1_000,
        select: {
          post: { select: { analytics: true } },
          opportunity: { select: { platform: true } },
        },
      }),
    ]);

    const responseRate =
      total > 0 ? Math.round((repliedCount / total) * 100) : 0;
    const totalImpressions = impressionsAgg._sum.impressions ?? 0;
    const totalTrafficScore = Math.round(impressionsAgg._sum.trafficScore ?? 0);

    // 平均获赞 = AVG(X like_count) combined with AVG(Reddit score). Both are read
    // out of the analytics blob via the same platform-aware extractor.
    const likesPerReply = likeSample
      .map((r) => this._extractLikes(r.post?.analytics, r.opportunity.platform))
      .filter((v) => v > 0);

    const avgLikes =
      likesPerReply.length > 0
        ? Math.round(
            likesPerReply.reduce((s, v) => s + v, 0) / likesPerReply.length
          )
        : 0;

    return { repliesCount: total, responseRate, totalImpressions, totalTrafficScore, avgLikes };
  }

  // Single round trip replacing the frontend's `listSentReplies({ platform,
  // limit: 1 })` x3 (for the x/reddit tab badges) plus a further x3 for the
  // all/settled/awaiting rollup badges. `byPlatform` respects the passed-in
  // `status` scope (mirrors fetchSentPlatformCounts' per-tab platform split);
  // `rollups` always recomputes settled/awaiting from `date` alone (ignoring
  // any passed-in `status`) since those badges need their own totals
  // regardless of which status tab is currently active.
  //
  // `awaitingBreakdown` (drafts/link/expired) only fires when `status=awaiting`
  // — it backs the Awaiting-review page's own Drafts / Awaiting link / Expired
  // sub-tab badges, which are only ever visible while that page is open, so the
  // three extra counts stay off the hot path for every other status scope.
  async getSentCounts(
    organizationId: string,
    dto: { date?: string; status?: string } = {}
  ) {
    const { sentWhere } = this._buildSentReplyFilter(organizationId, dto, {
      includeDrafts: true,
    });
    const injectPlatform = (platform: string): Prisma.EngageSentReplyWhereInput => ({
      ...sentWhere,
      opportunity: {
        ...(sentWhere.opportunity as Prisma.EngageOpportunityWhereInput | undefined),
        platform,
      },
    });

    const { sentWhere: settledWhere } = this._buildSentReplyFilter(
      organizationId,
      { date: dto.date, status: 'settled' },
      { includeDrafts: true }
    );
    const { sentWhere: awaitingWhere } = this._buildSentReplyFilter(
      organizationId,
      { date: dto.date, status: 'awaiting' },
      { includeDrafts: true }
    );

    const wantsAwaitingBreakdown = dto.status === 'awaiting';
    const { sentWhere: awaitingDraftWhere } = this._buildSentReplyFilter(
      organizationId,
      { date: dto.date, status: 'awaiting-draft' },
      { includeDrafts: true }
    );
    const { sentWhere: awaitingLinkWhere } = this._buildSentReplyFilter(
      organizationId,
      { date: dto.date, status: 'awaiting-link' },
      { includeDrafts: true }
    );
    const { sentWhere: awaitingExpiredWhere } = this._buildSentReplyFilter(
      organizationId,
      { date: dto.date, status: 'awaiting-expired' },
      { includeDrafts: true }
    );

    const [total, x, reddit, settled, awaiting, drafts, link, expired] =
      await Promise.all([
        this._sentReply.model.engageSentReply.count({ where: sentWhere }),
        this._sentReply.model.engageSentReply.count({ where: injectPlatform('x') }),
        this._sentReply.model.engageSentReply.count({ where: injectPlatform('reddit') }),
        this._sentReply.model.engageSentReply.count({ where: settledWhere }),
        this._sentReply.model.engageSentReply.count({ where: awaitingWhere }),
        wantsAwaitingBreakdown
          ? this._sentReply.model.engageSentReply.count({ where: awaitingDraftWhere })
          : Promise.resolve(0),
        wantsAwaitingBreakdown
          ? this._sentReply.model.engageSentReply.count({ where: awaitingLinkWhere })
          : Promise.resolve(0),
        wantsAwaitingBreakdown
          ? this._sentReply.model.engageSentReply.count({ where: awaitingExpiredWhere })
          : Promise.resolve(0),
      ]);

    return {
      total,
      byPlatform: { x, reddit },
      rollups: { settled, awaiting },
      ...(wantsAwaitingBreakdown && { awaitingBreakdown: { drafts, link, expired } }),
    };
  }

  // Pull the "likes" metric out of a Post.analytics JSON blob. X stores it under
  // a like/favorite label; Reddit's equivalent is the post score. The sync writes
  // each metric as { label, data: [{ total, date }], percentageChange }.
  private _extractLikes(analytics: unknown, platform: string): number {
    if (!Array.isArray(analytics)) return 0;
    const wanted = platform === 'reddit' ? /score|upvote/i : /like|favorite|reaction/i;
    const entry = (
      analytics as Array<{ label?: string; data?: Array<{ total?: string | number }> }>
    ).find((a) => a.label && wanted.test(a.label));
    const raw = entry?.data?.[entry.data.length - 1]?.total;
    const n =
      typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : 0;
    return Number.isFinite(n) ? n : 0;
  }

  // Shared engage date window on Post.publishDate. 'all'/empty/undefined → no
  // window; 'day'/'today' → today; 'week' → ISO week; 'month' → calendar month.
  private _engageDateWindow(date?: string): { publishDate?: { gte: Date } } {
    const gte =
      date === 'day' || date === 'today'
        ? dayjs.utc().startOf('day').toDate()
        : date === 'week'
        ? dayjs.utc().startOf('isoWeek').toDate()
        : date === 'month'
        ? dayjs.utc().startOf('month').toDate()
        : null;
    return gte ? { publishDate: { gte } } : {};
  }

  // Dashboard panel ① "Engage Performance": reply count, response rate,
  // impressions, traffic index, total likes/upvotes, per-platform split, and the
  // single best reply — all scoped to the optional platform + date window
  // (default all-time). Pass platform='x'|'reddit' for the UI tab/chip scope.
  async getDashboardSummary(
    organizationId: string,
    opts: { projectId?: string; platform?: string; date?: string } = {}
  ) {
    const platform = opts.platform;
    const platformFilter = platform ? { opportunity: { platform } } : {};
    const dateWindow = this._engageDateWindow(opts.date);
    // Optional project scope. Folded into the related Post filter (Post.projectId)
    // so every EngageSentReply query below inherits it via `post.is`; the two
    // direct Post aggregates apply it on their own top-level where. Omitted =
    // organization-wide (legacy behavior).
    const projectFilter = opts.projectId ? { projectId: opts.projectId } : {};

    // Reply-count + best-reply metrics: only replies actually SENT (`PUBLISHED`,
    // excludes future-scheduled QUEUE and errored), within the date window.
    const sentPostFilter = {
      is: {
        source: 'engage',
        state: 'PUBLISHED',
        ...dateWindow,
        ...projectFilter,
      } as Prisma.PostWhereInput,
    };
    // Window filter for the totals/response-rate scope: any SENT/attempted state
    // but NOT unsent DRAFT working-copies (a draft is not a reply, so it must not
    // inflate the response-rate denominator).
    const windowedPostFilter = {
      is: {
        source: 'engage',
        state: { not: 'DRAFT' },
        ...dateWindow,
        ...projectFilter,
      } as Prisma.PostWhereInput,
    };

    const [
      total,
      repliedCount,
      sentReplies,
      xSent,
      redditSent,
      totalPostAgg,
      xPostAgg,
      replyRows,
      bestReplyRows,
    ] =
      await Promise.all([
        this._sentReply.model.engageSentReply.count({
          where: { organizationId, post: windowedPostFilter, ...platformFilter },
        }),
        this._sentReply.model.engageSentReply.count({
          where: { organizationId, post: windowedPostFilter, authorReplied: true, ...platformFilter },
        }),
        this._sentReply.model.engageSentReply.count({
          where: { organizationId, post: sentPostFilter, ...platformFilter },
        }),
        this._sentReply.model.engageSentReply.count({
          where: { organizationId, post: sentPostFilter, opportunity: { platform: 'x' } },
        }),
        this._sentReply.model.engageSentReply.count({
          where: { organizationId, post: sentPostFilter, opportunity: { platform: 'reddit' } },
        }),
        // Headline impressions + traffic for the selected UI scope + date window.
        this._post.model.post.aggregate({
          where: {
            organizationId,
            source: 'engage',
            ...dateWindow,
            ...projectFilter,
            ...(platform
              ? { engageSentReply: { is: { opportunity: { platform } } } }
              : {}),
          },
          _sum: { impressions: true, trafficScore: true },
        }),
        // X-only cumulative impressions + traffic index across engage X posts in window.
        this._post.model.post.aggregate({
          where: {
            organizationId,
            source: 'engage',
            ...dateWindow,
            ...projectFilter,
            engageSentReply: { is: { opportunity: { platform: 'x' } } },
          },
          _sum: { impressions: true, trafficScore: true },
        }),
        // Likes/upvotes for the selected UI scope + window. Analytics is JSON, so use
        // the same platform-aware extractor as sent stats after loading the rows.
        this._sentReply.model.engageSentReply.findMany({
          where: { organizationId, post: windowedPostFilter, ...platformFilter },
          select: {
            opportunity: { select: { platform: true } },
            post: { select: { analytics: true } },
          },
        }),
        // All sent replies, to pick the single best one (most likes/upvotes).
        this._sentReply.model.engageSentReply.findMany({
          where: { organizationId, post: sentPostFilter, ...platformFilter },
          select: {
            opportunity: {
              select: {
                id: true,
                platform: true,
                externalPostUrl: true,
                authorUsername: true,
                authorDisplayName: true,
                authorAvatarUrl: true,
              },
            },
            post: { select: { content: true, releaseURL: true, analytics: true } },
          },
        }),
      ]);

    const responseRate = total > 0 ? Math.round((repliedCount / total) * 100) : 0;

    let bestReply: {
      opportunityId: string;
      platform: string;
      content: string;
      likes: number;
      url: string | null;
      // Account info of the original post's author (the engagement source).
      author: {
        username: string;
        displayName: string | null;
        avatarUrl: string | null;
      };
    } | null = null;
    let bestLikes = 0;
    for (const r of bestReplyRows) {
      const likes = this._extractLikes(r.post?.analytics, r.opportunity.platform);
      if (likes > bestLikes) {
        bestLikes = likes;
        bestReply = {
          opportunityId: r.opportunity.id,
          platform: r.opportunity.platform,
          content: r.post?.content ?? '',
          likes,
          url: r.post?.releaseURL ?? r.opportunity.externalPostUrl ?? null,
          author: {
            username: r.opportunity.authorUsername,
            displayName: r.opportunity.authorDisplayName ?? null,
            avatarUrl: r.opportunity.authorAvatarUrl ?? null,
          },
        };
      }
    }

    const xImpressions = xPostAgg._sum.impressions ?? 0;
    const totalImpressions = totalPostAgg._sum.impressions ?? 0;
    const redditImpressions = Math.max(0, totalImpressions - xImpressions);

    return {
      // All-time count of SENT replies (PUBLISHED only).
      repliesCount: sentReplies,
      responseRate,
      xImpressions,
      xTrafficIndex: Math.round(xPostAgg._sum.trafficScore ?? 0),
      totalImpressions,
      totalTrafficScore: Math.round(totalPostAgg._sum.trafficScore ?? 0),
      totalLikes: replyRows.reduce(
        (sum, r) => sum + this._extractLikes(r.post?.analytics, r.opportunity.platform),
        0
      ),
      impressionsByPlatform: [
        { platform: 'x', value: xImpressions },
        { platform: 'reddit', value: redditImpressions },
      ],
      platformSplit: { x: xSent, reddit: redditSent },
      bestReply,
    };
  }

  // Dashboard panel ② "Your Posts" overlay: Engage reply counts bucketed by
  // period (daily/weekly/monthly).
  async getDashboardRepliesTrend(
    organizationId: string,
    period: 'daily' | 'weekly' | 'monthly' = 'daily',
    projectId?: string
  ) {
    let rangeStart: Date;
    if (period === 'monthly') {
      rangeStart = dayjs.utc().subtract(11, 'month').startOf('month').toDate();
    } else if (period === 'weekly') {
      rangeStart = dayjs.utc().subtract(11, 'week').isoWeekday(1).startOf('day').toDate();
    } else {
      rangeStart = dayjs.utc().subtract(29, 'day').startOf('day').toDate();
    }

    const rows = await this._sentReply.model.engageSentReply.findMany({
      where: {
        organizationId,
        // Exclude unsent DRAFT working-copies — they are not replies and must not be
        // counted in the replies-per-day trend. Optional project scope via
        // Post.projectId; omitted = organization-wide.
        post: {
          is: {
            source: 'engage',
            state: { not: 'DRAFT' },
            publishDate: { gte: rangeStart },
            ...(projectId ? { projectId } : {}),
          },
        },
      },
      select: {
        opportunity: { select: { platform: true } },
        post: { select: { publishDate: true } },
      },
    });

    const buckets = new Map<
      string,
      { date: string; count: number; x: number; reddit: number }
    >();

    // Pre-seed continuous buckets so chart has zero-filled slots.
    if (period === 'monthly') {
      for (let i = 11; i >= 0; i--) {
        const d = dayjs.utc().subtract(i, 'month').format('YYYY-MM');
        buckets.set(d, { date: d, count: 0, x: 0, reddit: 0 });
      }
    } else if (period === 'weekly') {
      for (let i = 11; i >= 0; i--) {
        const d = dayjs.utc().subtract(i, 'week').isoWeekday(1).format('YYYY-MM-DD');
        buckets.set(d, { date: d, count: 0, x: 0, reddit: 0 });
      }
    } else {
      for (let i = 29; i >= 0; i--) {
        const d = dayjs.utc().subtract(i, 'day').format('YYYY-MM-DD');
        buckets.set(d, { date: d, count: 0, x: 0, reddit: 0 });
      }
    }

    for (const r of rows) {
      if (!r.post?.publishDate) continue;
      const d = dayjs.utc(r.post.publishDate);
      let dateKey: string;
      switch (period) {
        case 'monthly':
          dateKey = d.format('YYYY-MM');
          break;
        case 'weekly':
          dateKey = d.isoWeekday(1).format('YYYY-MM-DD');
          break;
        default:
          dateKey = d.format('YYYY-MM-DD');
      }
      const b = buckets.get(dateKey);
      if (!b) continue;
      b.count++;
      if (r.opportunity.platform === 'reddit') b.reddit++;
      else b.x++;
    }

    return { period: period ?? 'daily', items: [...buckets.values()] };
  }

  // Dashboard panel ③ "Traffic from Engage": total traffic index (clicks) plus a
  // per-reply breakdown sorted by traffic, for the progress-bar list. Defaults to
  // all engage platforms; pass platform='x' for the X-only "X 流量指数汇总".
  async getDashboardTraffics(
    organizationId: string,
    opts: { projectId?: string; platform?: string; limit?: number } = {}
  ) {
    const limit = opts.limit ?? 10;
    const platform = opts.platform;
    const projectId = opts.projectId;

    const [agg, items] = await Promise.all([
      this._post.model.post.aggregate({
        where: {
          organizationId,
          source: 'engage',
          ...(projectId ? { projectId } : {}),
          ...(platform
            ? { engageSentReply: { is: { opportunity: { platform } } } }
            : {}),
        },
        _sum: { trafficScore: true },
      }),
      this._sentReply.model.engageSentReply.findMany({
        where: {
          organizationId,
          ...(platform ? { opportunity: { platform } } : {}),
          post: {
            is: {
              source: 'engage',
              trafficScore: { not: null },
              ...(projectId ? { projectId } : {}),
            },
          },
        },
        select: {
          opportunity: { select: { id: true, platform: true, externalPostUrl: true } },
          post: {
            select: {
              content: true,
              releaseURL: true,
              publishDate: true,
              trafficScore: true,
            },
          },
        },
        orderBy: { post: { trafficScore: 'desc' } },
        take: limit,
      }),
    ]);

    return {
      totalClicks: Math.round(agg._sum.trafficScore ?? 0),
      items: items.map((r) => ({
        opportunityId: r.opportunity.id,
        platform: r.opportunity.platform,
        content: r.post?.content ?? '',
        clicks: Math.round(r.post?.trafficScore ?? 0),
        time: r.post?.publishDate ?? null,
        url: r.post?.releaseURL ?? r.opportunity.externalPostUrl ?? null,
      })),
    };
  }

  // Panel ④ "Engage Impressions Trend" — impressions by publish date and
  // platform for engage posts. Period bucketing matches /dashboard/impressions
  // so the frontend can reuse the same chart component.
  async getDashboardImpressions(
    organizationId: string,
    period: 'daily' | 'weekly' | 'monthly' = 'daily',
    projectId?: string
  ) {
    const sinceDays = period === 'monthly' ? 365 : period === 'weekly' ? 90 : 30;
    const rangeStart = dayjs.utc().subtract(sinceDays, 'day').startOf('day').toDate();

    const rows = await this._post.model.post.findMany({
      where: {
        organizationId,
        source: 'engage',
        // Exclude unsent DRAFT working-copies (no impressions; not a published post).
        state: { not: 'DRAFT' },
        publishDate: { gte: rangeStart },
        // Optional project scope via Post.projectId; omitted = organization-wide.
        ...(projectId ? { projectId } : {}),
      },
      select: {
        impressions: true,
        publishDate: true,
        engageSentReply: {
          select: { opportunity: { select: { platform: true } } },
        },
      },
    });

    const buckets = new Map<
      string,
      { date: string; platform: string; value: number }
    >();

    for (const row of rows) {
      if (!row.publishDate) continue;
      const d = dayjs.utc(row.publishDate);
      let dateKey: string;
      switch (period) {
        case 'weekly':
          dateKey = d.isoWeekday(1).format('YYYY-MM-DD');
          break;
        case 'monthly':
          dateKey = d.format('YYYY-MM');
          break;
        default:
          dateKey = d.format('YYYY-MM-DD');
      }

      const platform = row.engageSentReply?.opportunity?.platform ?? 'unknown';
      const key = `${dateKey}|${platform}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.value += row.impressions ?? 0;
      } else {
        buckets.set(key, { date: dateKey, platform, value: row.impressions ?? 0 });
      }
    }

    const result = Array.from(buckets.values());
    result.sort((a, b) => a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform));
    return result;
  }

  // Panel ⑤ "Top engage sources" — top engage replies ranked by the per-platform
  // engagement metric: X by likes, Reddit by upvotes (descending). Deliberately
  // kept SEPARATE from /sent (listSentReplies): the panel only needs the reply
  // itself + the posting account + metrics, so this query skips the original-post
  // (opportunity) author fields and the per-org matchedKeywords join that /sent
  // carries. likes/upvotes live inside Post.analytics (extracted by
  // normalizeReplyMetrics), not as a sortable column, so we fetch the published
  // candidate set and rank in memory. With no platform filter each item ranks by
  // its own metric, so a mixed list still sorts sensibly.
  async getDashboardTopSources(
    organizationId: string,
    opts: { projectId?: string; platform?: string; limit?: number } = {}
  ) {
    const limit = opts.limit ?? 10;
    const platform = opts.platform;
    const projectId = opts.projectId;

    const rows = await this._sentReply.model.engageSentReply.findMany({
      where: {
        organizationId,
        ...(platform ? { opportunity: { platform } } : {}),
        post: {
          is: {
            source: 'engage',
            trafficScore: { not: null },
            ...(projectId ? { projectId } : {}),
          },
        },
      },
      select: {
        id: true,
        // Only the platform is needed (to pick the ranking metric) and the
        // external URL as a link fallback — no original-post author fields.
        opportunity: { select: { platform: true, externalPostUrl: true } },
        post: {
          select: {
            id: true,
            content: true,
            releaseURL: true,
            publishDate: true,
            impressions: true,
            trafficScore: true,
            analytics: true,
            // settings carries engageAuthor for manual replies; integration is
            // the connected account — together they resolve the reply author.
            settings: true,
            integration: {
              select: {
                id: true,
                name: true,
                providerIdentifier: true,
                picture: true,
                profile: true,
                internalId: true,
              },
            },
          },
        },
      },
    });

    // Reddit → upvotes, everything else (X) → likes; missing metrics rank as 0.
    const rankValue = (p: string, metrics: { likes?: number; upvotes?: number }) =>
      p === 'reddit' ? metrics.upvotes ?? 0 : metrics.likes ?? 0;

    const items = rows.map((r) => {
      const p = r.opportunity?.platform ?? 'unknown';
      const metrics = normalizeReplyMetrics(
        p,
        r.post?.analytics,
        r.post?.impressions,
        r.post?.trafficScore
      );
      return {
        id: r.id,
        platform: p,
        post: {
          id: r.post?.id ?? null,
          content: r.post?.content ?? '',
          releaseURL: r.post?.releaseURL ?? r.opportunity?.externalPostUrl ?? null,
          publishDate: r.post?.publishDate ?? null,
          // The account that posted the reply (avatar + @handle), as in /sent.
          replyAuthor: resolveReplyAuthor(r.post?.integration ?? null, r.post?.settings ?? null),
          metrics,
        },
        metric: rankValue(p, metrics),
      };
    });

    items.sort((a, b) => b.metric - a.metric);
    return { items: items.slice(0, limit), total: items.length };
  }

  async updateScheduledReply(
    organizationId: string,
    id: string,
    data: { content?: string; inputData?: object }
  ) {
    const reply = await this._sentReply.model.engageSentReply.findFirst({
      where: { id, organizationId },
      include: { post: { select: { id: true, state: true } } },
    });
    if (!reply) throw new NotFoundException('Sent reply not found');
    if (reply.post.state !== 'QUEUE') {
      throw new BadRequestException('Reply has already been sent — cannot edit');
    }

    // Both writes must commit together: a partial commit would leave the
    // published post content and the stored generation inputData diverged.
    if (data.content !== undefined || data.inputData !== undefined) {
      await this._tx.model.$transaction(async (tx) => {
        if (data.content !== undefined) {
          await tx.post.update({
            where: { id: reply.postId },
            data: { content: data.content },
          });
        }
        if (data.inputData !== undefined) {
          await tx.engageSentReply.update({
            where: { id },
            data: { inputData: data.inputData },
          });
        }
      });
    }

    return this._sentReply.model.engageSentReply.findFirst({
      where: { id },
      include: {
        post: { select: { id: true, content: true, state: true, publishDate: true } },
      },
    });
  }

  async getSentReplyByOpportunity(organizationId: string, opportunityId: string) {
    // Per-post tracking means an opportunity can have multiple replies; return
    // the most recent (used by cancelAndSendNow to find a still-pending reply).
    return this._sentReply.model.engageSentReply.findFirst({
      where: { organizationId, opportunityId },
      orderBy: { createdAt: 'desc' },
      include: { post: { select: { id: true, state: true } } },
    });
  }

  async getSentReplyById(organizationId: string, id: string) {
    const reply = await this._sentReply.model.engageSentReply.findFirst({
      where: { id, organizationId },
      include: { post: true },
    });
    if (!reply) throw new NotFoundException('Sent reply not found');
    return reply;
  }

  async getSentReplyItemById(organizationId: string, id: string) {
    const reply = await this._sentReply.model.engageSentReply.findFirst({
      where: { id, organizationId },
      include: {
        post: {
          select: {
            id: true,
            content: true,
            state: true,
            releaseURL: true,
            publishDate: true,
            impressions: true,
            trafficScore: true,
            analytics: true,
            lastMetricsFetchAt: true,
            settings: true,
            integration: {
              select: {
                id: true,
                name: true,
                providerIdentifier: true,
                picture: true,
                profile: true,
                internalId: true,
              },
            },
          },
        },
        opportunity: {
          select: {
            id: true,
            platform: true,
            externalPostUrl: true,
            postContent: true,
            authorUsername: true,
            authorDisplayName: true,
            authorFollowers: true,
            authorAvatarUrl: true,
            postPublishedAt: true,
          },
        },
      },
    });
    if (!reply) throw new NotFoundException('Sent reply not found');

    // Scope the state lookup to the SAME project this reply was sent under
    // (reply.projectId is the send-time snapshot — the authoritative source
    // here, not a caller-supplied value). findFirst, not findUnique: a
    // nullable projectId can't back a compound-unique lookup.
    const state = await this._oppState.model.engageOpportunityState.findFirst({
      where: {
        organizationId,
        projectId: reply.projectId ?? null,
        opportunityId: reply.opportunity.id,
      },
      select: {
        matchedKeywords: true,
        status: true,
        generationHistory: true,
      },
    });

    const opportunity = {
      ...reply.opportunity,
      status: state?.status ?? null,
      matchedKeywords: state?.matchedKeywords ?? [],
      generationHistory: normalizeGenerationHistory(state?.generationHistory),
    };
    if (!reply.post) return { ...reply, opportunity };

    const { settings, ...postRest } = reply.post;
    return {
      ...reply,
      opportunity,
      post: {
        ...postRest,
        replyAuthor: resolveReplyAuthor(reply.post.integration, settings),
        metrics: normalizeReplyMetrics(
          reply.opportunity.platform,
          reply.post.analytics,
          reply.post.impressions,
          reply.post.trafficScore
        ),
      },
    };
  }

  async updateReplyUrl(
    organizationId: string,
    sentReplyId: string,
    url: string,
    engageAuthor?: EngageAuthorProfile,
    // When markPublished is set (extension publish-on-success path), also flip the
    // post DRAFT→PUBLISHED in the same write. The human manual-paste path leaves it
    // unset: its post is already PUBLISHED (created so by confirmManualReply), so a
    // backfill there only fills the URL.
    opts: { markPublished?: boolean } = {}
  ) {
    // Join the opportunity for its platform: backfill is only meaningful for the
    // manual-reply platforms (X / Reddit), and for X we also derive releaseId
    // from the tweet URL so metrics sync can read it. The caller (service) has
    // already validated the URL matches this platform.
    const reply = await this._sentReply.model.engageSentReply.findFirst({
      where: { id: sentReplyId, organizationId },
      include: { opportunity: { select: { platform: true } } },
    });
    if (!reply) throw new NotFoundException('Sent reply not found');
    const platform = reply.opportunity.platform;
    if (platform !== 'reddit' && platform !== 'x') {
      throw new BadRequestException(
        'Reply-URL backfill is only valid for X or Reddit manual replies'
      );
    }
    const releaseId =
      platform === 'x' ? parseXTweetId(url) ?? undefined : undefined;

    // If this X reply was recorded without a connected account, the freshly
    // supplied URL lets us resolve the author's integration now (handle match)
    // so metrics sync can finally read it. Only fill when currently null —
    // never override an account the user explicitly chose at confirm time.
    let integrationId: string | undefined;
    let mergedSettings: string | undefined;
    if (platform === 'x') {
      const post = await this._post.model.post.findUnique({
        where: { id: reply.postId },
        select: { integrationId: true, settings: true },
      });
      const alreadyLinked = !!post?.integrationId;
      if (!alreadyLinked) {
        integrationId =
          (await this.resolveXReplyIntegrationId(organizationId, url))
            ?.integrationId ?? undefined;
      }
      // Record the actual poster when supplied. The browser extension (Option A)
      // posts as the logged-in X session, which can differ from the selected
      // integration — that real author is ground truth, so store it in settings
      // even when an integration is linked. Without an explicit author we keep the
      // old behavior (integration is the source of truth; settings untouched).
      if (engageAuthor) {
        mergedSettings = this._mergeEngageAuthor(post?.settings, 'x', engageAuthor);
      }
    } else if (platform === 'reddit' && engageAuthor) {
      // Reddit replies never have an integration, so engageAuthor is always the
      // recorded author. Merge into existing settings to preserve the __type tag.
      const post = await this._post.model.post.findUnique({
        where: { id: reply.postId },
        select: { settings: true },
      });
      mergedSettings = this._mergeEngageAuthor(post?.settings, 'reddit', engageAuthor);
    }

    return this._post.model.post.update({
      where: { id: reply.postId },
      data: {
        releaseURL: url,
        ...(releaseId ? { releaseId } : {}),
        ...(integrationId ? { integrationId } : {}),
        ...(mergedSettings ? { settings: mergedSettings } : {}),
        ...(opts.markPublished ? { state: 'PUBLISHED' as const } : {}),
      },
    });
  }

  // Lightweight read for the extension publish-on-success path: enough to decide
  // idempotency (already published?), validate the platform, claim the
  // opportunity, and attribute billing to the post. Returns null when the reply
  // doesn't belong to this org.
  async getSentReplyContext(organizationId: string, sentReplyId: string) {
    const reply = await this._sentReply.model.engageSentReply.findFirst({
      where: { id: sentReplyId, organizationId },
      select: {
        id: true,
        postId: true,
        opportunityId: true,
        post: { select: { state: true, releaseURL: true } },
        opportunity: { select: { platform: true } },
      },
    });
    if (!reply) return null;
    return {
      sentReplyId: reply.id,
      postId: reply.postId,
      opportunityId: reply.opportunityId,
      state: reply.post?.state ?? null,
      releaseURL: reply.post?.releaseURL ?? null,
      platform: reply.opportunity?.platform ?? null,
    };
  }

  /**
   * Patch ONLY settings.engageAuthor for a sent reply's post — the slow,
   * display-only author/avatar enrichment that the confirm + backfill paths now
   * resolve in the background (the URL is saved synchronously; this fills the
   * author once Reddit/X finally answers). Honours the same FALLBACK rule as
   * updateReplyUrl: for X, record engageAuthor ONLY when the post has no connected
   * integration (the integration is the source of truth); for Reddit, always
   * record it. No-ops (returns undefined) when the reply/post is gone or the
   * platform isn't a manual-reply platform — a background enrich must never throw.
   */
  async updateReplyAuthor(
    organizationId: string,
    sentReplyId: string,
    engageAuthor: EngageAuthorProfile
  ) {
    const reply = await this._sentReply.model.engageSentReply.findFirst({
      where: { id: sentReplyId, organizationId },
      include: { opportunity: { select: { platform: true } } },
    });
    if (!reply) return undefined;
    const platform = reply.opportunity.platform;
    if (platform !== 'reddit' && platform !== 'x') return undefined;

    const post = await this._post.model.post.findUnique({
      where: { id: reply.postId },
      select: { integrationId: true, settings: true },
    });
    if (!post) return undefined;
    // X: a connected integration is the source of truth — leave settings untouched.
    if (platform === 'x' && post.integrationId) return undefined;

    const mergedSettings = this._mergeEngageAuthor(post.settings, platform, engageAuthor);
    return this._post.model.post.update({
      where: { id: reply.postId },
      data: { settings: mergedSettings },
    });
  }

  /** Merge engageAuthor into a Post.settings JSON string, preserving __type and any
   *  other keys; tolerant of null/unparseable input. */
  private _mergeEngageAuthor(
    settings: string | null | undefined,
    type: 'x' | 'reddit',
    engageAuthor: EngageAuthorProfile
  ): string {
    let parsed: Record<string, unknown> = { __type: type };
    try {
      parsed = { ...parsed, ...(JSON.parse(settings ?? '{}') ?? {}) };
    } catch {
      /* keep the {__type} default on unparseable settings */
    }
    return JSON.stringify({ ...parsed, engageAuthor });
  }

  // Lightweight status of a single sent reply — for the frontends to poll while
  // an in-browser extension reply posts + self-backfills its permalink. Success
  // is signalled by `replyUrl` (Post.releaseURL) flipping non-null; the Post is
  // already PUBLISHED at creation time, so state alone can't be the signal.
  async getSentReplyStatus(organizationId: string, sentReplyId: string) {
    const reply = await this._sentReply.model.engageSentReply.findFirst({
      where: { id: sentReplyId, organizationId },
      select: { id: true, post: { select: { state: true, releaseURL: true } } },
    });
    if (!reply) throw new NotFoundException('Sent reply not found');
    return {
      id: reply.id,
      state: reply.post?.state ?? null,
      replyUrl: reply.post?.releaseURL ?? null,
    };
  }

  async markAuthorReplied(sentReplyId: string) {
    return this._sentReply.model.engageSentReply.update({
      where: { id: sentReplyId },
      data: { authorReplied: true },
    });
  }

  async findPendingEngageMetrics(orgId?: string, platform?: string) {
    return this._sentReply.model.engageSentReply.findMany({
      where: {
        ...(orgId ? { organizationId: orgId } : {}),
        post: {
          source: 'engage',
          state: 'PUBLISHED',
          releaseURL: { not: null },
          impressions: null,
        },
        ...(platform
          ? { opportunity: { platform } }
          : {}),
      },
      select: {
        id: true,
        organizationId: true,
        authorReplied: true,
        post: { select: { id: true, releaseURL: true, integrationId: true } },
        opportunity: { select: { platform: true, externalPostId: true, authorUsername: true } },
      },
    });
  }

  /**
   * Engage replies whose metrics should be RE-FETCHED on the daily schedule:
   * every PUBLISHED engage reply published within the last `sinceDays` days,
   * REGARDLESS of whether impressions are already set. This is what makes engage
   * metrics keep updating daily (mirroring the calendar DataTicks lookback)
   * instead of freezing after the first non-null fetch (the `findPendingEngageMetrics`
   * path only ever picks `impressions: null` rows, so a synced row never updates).
   * The `impressions > 0` write guard in PostsService keeps a transient empty/0
   * read from clobbering a previously good value.
   */
  async findEngageRepliesInWindow(sinceDays: number, orgId?: string, platform?: string) {
    const cutoff = dayjs.utc().subtract(sinceDays, 'day').startOf('day').toDate();
    return this._sentReply.model.engageSentReply.findMany({
      where: {
        ...(orgId ? { organizationId: orgId } : {}),
        post: {
          source: 'engage',
          state: 'PUBLISHED',
          releaseURL: { not: null },
          publishDate: { gte: cutoff },
        },
        ...(platform
          ? { opportunity: { platform } }
          : {}),
      },
      select: {
        id: true,
        organizationId: true,
        authorReplied: true,
        post: { select: { id: true, releaseURL: true, integrationId: true } },
        opportunity: { select: { platform: true, externalPostId: true, authorUsername: true } },
      },
    });
  }

  /**
   * Event-driven metrics refresh: the replies for an explicit set of post ids
   * (the posts the client is currently looking at on /engage/sent). Returns BOTH
   * the metrics gate fields (publishDate, lastMetricsFetchAt) the caller needs to
   * decide due-ness AND the sync fields (releaseURL, opportunity) syncX/syncReddit
   * need — so a single fetch drives the whole "refresh what the user can see"
   * path. Scoped to this org's PUBLISHED engage replies with a release URL.
   */
  async findEngageRepliesByPostIds(organizationId: string, postIds: string[]) {
    if (postIds.length === 0) return [];
    return this._sentReply.model.engageSentReply.findMany({
      where: {
        organizationId,
        postId: { in: postIds },
        post: {
          source: 'engage',
          state: 'PUBLISHED',
          releaseURL: { not: null },
        },
      },
      select: {
        id: true,
        organizationId: true,
        authorReplied: true,
        post: {
          select: {
            id: true,
            releaseURL: true,
            integrationId: true,
            publishDate: true,
            lastMetricsFetchAt: true,
          },
        },
        opportunity: {
          select: { platform: true, externalPostId: true, authorUsername: true },
        },
      },
    });
  }

  /**
   * Fill Post.integrationId for X engage replies that have none, resolving a
   * usable X account per reply (author-handle → engage reply account → any live
   * account; see resolveXReplyIntegrationId). Without an integration,
   * checkPostAnalytics can't read X metrics. Reddit needs no integration and is
   * left untouched. Returns what was (or, in dryRun, would be) filled.
   */
  async backfillXReplyIntegrations(organizationId: string, dryRun: boolean) {
    const pending = await this._sentReply.model.engageSentReply.findMany({
      where: {
        organizationId,
        opportunity: { platform: 'x' },
        post: { source: 'engage', integrationId: null },
      },
      select: { post: { select: { id: true, releaseURL: true } } },
    });

    let filled = 0;
    let unresolved = 0;
    const items: Array<{ postId: string; integrationId: string; matchedBy: string }> = [];

    for (const r of pending) {
      if (!r.post) continue;
      const pick = await this.resolveXReplyIntegrationId(organizationId, r.post.releaseURL);
      if (!pick) {
        unresolved++;
        continue;
      }
      if (!dryRun) {
        await this._post.model.post.update({
          where: { id: r.post.id },
          data: { integrationId: pick.integrationId },
        });
      }
      filled++;
      items.push({ postId: r.post.id, integrationId: pick.integrationId, matchedBy: pick.matchedBy });
    }

    return { found: pending.length, filled, unresolved, items };
  }

  /**
   * Per-platform snapshot of PUBLISHED engage replies: how many carry metrics,
   * how many are still missing — broken down by WHY (no link yet / no
   * integration / no tweet id / syncable-but-empty) — and the impression/traffic
   * totals. Powers the /admin/sync-metrics before/after summary. Engage replies
   * are few, so one findMany + in-memory fold is fine. Classification is shared
   * with the script via classifyReplyMetric.
   */
  async getEngageMetricsStats(organizationId: string, platform?: string) {
    const rows = await this._sentReply.model.engageSentReply.findMany({
      where: {
        organizationId,
        ...(platform ? { opportunity: { platform } } : {}),
        post: { source: 'engage', state: 'PUBLISHED' },
      },
      select: {
        post: {
          select: {
            impressions: true,
            trafficScore: true,
            integrationId: true,
            releaseURL: true,
            releaseId: true,
          },
        },
        opportunity: { select: { platform: true } },
      },
    });

    const stats: Record<
      string,
      {
        published: number;
        withMetrics: number;
        missing: number;
        // Breakdown of `missing` by blocker:
        missingNoReleaseURL: number; // needs PATCH /sent/:id/reply-url
        missingNoIntegration: number; // X — run integration backfill
        missingNoReleaseId: number; // X — URL has no /status/<id>
        missingSyncable: number; // ready, but fetch returned nothing (tier/WAF)
        totalImpressions: number;
        totalTrafficScore: number;
      }
    > = {};

    for (const r of rows) {
      const p = r.opportunity.platform;
      const s = (stats[p] ??= {
        published: 0,
        withMetrics: 0,
        missing: 0,
        missingNoReleaseURL: 0,
        missingNoIntegration: 0,
        missingNoReleaseId: 0,
        missingSyncable: 0,
        totalImpressions: 0,
        totalTrafficScore: 0,
      });
      s.published++;
      const status = classifyReplyMetric({
        platform: p,
        impressions: r.post?.impressions,
        releaseURL: r.post?.releaseURL,
        releaseId: r.post?.releaseId,
        integrationId: r.post?.integrationId,
      });
      if (status === 'has_metrics') {
        s.withMetrics++;
        s.totalImpressions += r.post?.impressions ?? 0;
        s.totalTrafficScore += r.post?.trafficScore ?? 0;
      } else {
        s.missing++;
        if (status === 'no_release_url') s.missingNoReleaseURL++;
        else if (status === 'no_integration') s.missingNoIntegration++;
        else if (status === 'no_release_id') s.missingNoReleaseId++;
        else s.missingSyncable++;
      }
    }
    for (const s of Object.values(stats)) s.totalTrafficScore = Math.round(s.totalTrafficScore);
    return stats;
  }

  async updatePostMetrics(
    postId: string,
    impressions: number,
    analytics: unknown,
    trafficScore?: number
  ) {
    return this._post.model.post.update({
      where: { id: postId },
      data: {
        impressions,
        analytics: analytics as never,
        ...(trafficScore !== undefined && { trafficScore }),
      },
    });
  }

  async createManualRedditPost(data: {
    organizationId: string;
    content: string;
    date: Date;
    replyUrl?: string;
    engageAuthor?: EngageAuthorProfile;
    projectId?: string | null;
  }) {
    const { randomUUID } = await import('crypto');
    return this._post.model.post.create({
      data: {
        organizationId: data.organizationId,
        content: data.content,
        publishDate: data.date,
        state: 'PUBLISHED',
        source: 'engage',
        image: '[]',
        // Reddit manual posts never have an integration, so engageAuthor (the
        // redditor who posted the reply) is the source of truth when known.
        settings: JSON.stringify({
          __type: 'reddit',
          ...(data.engageAuthor ? { engageAuthor: data.engageAuthor } : {}),
        }),
        group: randomUUID(),
        delay: 0,
        ...(data.replyUrl ? { releaseURL: data.replyUrl } : {}),
        // Project attribution, so the manual reply's Post row is filtered/counted
        // by project like every other engage post (matches the EngageSentReply
        // row's projectId written by confirmManualReply).
        ...(data.projectId ? { projectId: data.projectId } : {}),
        // integrationId intentionally omitted: Reddit manual posts have no integration
      },
    });
  }

  /**
   * Pick the connected X integration that AUTHORED a manual engage reply: the live
   * X account whose handle matches the reply URL's author. Returns null when no
   * connected account authored the reply (external account / unparseable handle) —
   * see resolve-x-reply-integration.ts for why we no longer attach a fallback.
   */
  async resolveXReplyIntegrationId(
    organizationId: string,
    replyUrl?: string | null,
    projectId: string | null = null
  ): Promise<XReplyResolution | null> {
    const liveX = await this._integration.model.integration.findMany({
      where: {
        organizationId,
        providerIdentifier: 'x',
        deletedAt: null,
        disabled: false,
      },
      select: {
        id: true,
        profile: true,
        // Plural now — see listXIntegrationsWithReplySettings's note (a
        // global UNIQUE(integrationId) no longer exists). Scoped to THIS
        // project's config so at most one row comes back per integration.
        engageXReplyAccounts: {
          where: { config: { organizationId, projectId } },
          select: { engageEnabled: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return pickXReplyIntegration(
      liveX.map((i) => ({
        id: i.id,
        profile: i.profile,
        engageEnabled: i.engageXReplyAccounts[0]?.engageEnabled ?? false,
      })),
      replyUrl
    );
  }

  async createManualXPost(data: {
    organizationId: string;
    content: string;
    date: Date;
    replyUrl?: string;
    integrationId?: string;
    engageAuthor?: EngageAuthorProfile;
    projectId?: string | null;
  }) {
    // The integration is optional. When provided, its OAuth token lets
    // checkPostAnalytics read the reply tweet's impressions/bookmarks. When
    // omitted (user replied manually without connecting an X account), the post
    // is still recorded but the per-account metrics sync is skipped — only the
    // app-only bearer can later read public metrics (likes/replies/retweets/
    // quotes), and the author-replied check still runs.
    let integrationId = data.integrationId;
    if (integrationId) {
      // Validate the integration belongs to this org and is an X social account.
      const integration = await this._integration.model.integration.findFirst({
        where: {
          id: integrationId,
          organizationId: data.organizationId,
          providerIdentifier: 'x',
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!integration) {
        throw new NotFoundException('X integration not found for this organization');
      }
    } else {
      // No account picked: resolve one so metrics aren't stuck null forever.
      // Prefer the tweet author's own integration (by handle) so impressions are
      // readable; else the org's engage reply account; else any live X account.
      integrationId =
        (await this.resolveXReplyIntegrationId(data.organizationId, data.replyUrl))
          ?.integrationId ?? undefined;
    }

    // Parse the snowflake tweet id from the pasted reply URL into releaseId.
    // checkPostAnalytics early-returns when releaseId is null, so without this
    // the metrics sync can never fetch impressions/likes/retweets/etc. When the
    // reply URL is omitted ("I'll add the link later"), both are left null and
    // backfilled later via updateReplyUrl.
    const releaseId = parseXTweetId(data.replyUrl);

    const { randomUUID } = await import('crypto');
    return this._post.model.post.create({
      data: {
        organizationId: data.organizationId,
        content: data.content,
        publishDate: data.date,
        state: 'PUBLISHED',
        source: 'engage',
        image: '[]',
        settings: JSON.stringify({
          __type: 'x',
          // engageAuthor is only a FALLBACK identity for when no connected account
          // authored the reply. When integrationId is set it IS the source of truth
          // for who replied, so we don't duplicate the author into settings.
          ...(!integrationId && data.engageAuthor
            ? { engageAuthor: data.engageAuthor }
            : {}),
        }),
        group: randomUUID(),
        delay: 0,
        ...(data.replyUrl ? { releaseURL: data.replyUrl } : {}),
        ...(releaseId ? { releaseId } : {}),
        // Project attribution — see createManualRedditPost's note.
        ...(data.projectId ? { projectId: data.projectId } : {}),
        // Scalar FK (not a `connect` relation) to stay in Prisma's unchecked
        // create form alongside organizationId; ownership is validated/resolved
        // above. Left null when no connected account authored the reply — the
        // author is captured in settings.engageAuthor instead.
        ...(integrationId ? { integrationId } : {}),
      },
    });
  }

  // ─── Setup (atomic bulk init) ─────────────────────────────────────────────

  async setupEngage(
    organizationId: string,
    dto: SetupEngageDto,
    projectId: string | null = null
  ) {
    return this._tx.model.$transaction(async (tx) => {
      const config =
        projectId != null
          ? await tx.engageConfig.upsert({
              where: { organizationId_projectId: { organizationId, projectId } },
              create: { organizationId, projectId, enabled: true },
              update: { enabled: true },
            })
          : // Legacy null-project row — see getOrCreateConfig's note (nullable
            // column can't back a compound-unique upsert).
            await (async () => {
              const existing = await tx.engageConfig.findFirst({
                where: { organizationId, projectId: null },
              });
              return existing
                ? tx.engageConfig.update({
                    where: { id: existing.id },
                    data: { enabled: true },
                  })
                : tx.engageConfig.create({
                    data: { organizationId, projectId: null, enabled: true },
                  });
            })();

      if (dto.keywords?.length) {
        await tx.engageKeyword.createMany({
          data: dto.keywords.map((kw) => ({
            configId: config.id,
            organizationId,
            keyword: kw.keyword,
            type: kw.type ?? null,
            enabled: kw.enabled ?? true,
          })),
          skipDuplicates: true,
        });
        const enabledKeywords = await tx.engageKeyword.findMany({
          where: {
            configId: config.id,
            organizationId,
            enabled: true,
            keyword: { in: dto.keywords.map((kw) => kw.keyword) },
          },
          select: { id: true, keyword: true },
        });
        if (enabledKeywords.length) {
          await tx.engageKeywordInitialScan.createMany({
            data: enabledKeywords.flatMap((kw) =>
              INITIAL_SCAN_PLATFORMS.map((platform) => ({
                organizationId,
                keywordId: kw.id,
                keyword: kw.keyword,
                platform,
                status: 'PENDING',
              }))
            ),
            skipDuplicates: true,
          });
        }
      }

      if (dto.monitoredChannels?.length) {
        await tx.engageMonitoredChannel.createMany({
          data: dto.monitoredChannels.map((ch) => ({
            configId: config.id,
            organizationId,
            platform: ch.platform,
            channelId: ch.channelId,
            channelName: ch.channelName,
            audienceSize: ch.audienceSize ?? 0,
            ...(ch.metadata && { metadata: ch.metadata as Prisma.InputJsonValue }),
          })),
          skipDuplicates: true,
        });
      }

      if (dto.trackedAccounts?.length) {
        await tx.engageTrackedAccount.createMany({
          data: dto.trackedAccounts.map((acc) => ({
            configId: config.id,
            organizationId,
            platform: acc.platform ?? 'x',
            username: acc.username,
            ...(acc.picture && { picture: acc.picture }),
            ...(acc.categoryLabel && { categoryLabel: acc.categoryLabel }),
          })),
          skipDuplicates: true,
        });
      }

      return config;
    });
  }

  // ─── Admin diagnostics ───────────────────────────────────────────────────

  async findStuckScanCursors(before: Date) {
    return this._scanCursor.model.engageScanCursor.findMany({
      where: {
        status: 'SCANNING',
        lastScanStartedAt: { lt: before },
      },
      select: {
        id: true,
        platform: true,
        scanType: true,
        scanKey: true,
        lastScanStartedAt: true,
        lastScannedAt: true,
      },
      orderBy: { lastScanStartedAt: 'asc' },
    });
  }

  async findFailedKeywordScans(stuckBefore: Date) {
    return this._keywordInitialScan.model.engageKeywordInitialScan.findMany({
      where: {
        OR: [
          { status: 'FAILED' },
          { status: 'RUNNING', startedAt: { lt: stuckBefore } },
        ],
      },
      select: {
        id: true,
        organizationId: true,
        keyword: true,
        platform: true,
        status: true,
        startedAt: true,
        attempts: true,
        error: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findDeadReplyAccounts() {
    return this._replyAccount.model.engageXReplyAccount.findMany({
      where: {
        engageEnabled: true,
        integration: {
          OR: [{ refreshNeeded: true }, { disabled: true }],
        },
      },
      select: {
        id: true,
        organizationId: true,
        integrationId: true,
        autoReplyEnabled: true,
        integration: {
          select: {
            id: true,
            name: true,
            providerIdentifier: true,
            refreshNeeded: true,
            disabled: true,
          },
        },
      },
      orderBy: { organizationId: 'asc' },
    });
  }

  async findEngageReplyErrors(since: Date) {
    return this._sentReply.model.engageSentReply.findMany({
      where: {
        post: { state: 'ERROR', createdAt: { gte: since } },
      },
      select: {
        id: true,
        organizationId: true,
        opportunityId: true,
        postId: true,
        createdAt: true,
        post: { select: { id: true, state: true, error: true, createdAt: true } },
        opportunity: { select: { externalPostUrl: true, platform: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async _getConfigId(
    organizationId: string,
    projectId: string | null = null
  ): Promise<string> {
    const config = await this._config.model.engageConfig.findFirst({
      where: { organizationId, projectId },
    });
    if (!config)
      throw new NotFoundException(
        'EngageConfig not found — call GET /engage/config first'
      );
    return config.id;
  }

}

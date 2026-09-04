import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  EngageOpportunity,
  EngageOpportunityStatus,
  State,
} from '@prisma/client';
import {
  PrismaRepository,
  PrismaTransaction,
  PrismaService,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  AddKeywordDto,
  AddKeywordsBulkDto,
  AddMonitoredChannelDto,
  AddTrackedAccountDto,
  ListOpportunitiesDto,
  ListSentDto,
  LocateOpportunityDto,
  LocateSentReplyDto,
  OpportunityCountsSummaryDto,
  SentCountsSummaryDto,
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
  buildScanTargetKey,
  CHANNEL_SCOPE_PLATFORMS,
  partitionScanTargets,
  scanKeyFor,
  scanTypeFor,
  toChannelShape,
} from '@gitroom/nestjs-libraries/engage/engage-scan-target';
import { SCANNABLE_PLATFORMS } from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';
import {
  pickXReplyIntegration,
  XReplyResolution,
} from '@gitroom/nestjs-libraries/engage/resolve-x-reply-integration';
import { markEngageScanWork } from '@gitroom/nestjs-libraries/engage/engage-scan-hint';
import {
  EngageConfigMetadataPatch,
  isRepliesActive,
  mergeEngageConfigMetadata,
  readEngageConfigMetadata,
} from '@gitroom/nestjs-libraries/engage/engage-config-metadata';
import {
  isEmptyRedditCapability,
  mergeRedditCapability,
  readRedditCapability,
  RedditChannelCapability,
} from '@gitroom/nestjs-libraries/engage/reddit-channel-capability';
import {
  classifyReplyMetric,
  normalizeReplyMetrics,
} from '@gitroom/nestjs-libraries/engage/engage-metrics-stats';
import { parseXTweetId } from '@gitroom/nestjs-libraries/engage/x-tweet';
import { normalizeExternalPostUrl } from '@gitroom/nestjs-libraries/engage/engage-scan-ingest.service';
import { EngageAuthorProfile } from '@gitroom/nestjs-libraries/engage/engage-author';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import utc from 'dayjs/plugin/utc';

dayjs.extend(isoWeek);
dayjs.extend(utc);

/**
 * The later of two optional timestamps, or null when neither exists.
 *
 * Small on purpose: it keeps the reply-pacing clock defined in ONE place, read
 * identically by the gate that hands replies out and by the countdown the user
 * sees. Those two disagreeing is precisely the bug it was introduced for — the
 * UI reporting hours remaining while a reply went out every five minutes.
 */
function laterOf(
  a?: Date | null,
  b?: Date | null
): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

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

// Platforms broken out by the opportunity-count endpoints' `byPlatform`
// rollup. `platform` lives on the joined EngageOpportunity, which Prisma's
// groupBy can't traverse — one scoped count per platform stands in for a
// group-by (same pattern as getSentStats/getSentCounts).
const OPPORTUNITY_COUNT_PLATFORMS = [
  'x',
  'reddit',
  'linkedin',
  'medium',
  'devto',
  'hackernews',
  'quora',
] as const;

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
function deriveNext(
  row: ScanCursorTiming,
  cadenceMs: number,
  now: number
): number {
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
 * A one-line label for an opportunity in the dashboard highlights: its own
 * title where the platform has one, else the opening of the body. Rows stored
 * before the title column existed have a null title and a postContent that
 * still begins with the title, so the fallback stays right for them too.
 */
function highlightTitle(o: {
  title?: string | null;
  postContent: string;
}): string {
  const title = (o.title ?? '').trim();
  return (title || o.postContent).slice(0, 80);
}

/**
 * The direct media URLs (photos / videos) archived on an opportunity's rawData.
 *
 * A post's body never contains them: X substitutes a t.co placeholder for an
 * attachment, which the scanner strips from postContent because x.com renders
 * it as an image rather than as text. The real URLs are archived on rawData at
 * ingest, and this is the ONLY part of rawData a client ever receives — the
 * blob itself stays unexposed (the server-side X adapter stores a whole tweet
 * payload in there, which would bloat every list response).
 *
 * Always an array: a row with no attachment, a row ingested before this field
 * existed, and a row whose rawData holds an unrelated payload all yield [].
 */
export function opportunityMediaUrls(rawData: unknown): string[] {
  const urls = (rawData as { mediaUrls?: unknown } | null)?.mediaUrls;
  if (!Array.isArray(urls)) return [];
  return urls.filter((u): u is string => typeof u === 'string' && !!u.trim());
}

/**
 * Whether an opportunity's postContent is something other than a plain post
 * body — currently only X's long-form Article. X's SearchTimeline mixes an
 * Article into ordinary tweet results with no separate entry shape (a tweet
 * node with an extra `article` field), so the extension marks it on rawData
 * at ingest instead; without this a client would treat the article's preview
 * text as if it were the whole tweet.
 *
 * null for every other row, including a plain tweet and one ingested before
 * this field existed — same "absent means normal" contract as
 * opportunityMediaUrls' [].
 */
export function opportunityContentType(rawData: unknown): 'article' | null {
  const type = (rawData as { postContentType?: unknown } | null)
    ?.postContentType;
  return type === 'article' ? 'article' : null;
}

/**
 * Rewrite ONLY `__type` in a Post.settings JSON blob, preserving every other key
 * it carries — `engageAuthor` above all, which the publish paths merge in after
 * the fact and which a blind overwrite would silently drop.
 *
 * Null/unparseable/non-object input yields a fresh `{__type}`: there was nothing
 * readable to keep, and the discriminator has to be there.
 */
function mergeSettingsType(
  settings: string | null | undefined,
  type: string
): string {
  let parsed: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(settings ?? '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    /* unparseable settings: fall through to a fresh object */
  }
  return JSON.stringify({ ...parsed, __type: type });
}

/**
 * Pull the reply author (engageAuthor) out of a Post.settings JSON blob. Returns
 * null when settings is absent/unparseable or carries no engageAuthor.
 */
function parseEngageAuthor(
  settings: string | null
): EngageAuthorProfile | null {
  if (!settings) return null;
  try {
    const parsed = JSON.parse(settings) as {
      engageAuthor?: EngageAuthorProfile;
    };
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
    | {
        profile: string | null;
        internalId: string | null;
        name: string | null;
        picture: string | null;
      }
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

/**
 * Lease window used when a caller has no pacing config to hand — currently only
 * `_deleteDraftsForOpportunity`, deciding whether a queued reply is still held
 * by a browser. Mirrors `DEFAULT_REPLY_PACING.claimLeaseMinutes`; duplicated
 * rather than imported because the repository must not depend on the driver.
 */
const DEFAULT_CLAIM_LEASE_MINUTES = 30;

@Injectable()
export class EngageRepository {
  private readonly _logger = new Logger(EngageRepository.name);

  constructor(
    private _config: PrismaRepository<'engageConfig'>,
    private _keyword: PrismaRepository<'engageKeyword'>,
    private _trackedAccount: PrismaRepository<'engageTrackedAccount'>,
    private _opportunity: PrismaRepository<'engageOpportunity'>,
    private _oppState: PrismaRepository<'engageOpportunityState'>,
    private _sentReply: PrismaRepository<'engageSentReply'>,
    private _integration: PrismaRepository<'integration'>,
    private _integrationProject: PrismaRepository<'integrationProject'>,
    private _post: PrismaRepository<'post'>,
    private _tx: PrismaTransaction,
    private _scanCursor: PrismaRepository<'engageScanCursor'>,
    private _keywordInitialScan: PrismaRepository<'engageKeywordInitialScan'>,
    // The engage_reply ledger. Needed by the broken-address triage below: it is
    // the only signal that survives for legacy paid generations, whose
    // EngageOpportunityState.generationHistory is SQL NULL.
    private _billingRecord: PrismaRepository<'billingRecord'>
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

  /**
   * Render a config's single `trackedAccounts` relation as the two lists every
   * caller still consumes. The scan-target tables were merged, but the config
   * contract (and the frontend/extension reading it) keeps both keys — see
   * engage-scan-target.ts.
   */
  private _withScanTargetShape<
    T extends { trackedAccounts: Parameters<typeof partitionScanTargets>[0] }
  >(config: T) {
    return { ...config, ...partitionScanTargets(config.trackedAccounts) };
  }

  async getOrCreateConfig(
    organizationId: string,
    projectId: string | null = null
  ) {
    const include = {
      keywords: {
        orderBy: { createdAt: 'asc' as const },
        include: { initialScans: { orderBy: { platform: 'asc' as const } } },
      },
      // ONE relation now holds both scopes; _withScanTargetShape splits it back
      // into monitoredChannels/trackedAccounts for every consumer of this method.
      trackedAccounts: { orderBy: { createdAt: 'asc' as const } },
    };

    if (projectId != null) {
      // Atomic upsert: two concurrent first-call requests would otherwise both
      // miss findFirst and race on create → Prisma P2002 unique violation.
      return this._withScanTargetShape(
        await this._config.model.engageConfig.upsert({
          where: { organizationId_projectId: { organizationId, projectId } },
          create: { organizationId, projectId, enabled: false },
          update: {},
          include,
        })
      );
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
    if (existing) return this._withScanTargetShape(existing);
    return this._withScanTargetShape(
      await this._config.model.engageConfig.create({
        data: { organizationId, projectId: null, enabled: false },
        include,
      })
    );
  }

  /**
   * Org-level aggregate config for clients that have no project context — the
   * browser extension's scan panel, which enumerates keywords/channels/tracked
   * accounts client-side to render the selectable scan units. It must see the
   * SAME org-wide set the server-side scan loop (claimNext) enumerates, or the
   * extension's units diverge from what actually gets scanned.
   *
   * The null-project row supplies the scalar/entitlement/replyAccounts shape
   * (so the response is shape-identical to getConfig(projectId)); the three
   * relation lists are then REPLACED with the union across every ENABLED
   * project-scoped config, deduped by the same global unit identity the scan
   * loop keys on (normalized keyword / platform+normalized target key). The
   * dedup runs over the MERGED scan-target rows and is split into the
   * channel/tracked response lists afterwards, so a subreddit and an account can
   * never collide in one map. The legacy null-project row is EXCLUDED — its
   * keywords/channels/tracked accounts are pre-project data that must no longer
   * be scanned; only its scalar shape is reused as the base. Disabled configs
   * are excluded — consistent with claimNext, which only scans enabled configs.
   * Duplicates prefer an enabled row so a keyword enabled under any project
   * surfaces as enabled.
   */
  async getOrgAggregateConfig(organizationId: string) {
    const include = {
      keywords: {
        orderBy: { createdAt: 'asc' as const },
        include: { initialScans: { orderBy: { platform: 'asc' as const } } },
      },
      trackedAccounts: { orderBy: { createdAt: 'asc' as const } },
    };
    const [base, configs, automationRows] = await Promise.all([
      this.getOrCreateConfig(organizationId, null),
      this._config.model.engageConfig.findMany({
        where: { organizationId, enabled: true, projectId: { not: null } },
        include,
      }),
      // Unfiltered by `enabled` (the Engage scan switch), unlike `configs`
      // above: a project whose Automation master switch is on for scheduled
      // publishing alone never flips scanning on (saveReplies is the only
      // writer that does, per docs/automation-api.md's switch chain), so it
      // would be invisible to the query above despite genuinely having
      // automation running. This is the only field read off these rows.
      this._config.model.engageConfig.findMany({
        where: { organizationId, projectId: { not: null } },
        select: { metadata: true },
      }),
    ]);

    const pickEnabled = <T extends { enabled: boolean }>(
      map: Map<string, T>,
      key: string,
      row: T
    ) => {
      const prev = map.get(key);
      if (!prev || (!prev.enabled && row.enabled)) map.set(key, row);
    };

    const kwByKey = new Map<string, (typeof base.keywords)[number]>();
    const targetByKey = new Map<
      string,
      (typeof configs)[number]['trackedAccounts'][number]
    >();
    for (const c of configs) {
      for (const kw of c.keywords) {
        const key = normalizeKeyword(kw.keyword);
        if (key) pickEnabled(kwByKey, key, kw);
      }
      for (const t of c.trackedAccounts) {
        pickEnabled(
          targetByKey,
          `${t.platform}:${normalizeUsername(t.platform ?? 'x', t.username)}`,
          t
        );
      }
    }
    const targets = partitionScanTargets([...targetByKey.values()]);

    return {
      ...base,
      keywords: [...kwByKey.values()],
      monitoredChannels: targets.monitoredChannels,
      trackedAccounts: targets.trackedAccounts,
      // OR across every real project: this org-wide view has no single
      // project to report a scoped switch for, so "is anything automated"
      // is the only question it can answer. Read by getConfig() in place of
      // the null-project base row's own (always-off) metadata.
      automationEnabled: automationRows.some(
        (row) => readEngageConfigMetadata(row as any).automationEnabled
      ),
    };
  }

  async getAllEnabledOrgContexts() {
    const configs = await this._config.model.engageConfig.findMany({
      where: { enabled: true, projectId: { not: null } },
      include: {
        keywords: {
          where: { enabled: true },
          orderBy: { createdAt: 'asc' },
        },
        trackedAccounts: {
          where: { enabled: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return configs.map((c) => this._withScanTargetShape(c));
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
  async getEnabledOrgContext(
    organizationId: string,
    projectId: string | null = null
  ) {
    const config = await this._config.model.engageConfig.findFirst({
      where: { organizationId, projectId, enabled: true },
      include: {
        keywords: { where: { enabled: true }, orderBy: { createdAt: 'asc' } },
        trackedAccounts: {
          where: { enabled: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return config && this._withScanTargetShape(config);
  }

  /**
   * Every enabled PROJECT-SCOPED engage config for an org. The browser-extension
   * scan loop enumerates units from all of them so that keywords/channels/tracked
   * accounts activated on a project's config (e.g. when an operation plan is
   * committed) are actually scanned. The legacy null-project row is EXCLUDED — it
   * holds pre-project data that must no longer be scanned; new configs always
   * carry a projectId.
   *
   * Scan units are GLOBAL (identified by platform/scanType/scanKey), so the
   * caller dedups units that repeat across projects; fan-out at ingest time is
   * unaffected because getOrgContextsForUnit resolves subscribers per unit.
   */
  async getEnabledConfigsForOrg(organizationId: string) {
    const configs = await this._config.model.engageConfig.findMany({
      where: { organizationId, enabled: true, projectId: { not: null } },
      include: {
        keywords: { where: { enabled: true }, orderBy: { createdAt: 'asc' } },
        trackedAccounts: {
          where: { enabled: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return configs.map((c) => this._withScanTargetShape(c));
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
        id: true,
        platform: true,
        externalPostId: true,
        externalPostUrl: true,
        channelId: true,
        channelName: true,
        channelFollowers: true,
        authorUsername: true,
        authorDisplayName: true,
        authorFollowers: true,
        authorAvatarUrl: true,
        title: true,
        postContent: true,
        postPublishedAt: true,
        metricLikes: true,
        metricReplies: true,
        metricRetweets: true,
        metricQuotes: true,
        metricBookmarks: true,
        metricViews: true,
        metricShares: true,
        metricSaves: true,
        metricScore: true,
        metricUpvoteRatio: true,
        metricComments: true,
      },
    });
  }

  /** Resolve a SCANNING scan cursor by its lease token (the extension's taskId).
   * Returns the unit identity needed to fan out; null when the token is
   * invalid/expired/rotated. */
  async findScanCursorByToken(leaseToken: string, orgId: string) {
    return this._scanCursor.model.engageScanCursor.findFirst({
      // Scoped to the claiming org: the token is a bearer credential, so
      // matching it alone would let any holder complete a lease it never took.
      where: { leaseToken, status: 'SCANNING', claimedByOrgId: orgId },
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
   *
   * The legacy null-project config is EXCLUDED from fan-out — even if it still
   * subscribes to a global unit, its pre-project keywords/channels/tracked
   * accounts must no longer receive persisted opportunities. Only project-scoped
   * configs subscribe.
   */
  async getOrgContextsForUnit(
    platform: string,
    scanType: 'keyword' | 'channel' | 'tracked',
    scanKey: string
  ) {
    const include = {
      keywords: {
        where: { enabled: true },
        orderBy: { createdAt: 'asc' as const },
      },
      trackedAccounts: {
        where: { enabled: true },
        orderBy: { createdAt: 'asc' as const },
      },
    };

    // 'channel' and 'tracked' now resolve against the SAME table — the scope is
    // implied by `platform` (scanTypeFor), so a unit whose scanType contradicts
    // its platform (an x 'channel', a reddit 'tracked') matches nothing instead
    // of silently resolving subscribers for a scan no scanner can serve.
    if (scanType !== 'keyword') {
      if (scanTypeFor(platform) !== scanType) return [];
      const configs = await this._config.model.engageConfig.findMany({
        where: {
          enabled: true,
          projectId: { not: null },
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

      // The keyword branch below re-filters in code as belt-and-braces for rows
      // written before normalisation existed. That trick does NOT transfer here:
      // a legacy target key differs from its unit key by a leading '@' or 'u/',
      // not just case, so `equals … insensitive` never returns the config in the
      // first place and no in-code filter could recover it. The invariant that
      // `username` IS the canonical scan key is established by DATA instead —
      // migration STEP 2c canonicalises every pre-existing row, and every write
      // since goes through buildScanTargetKey.
      //
      // What this check adds is a SIGNAL. If a config matched the SQL predicate
      // but holds no row whose canonical key equals the unit key, the row is
      // un-migrated: the unit gets scanned, paid for, and fans out to nobody.
      // Silent before; now it names the org and the key so STEP 2c can be run.
      for (const c of configs) {
        const canonical = c.trackedAccounts.some(
          (t) => t.enabled && scanKeyFor(t) === scanKey
        );
        if (!canonical) {
          this._logger.warn(
            `[engage] org=${c.organizationId} matched unit ${platform}/${scanType}/${scanKey} ` +
              `only case-insensitively — its scan target holds a non-canonical key. ` +
              `Run migration STEP 2c; until then this unit produces no opportunities for that org.`
          );
        }
      }

      return configs.map((c) => this._withScanTargetShape(c));
    }

    const configs = await this._config.model.engageConfig.findMany({
      where: {
        enabled: true,
        projectId: { not: null },
        keywords: {
          some: {
            enabled: true,
            keyword: { equals: scanKey, mode: 'insensitive' },
          },
        },
      },
      include,
    });
    return configs
      .filter((c) =>
        c.keywords.some(
          (k) => k.enabled && normalizeKeyword(k.keyword) === scanKey
        )
      )
      .map((c) => this._withScanTargetShape(c));
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

  /**
   * The bare config row for a project — no entitlement lookup, no scan cursors,
   * none of the decoration `EngageService.getConfig` adds. Automation reads
   * only these three fields, and paying for the full config (dozens of cursor
   * queries) to learn whether replies are on would make the page's one
   * aggregate call slower than the five it replaced.
   *
   * Read-only on purpose: unlike getOrCreateConfig this never inserts, so
   * loading a page cannot create an EngageConfig row for a project that has
   * never used Engage.
   */
  getConfigCore(organizationId: string, projectId: string) {
    return this._config.model.engageConfig.findFirst({
      where: { organizationId, projectId },
      select: { id: true, enabled: true, metadata: true },
    });
  }

  /**
   * Write the config row.
   *
   * `metadata` is a PATCH, not a replacement: it is folded onto whatever the row
   * currently resolves to and stored whole, so the blob is always self-describing
   * rather than a sparse diff readers would have to reassemble.
   *
   * Read-then-write rather than a JSON merge in SQL, because the merge has to
   * apply the same defaults and validation as every read — two concurrent saves
   * to the SAME project are a UI impossibility (one page, one form), while two
   * different settings ending up in disagreeing shapes would not be.
   */
  async saveConfig(
    organizationId: string,
    data: Partial<{
      enabled: boolean;
      lastScanAt: Date;
      metadata: EngageConfigMetadataPatch;
    }>,
    projectId: string | null = null
  ) {
    const { metadata: patch, ...columns } = data;
    const resolveMetadata = async () => {
      if (!patch) return undefined;
      const current = await this._config.model.engageConfig.findFirst({
        where:
          projectId != null
            ? { organizationId, projectId }
            : { organizationId, projectId: null },
        select: { metadata: true },
      });
      return mergeEngageConfigMetadata(current, patch) as unknown as Prisma.InputJsonValue;
    };
    const metadata = await resolveMetadata();
    const payload = {
      ...columns,
      ...(metadata !== undefined ? { metadata } : {}),
    };

    if (projectId != null) {
      return this._config.model.engageConfig.upsert({
        where: { organizationId_projectId: { organizationId, projectId } },
        create: { organizationId, projectId, ...payload },
        update: payload,
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
        data: payload,
      });
    }
    return this._config.model.engageConfig.create({
      data: { organizationId, projectId: null, ...payload },
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

    const [targets, keywords] = await Promise.all([
      this._trackedAccount.model.engageTrackedAccount.findMany({
        where: { organizationId, enabled: true },
        select: { platform: true, username: true },
      }),
      this._keyword.model.engageKeyword.findMany({
        where: { organizationId, enabled: true },
        select: { keyword: true },
      }),
    ]);
    // One table, two scopes: `platform` decides which cursor namespace a target
    // belongs to. Both sides key by the NORMALIZED value (matching the writer +
    // extension), so look up cursors by those keys.
    const subredditIds = targets
      .filter((t) => scanTypeFor(t.platform) === 'channel')
      .map(scanKeyFor);
    const usernames = targets
      .filter((t) => scanTypeFor(t.platform) === 'tracked')
      .map(scanKeyFor);
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

    // The two top-level fields aggregate in OPPOSITE directions — `lastScanAt`
    // is the most recent scan of any track, `nextScanAt` the soonest due of any
    // track — so they describe different tracks and can invert: a healthy
    // keyword scan finishing at 10:00 next to a tracked cursor that has been
    // overdue since July reads as "last scan 10:00, next scan in July".
    //
    // `deriveNext` deliberately returns times in the past (an overdue cursor is
    // due NOW, and the per-track fields below keep that meaning — the extension
    // reads `nextScanAt <= now` exactly that way). What must not leak out is a
    // top-level pair that contradicts itself, so the aggregate is floored at
    // `now`: "the soonest anything is due, and never earlier than this moment".
    const earliestNext = minDate([
      keyword.nextScanAt,
      channel.nextScanAt,
      trackedAgg.nextScanAt,
    ]);
    return {
      lastScanAt: maxDate([
        keyword.lastScanAt,
        channel.lastScanAt,
        trackedAgg.lastScanAt,
      ]),
      nextScanAt: earliestNext
        ? new Date(Math.max(earliestNext.getTime(), now))
        : null,
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
      {
        platform: string;
        lastScannedAt: Date | null;
        nextScanAt: Date | null;
      }[]
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
      {
        platform: string;
        lastScannedAt: Date | null;
        nextScanAt: Date | null;
      }[]
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
   * EngageTrackedAccount.lastCheckedAt bookkeeping field, which only the
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
    return this._getTargetCursors(
      'channel',
      channels.map((c) => ({ platform: c.platform, key: c.channelId })),
      cadenceMs,
      now
    );
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
    return this._getTargetCursors(
      'tracked',
      accounts.map((a) => ({ platform: a.platform, key: a.username })),
      cadenceMs,
      now
    );
  }

  /**
   * Shared body of getChannelCursors/getTrackedCursors — identical since the
   * scan-target tables merged; only the cursor namespace differs. Looks cursors
   * up by the NORMALIZED key, then re-keys the result by the caller's ORIGINAL
   * `${platform}:${key}` so no caller needs a normaliser of its own.
   */
  private async _getTargetCursors(
    scanType: 'channel' | 'tracked',
    targets: { platform: string; key: string }[],
    cadenceMs: number,
    now: number
  ): Promise<
    Record<string, { lastScannedAt: Date | null; nextScanAt: Date | null }>
  > {
    if (!targets.length) return {};
    const norm = (t: { platform: string; key: string }) =>
      normalizeUsername(t.platform ?? 'x', t.key);
    const keys = Array.from(new Set(targets.map(norm)));
    const rows = await this._scanCursor.model.engageScanCursor.findMany({
      where: { scanType, scanKey: { in: keys } },
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
    for (const t of targets) {
      const platform = t.platform ?? 'x';
      const hit = byNorm.get(`${platform}:${norm(t)}`);
      if (hit) out[`${platform}:${t.key}`] = hit;
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
    const created = await this._createOrConflict(
      `Keyword "${dto.keyword}"`,
      () =>
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
    // A new enabled keyword has no scan cursor yet, so it is due the instant
    // anyone asks. Raise the fast-lane hint so the extension picks it up on its
    // 1-min probe instead of waiting out the 15-min backstop alarm. Placed here
    // rather than in the caller so both the manual add and operation-plan
    // generation (resolveOrCreateKeywordIds) are covered; setupEngage builds
    // its rows inside a transaction and marks separately, after the commit.
    if (dto.enabled ?? true) await markEngageScanWork(organizationId);
    return created;
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
    // Same fast-lane hint as addKeyword — this path bypasses it (createMany, so
    // the per-row helper never runs), but the new keywords are just as due.
    // Gate on an ENABLED row actually landing: `count` alone would also fire for
    // a batch of disabled keywords, which produce no scan unit at all.
    if (result.count > 0 && data.some((k) => k.enabled)) {
      await markEngageScanWork(organizationId);
    }
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

    // Activate the config so the plan's keywords actually run. getOrCreateConfig
    // CREATES a new project config DISABLED (the general engage config-family
    // APIs want an explicit opt-in), but an operation plan's keywords are meant
    // to scan/reply immediately — and the run gate is
    // `EngageConfig.enabled = true AND EngageKeyword.enabled = true`, so a
    // disabled config would leave every (enabled) plan keyword dormant. This is
    // the ONLY caller of resolveOrCreateKeywordIds (operation-plan generation),
    // so enabling here never affects a config the user manages elsewhere. Only
    // write when actually flipping, to avoid a needless update on re-drives.
    if (!config.enabled) {
      await this._config.model.engageConfig.update({
        where: { id: configId },
        data: { enabled: true },
      });
    }

    // Existing keywords under this config, indexed by normalized form.
    const existing = await this._keyword.model.engageKeyword.findMany({
      where: { configId, organizationId },
      select: { id: true, keyword: true },
    });
    const normToId = new Map<string, string>();
    for (const row of existing)
      normToId.set(normalizeKeyword(row.keyword), row.id);

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
          where: {
            configId,
            organizationId,
            keyword: { equals: text, mode: 'insensitive' },
          },
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
    const shouldResetInitialScan = dto.enabled === true && kw.enabled === false;
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
      // Re-enabling revives a scan unit; if the keyword was never scanned it
      // still has no cursor and is due immediately. Same fast lane as a create.
      await markEngageScanWork(organizationId);
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
    // Title is matched alongside the body: it holds text that used to live in
    // postContent (a Quora question, a Reddit headline), so matching the body
    // alone would drop every post that mentions the keyword only in its title.
    // Trigram GIN indexes on BOTH columns back this ILIKE (engage-indexes.sql).
    return this._opportunity.model.engageOpportunity.findMany({
      where: {
        deletedAt: null,
        OR: [
          { postContent: { contains: kw.keyword, mode: 'insensitive' } },
          { title: { contains: kw.keyword, mode: 'insensitive' } },
        ],
      },
      orderBy: { postPublishedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        platform: true,
        externalPostUrl: true,
        authorUsername: true,
        title: true,
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
  //
  // Channels live in EngageTrackedAccount alongside author targets (the scope is
  // implied by `platform`). These four methods keep the legacy channel field
  // names on the way in and out so the /engage/monitored-channels routes, the
  // frontend and the extension are unaffected by the merge.

  async addMonitoredChannel(
    configId: string,
    organizationId: string,
    dto: AddMonitoredChannelDto
  ) {
    // ONE write boundary: canonicalises the platform, asserts the scope matches
    // this door, normalises the key and validates it against the CHANNEL
    // alphabet. Shared with setupEngage so the bulk path cannot skip it.
    const { platform, username } = buildScanTargetKey(
      dto.platform,
      dto.channelId,
      'channel'
    );
    // Unique violation on (configId, platform, username) → 409.
    const created = await this._createOrConflict(
      `Channel "${dto.channelName ?? dto.channelId}"`,
      () =>
        this._trackedAccount.model.engageTrackedAccount.create({
          data: {
            configId,
            organizationId,
            platform,
            username,
            displayName: dto.channelName,
            enabled: dto.enabled ?? true,
            audienceSize: dto.audienceSize ?? 0,
            ...(dto.metadata && {
              metadata: dto.metadata as Prisma.InputJsonValue,
            }),
          },
        })
    );
    // A channel is its own scan unit, so this is due immediately just like a new
    // keyword. Matters most for operation-plan generation, which lands keywords
    // and Tier-2-discovered subreddits in the same run — without this the
    // subreddits would trail the keywords by a full backstop period.
    if (dto.enabled ?? true) await markEngageScanWork(organizationId);
    return toChannelShape(created);
  }

  async listMonitoredChannels(
    organizationId: string,
    projectId: string | null = null
  ) {
    const rows = await this._trackedAccount.model.engageTrackedAccount.findMany(
      {
      where: {
        organizationId,
        config: { projectId },
        platform: { in: [...CHANNEL_SCOPE_PLATFORMS] },
      },
      orderBy: { createdAt: 'asc' },
      }
    );
    return rows.map(toChannelShape);
  }

  async updateMonitoredChannel(
    organizationId: string,
    id: string,
    dto: UpdateMonitoredChannelDto
  ) {
    const channel = await this._findChannelOr404(organizationId, id);
    const updated =
      await this._trackedAccount.model.engageTrackedAccount.update({
      where: { id: channel.id },
      data: {
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
          ...(dto.channelName !== undefined && {
            displayName: dto.channelName,
          }),
        ...(dto.audienceSize !== undefined && {
          audienceSize: dto.audienceSize,
        }),
      },
    });
    return toChannelShape(updated);
  }

  async removeMonitoredChannel(organizationId: string, id: string) {
    const channel = await this._findChannelOr404(organizationId, id);
    const deleted =
      await this._trackedAccount.model.engageTrackedAccount.delete({
      where: { id: channel.id },
    });
    return toChannelShape(deleted);
  }

  /**
   * What r/<subreddit> requires of a post (flair options, flair/title-tag
   * rules), as last observed BY THIS ORG. Empty when nothing has been observed.
   *
   * Scoped to `organizationId`, symmetric with the write below. An earlier
   * version read across orgs on the theory that a flair list is a public
   * property of the community rather than tenant data. That is true of the
   * FACT, but not of the value stored here: nothing server-side can fetch a
   * flair list (Reddit answers USER_REQUIRED without credentials — the premise
   * of this whole feature), so the record is one tenant's unverified assertion,
   * validated for shape and never for truth. Serving it to another tenant let
   * any org steer a victim's outbound posts — a seeded one-element list makes
   * matchRedditFlairLabel drop the victim's proposed flair, and the effect
   * landed on exactly the subreddits a victim had NOT monitored, since a
   * Tier-2 discovery has no own row until after resolution.
   *
   * A subreddit this org has never published to therefore resolves as
   * "unknown", which resolveRedditTargets already handles by passing the
   * generated label through unverified — the pre-feature behavior.
   */
  async getRedditChannelCapability(
    organizationId: string,
    subreddit: string
  ): Promise<RedditChannelCapability> {
    // `?? ''` before normalizeUsername, which dereferences its argument: this
    // is reachable from a query string, so a missing param must return the
    // empty record rather than a TypeError.
    const username = normalizeUsername('reddit', subreddit ?? '');
    if (!username) return {};
    // One org can monitor the same subreddit from several projects (a row per
    // EngageConfig) and every one of them carries the same observation, so the
    // freshest row is enough — no need to materialize the rest.
    const row = await this._trackedAccount.model.engageTrackedAccount.findFirst(
      {
      where: { organizationId, platform: 'reddit', username },
      select: { metadata: true },
      orderBy: { updatedAt: 'desc' },
      }
    );
    return row ? readRedditCapability(row.metadata) : {};
  }

  /**
   * Fold one observation of r/<subreddit>'s posting rules into this org's rows.
   *
   * Multi-row, not single-row: one org can monitor the same subreddit from
   * several projects (a row per EngageConfig), and all of them should carry the
   * same observation. Per-row `update` rather than one `updateMany` because the
   * merge reads each row's existing metadata — see the inline note below.
   *
   * Zero matched rows is a normal no-op: this org does not monitor the
   * subreddit, and the capability record is a cache attached to a monitoring
   * relationship, not an entity of its own. Creating a row here to hold it
   * would silently add a scan target nobody asked for.
   */
  async recordRedditChannelCapability(
    organizationId: string,
    subreddit: string,
    patch: RedditChannelCapability
  ): Promise<{ updated: number }> {
    const username = normalizeUsername('reddit', subreddit);
    if (!username || isEmptyRedditCapability(patch)) return { updated: 0 };

    const rows = await this._trackedAccount.model.engageTrackedAccount.findMany(
      {
      where: { organizationId, platform: 'reddit', username },
      select: { id: true, metadata: true },
      }
    );
    if (!rows.length) return { updated: 0 };

    const observedAt = new Date().toISOString();
    // Per-row rather than one updateMany: the merge reads each row's existing
    // metadata (to preserve description/url/avatar and any boolean this patch
    // does not state), so the new value differs per row.
    await Promise.all(
      rows.map((row) =>
        this._trackedAccount.model.engageTrackedAccount.update({
          where: { id: row.id },
          data: {
            metadata: mergeRedditCapability(
              row.metadata,
              patch,
              observedAt
            ) as Prisma.InputJsonValue,
          },
        })
      )
    );
    return { updated: rows.length };
  }

  /**
   * A channel-scope row owned by this org, or 404. The platform predicate keeps
   * the channel routes from reaching an author target that happens to share an
   * id — they address disjoint subsets of one table now.
   */
  private async _findChannelOr404(organizationId: string, id: string) {
    const row = await this._trackedAccount.model.engageTrackedAccount.findFirst(
      {
      where: {
        id,
        organizationId,
        platform: { in: [...CHANNEL_SCOPE_PLATFORMS] },
      },
      }
    );
    if (!row) throw new NotFoundException('Channel not found');
    return row;
  }

  // ─── Tracked Accounts ─────────────────────────────────────────────────────

  async addTrackedAccount(
    configId: string,
    organizationId: string,
    dto: AddTrackedAccountDto
  ) {
    // Same write boundary as addMonitoredChannel — it rejects the wrong door
    // (a reddit "tracked account" used to be storable and was then scanned as
    // /r/<username>) and rejects a key that could shape the `from:<username>`
    // X query. The NORMALIZED key is what gets STORED: it is the scan-unit key,
    // and `getOrgContextsForUnit` matches it with `equals … insensitive`, which
    // bridges case but not a stray `@` or `u/` — so a raw `@Alice` would be
    // scanned and then fan out to zero subscribers.
    const { platform, username } = buildScanTargetKey(
      dto.platform ?? 'x',
      dto.username,
      'tracked'
    );
    // Unique violation on (configId, platform, username) → 409.
    const created = await this._createOrConflict(
      `Account "${dto.username}"`,
      () =>
      this._trackedAccount.model.engageTrackedAccount.create({
        data: {
          configId,
          organizationId,
          platform,
          username,
          ...(dto.picture && { picture: dto.picture }),
          ...(dto.categoryLabel && { categoryLabel: dto.categoryLabel }),
          ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        },
      })
    );
    // A tracked account is its own scan unit — same fast lane as a keyword.
    if (dto.enabled ?? true) await markEngageScanWork(organizationId);
    return created;
  }

  async listTrackedAccounts(
    organizationId: string,
    projectId: string | null = null
  ) {
    return this._trackedAccount.model.engageTrackedAccount.findMany({
      where: {
        organizationId,
        config: { projectId },
        // Channel-scope rows share this table but belong to the
        // /engage/monitored-channels contract — see listMonitoredChannels.
        platform: { notIn: [...CHANNEL_SCOPE_PLATFORMS] },
      },
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
        where: {
          id,
          organizationId,
          platform: { notIn: [...CHANNEL_SCOPE_PLATFORMS] },
        },
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
        where: {
          id,
          organizationId,
          platform: { notIn: [...CHANNEL_SCOPE_PLATFORMS] },
        },
      });
    if (!account) throw new NotFoundException('Tracked account not found');
    return this._trackedAccount.model.engageTrackedAccount.delete({
      where: { id },
    });
  }

  // ─── Reply Accounts ───────────────────────────────────────────────────────

  async getRedditIntegrationToken(
    organizationId: string
  ): Promise<string | null> {
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

  /**
   * Connected accounts that Engage may reply AS, for one project.
   *
   * Platform-scoped rather than X-only: `engageEnabled` is a per-(integration,
   * project) fact, so it lives on IntegrationProject — the join table that IS
   * that grain. Its default is TRUE (opt-out), which is why an org that never
   * configured anything still sees every connected account as selectable.
   *
   * Only platforms whose replies go out through a CONNECTED ACCOUNT belong here.
   * Extension-published replies (Reddit and friends) use the browser's own
   * session — nothing picks an account for them, so their policy is
   * per-platform, in EngageConfig.replyPolicies.
   */
  async listReplyAccountIntegrations(
    organizationId: string,
    projectId: string | null = null,
    platforms: readonly string[] = ['x']
  ) {
    const integrations = await this._integration.model.integration.findMany({
      where: {
        organizationId,
        providerIdentifier: { in: [...platforms] },
        deletedAt: null,
        disabled: false,
        type: 'social',
      },
      // The project binding carries engageEnabled. Absent binding = never
      // excluded, so it reads as enabled (see the default above).
      include: {
        ...(projectId
          ? {
              integrationProjects: {
                where: { projectId },
                select: { engageEnabled: true },
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
    return integrations.map(({ integrationProjects, ...integration }: any) => ({
      ...integration,
      engageEnabled: integrationProjects?.[0]?.engageEnabled ?? true,
    }));
  }

  /**
   * Create or update the project-level Engage reply setting for an account.
   */
  async upsertReplyAccount(
    organizationId: string,
    integrationId: string,
    dto: UpdateReplyAccountDto
  ) {
    if (!dto.projectId) {
      throw new BadRequestException(
        'A projectId is required: Engage reply participation is per-project'
      );
    }

    const integration = await this._integration.model.integration.findFirst({
      where: { id: integrationId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!integration) throw new NotFoundException('Integration not found');

    const replyAccount =
      await this._integrationProject.model.integrationProject.upsert({
        where: {
          integrationId_projectId: {
            integrationId,
            projectId: dto.projectId,
          },
        },
        create: {
          integrationId,
          projectId: dto.projectId,
          organizationId,
          ...(dto.engageEnabled === undefined
            ? {}
            : { engageEnabled: dto.engageEnabled }),
        },
        update: {
          organizationId,
          ...(dto.engageEnabled === undefined
            ? {}
            : { engageEnabled: dto.engageEnabled }),
        },
        select: { engageEnabled: true },
      });

    return {
      integrationId,
      projectId: dto.projectId,
      engageEnabled: replyAccount.engageEnabled,
    };
  }

  // ─── Opportunities ────────────────────────────────────────────────────────

  // Flatten a per-org state row + its global opportunity into the legacy
  // EngageOpportunity response shape the API/frontend expect. `id` remains the
  // global opportunity id for read compatibility; `stateId` is the mutation id.
  //
  // Fields are listed explicitly (not via `...opportunity`) so the compiler
  // catches any future schema migration that accidentally moves a score field
  // to the wrong table — the global/per-org boundary is enforced at the type
  // level by naming each field's source.
  private _merge<
    T extends {
      id: string;
      projectId: string | null;
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
      // Reply mutations address this per-project state id. The global
      // opportunity id remains available as `id` for legacy read-only callers.
      stateId: state.id,
      projectId: state.projectId,
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
      title: opportunity.title,
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
      // rawData (full platform JSON payload) is intentionally NOT exposed:
      // returning it per item bloats every _merge-based response (notably the
      // paginated opportunities list) — the server-side X adapter archives a
      // whole tweet payload in there. What a client actually needs is derived
      // out of it explicitly instead: the attachment URLs, which the body
      // cannot carry because postContent strips X's t.co media placeholder,
      // and whether postContent is an X Article's preview text rather than a
      // full tweet body. Free of extra DB cost — the row is already loaded
      // via `include: { opportunity: true }`.
      mediaUrls: opportunityMediaUrls(opportunity.rawData),
      contentType: opportunityContentType(opportunity.rawData),
      // Per-org createdAt (when this org first saw the opportunity).
      createdAt,
      updatedAt: opportunity.updatedAt,
      deletedAt: opportunity.deletedAt,
      // Returned so the feed can say WHY a post it is still showing never gets
      // an automatic reply. The row deliberately stays visible (that is the
      // whole difference from deletedAt — see the column's note in schema.prisma),
      // and without this the card would look identical to one that is simply
      // waiting its turn.
      repliesDisabledAt: opportunity.repliesDisabledAt,
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

  // Single source of truth for the /opportunities where-clause, shared by
  // listOpportunities / locateOpportunity / countOpportunities and the counts
  // rollups so their scoping can't drift. Filters absent from the caller's dto
  // (e.g. `status`/`platform` on the counts-summary contract) are simply not
  // applied. The nested opportunity filter is returned separately: call sites
  // injecting `platform` must spread `oppFilter` — spreading `where.opportunity`
  // would widen to the field's declared union type (EngageOpportunityWhereInput
  // | EngageOpportunityScalarRelationFilter) and no longer accept `platform`.
  /**
   * Projects whose EngageConfig opts into unattended replying, with the mode.
   * The switch lives on EngageConfig (per project = the granularity an operation
   * plan works at). Per-PLATFORM refinements live in EngageConfig.replyPolicies.
   *
   * `enabled` is required too: a project whose Engage is switched off must not
   * keep replying just because a mode was left set.
   */
  /**
   * Projects whose managed replies are actually driveable right now.
   *
   * The switch chain, top down (docs/automation-api.md): the Automation master
   * switch, then the managed-replies feature switch (`autoReplyEnabled`).
   * `enabled` remains the Engage feature's own switch (it also gates scanning).
   * The per-platform level is applied by the caller, which reads
   * `replyPolicies[platform].autoReplyEnabled`.
   *
   * Filtering here rather than in the driver keeps a switched-off project out of
   * the result set entirely, so no budget lookup or pacing query is spent on it.
   */
  async getAutoReplyConfigs(organizationId: string) {
    const rows = await this._config.model.engageConfig.findMany({
      // Only the real columns are filtered in SQL; the switch chain lives in
      // `metadata` and is applied in code below.
      //
      // A JSON path filter could express it, but keeping it in code means the
      // driver's gate and every other read share one implementation of the
      // defaults — and it costs nothing here, where the row count is "projects
      // in this org", not "opportunities".
      where: { organizationId, enabled: true, projectId: { not: null } },
      select: { id: true, projectId: true, metadata: true },
    });

    return rows
      .map((row) => ({ row, meta: readEngageConfigMetadata(row) }))
      // Master switch AND the managed-replies feature switch. The per-platform
      // level is applied by the caller against replyPolicies[platform].
      .filter(({ meta }) => isRepliesActive(meta))
      .map(({ row, meta }) => ({
        id: row.id,
        projectId: row.projectId,
        replyPolicies: meta.replyPolicies,
      }));
  }

  /**
   * LEASE + return this org's queued engage replies for one platform.
   *
   * The same claim `claimDueExtensionPublishPosts` performs for scheduled posts,
   * applied to replies — deliberately the same three steps, on the same two
   * columns, with the same release semantics:
   *   1. pick QUEUE replies that are un-leased (`releaseId` null) or whose lease
   *      has EXPIRED (`claimedAt <= leaseCutoff`), oldest first;
   *   2. stamp our `leaseToken` + `claimedAt`, guarded by the SAME predicate so
   *      a racing puller makes our update a no-op for a row it already took;
   *   3. read back only the rows carrying OUR token — the ones we won.
   *
   * A sent reply backfills PUBLISHED and a URL, which overwrites `releaseId` and
   * releases the lease implicitly. A send that never landed — browser closed,
   * network dropped, platform errored — is simply re-offered once the lease
   * expires. That is the whole redelivery mechanism: it is not a feature added
   * on top, it is what a lease already does, and it is why replies needed no
   * columns of their own.
   *
   * **`state: QUEUE` is what separates an automated reply from a human's draft.**
   * `POST /opportunities/:id/save-draft` writes DRAFT and the unattended driver
   * writes QUEUE; nothing else distinguishes them, and both produce an
   * `EngageSentReply` over a `Post`. A DRAFT is something a person is still
   * deciding about — it is theirs to send, and it must never be picked up here.
   */
  async claimDueEngageReplies(
    organizationId: string,
    projectId: string,
    platform: string,
    opts: { limit: number; leaseToken: string; leaseCutoff: Date; now: Date }
  ) {
    if (opts.limit <= 0) return [];

    const available: Prisma.PostWhereInput = {
      OR: [{ releaseId: null }, { claimedAt: { lte: opts.leaseCutoff } }],
    };
    const dueWhere: Prisma.EngageSentReplyWhereInput = {
      organizationId,
      // Scoped to ONE project, because the caller's gates are: the local-time
      // window and the minimum gap are per (project, platform), and a claim that
      // spanned projects would be answering for gates it never checked.
      projectId,
      // An opportunity with no address cannot be replied to, and re-offering it
      // is not harmless: the claim succeeds, the extension fails at the poster,
      // the record stays QUEUE, and the next lease cycle offers it again — the
      // loop behind EngageOpportunity 8007f51d. Excluded here rather than left
      // to the executor so the row simply stops being handed out; repairing its
      // address (admin URL repair) puts it straight back in the queue.
      //
      // `deletedAt` is the same loop with a different cause — the address is
      // fine, the POST behind it is gone (deleted, removed, author suspended) —
      // and it needs the same exclusion. pickAutoReplyCandidates has always
      // filtered on it, so a retired opportunity stopped producing NEW drafts;
      // the one already sitting in QUEUE went on being claimed forever, which
      // is what users saw as the same four dead posts retried across days.
      //
      // This is a GUARDRAIL, not the mechanism: markOpportunityTargetGone also
      // closes those queued replies outright. Without the filter, though, any
      // reply that gets stamped by some other route — the admin sweep, a
      // partial failure — would keep looping.
      // `repliesDisabledAt` is the third cause with the same shape: the address
      // resolves and the post is alive, but the platform does not accept
      // replies on it (comments turned off, thread locked, responses closed).
      // Same guardrail role as `deletedAt` above — markOpportunityRepliesDisabled
      // already closes the queued replies, this stops any that some other route
      // leaves behind from being handed out forever.
      opportunity: {
        platform,
        externalPostUrl: { not: '' },
        deletedAt: null,
        repliesDisabledAt: null,
      },
      post: {
        state: 'QUEUE',
        deletedAt: null,
        // Belt and braces with `state`: a reply that went out leaves QUEUE AND
        // gains a URL, so a half-written commit cannot resurrect it.
        releaseURL: null,
        ...available,
      },
    };

    const candidates = await this._sentReply.model.engageSentReply.findMany({
      where: dueWhere,
      // LEAST-RECENTLY-ATTEMPTED first, not oldest-drafted first.
      //
      // Oldest-drafted was the obvious ordering and it has a failure mode that
      // took six days to notice: a reply that cannot succeed keeps its
      // `createdAt` forever, so it stays at the head of the queue and is picked
      // again the moment its lease expires. With `limit: 1` per (project,
      // platform) poll, and a lease (30m) longer than the cadence (25m), that
      // costs one send slot in two — measured in production, on seven rows, the
      // oldest of which had been spinning since it was drafted.
      //
      // `claimedAt` is stamped on every hand-out (including the ones that went
      // on to fail), so ordering by it puts a row that just failed at the BACK
      // and the queue rotates. A row that cannot succeed then costs one slot per
      // full rotation instead of every other slot.
      //
      // `nulls: 'first'` is load-bearing: a never-handed-out reply has a NULL
      // claimedAt, and Postgres sorts NULLS LAST for ASC by default — without
      // it, brand-new replies would sort BEHIND everything that has already
      // failed, which is the very starvation this is fixing, inverted.
      //
      // `createdAt` stays as the tie-break, so among rows never handed out (all
      // NULL) the oldest still goes first — the original intent, preserved
      // exactly where it was right.
      orderBy: [
        { post: { claimedAt: { sort: 'asc', nulls: 'first' } } },
        { createdAt: 'asc' },
      ],
      take: opts.limit,
      select: { postId: true },
    });
    const postIds = candidates.map((c) => c.postId);
    if (!postIds.length) return [];

    await this._post.model.post.updateMany({
      // Re-check availability at write time: a concurrent claim of the same
      // candidate loses the race for that row, where the guard is a no-op.
      where: { id: { in: postIds }, state: 'QUEUE', ...available },
      data: { releaseId: opts.leaseToken, claimedAt: opts.now },
    });

    const won = await this._sentReply.model.engageSentReply.findMany({
      where: { postId: { in: postIds }, post: { releaseId: opts.leaseToken } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        projectId: true,
        opportunity: { select: { id: true, platform: true, externalPostUrl: true } },
        post: { select: { content: true } },
      },
    });

    return won.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      opportunityId: row.opportunity.id,
      platform: row.opportunity.platform,
      url: row.opportunity.externalPostUrl || '',
      content: row.post.content,
    }));
  }

  /**
   * Opportunities this project could auto-reply to, best first.
   *
   * Only `NEW` rows qualify — every other status means the opportunity is spoken
   * for (REPLIED / SCHEDULED / AUTO_QUEUED) or deliberately out (DISMISSED /
   * EXPIRED). `isCurrentlyMatched` drops rows whose keywords were since edited or
   * disabled, so a plan never replies through a keyword its owner removed.
   *
   * Rows that already carry an EngageSentReply for this (org, project) are
   * excluded: one of those is a saved DRAFT awaiting review, and drafting it a
   * second time would both double-charge and put two replies in front of the
   * user for the same post.
   *
   * `keywords` narrows to a specific keyword's quota (the per-keyword targets a
   * plan sets); omit it to draw from the whole matched pool.
   */
  async pickAutoReplyCandidates(
    organizationId: string,
    projectId: string,
    platform: string,
    opts: {
      limit: number;
      keywords?: string[];
      minScore?: number;
    }
  ) {
    if (opts.limit <= 0) return [];
    return this._oppState.model.engageOpportunityState.findMany({
      where: {
        organizationId,
        projectId,
        status: 'NEW',
        isCurrentlyMatched: true,
        ...(opts.minScore !== undefined && { score: { gte: opts.minScore } }),
        ...(opts.keywords?.length && {
          matchedKeywords: { hasSome: opts.keywords },
        }),
        opportunity: {
          deletedAt: null,
          // A post whose replies the platform has turned off, for the same
          // reason the empty address below is excluded here rather than at send
          // time: drafting is where the money goes. Without this, every poll
          // pays an LLM to write a reply into a box that does not exist, and
          // the only thing that learns anything is the failed attempt.
          //
          // Cross-org by design. The write is on the shared opportunity row, so
          // one org's poster discovering that comments are off spares every
          // other org the same wasted generation.
          repliesDisabledAt: null,
          platform,
          // Drafting is where the money is spent, so an address that cannot be
          // replied to has to be excluded HERE, not at send time — otherwise
          // every poll pays an LLM to write a reply that the poster can only
          // refuse. Empty addresses used to reach ingest from LinkedIn's SDUI
          // search layout; they are now dropped on the way in as well.
          externalPostUrl: { not: '' },
          // No reply record for THIS project yet (another project replying to the
          // same global post is fine — state is per-org/project).
          sentReplies: { none: { organizationId, projectId } },
        },
      },
      // Score first; same-score ties go to the freshest underlying post — a
      // reply reads more natural on a conversation that just happened than one
      // that's been sitting in our queue a while. `postPublishedAt` (the post's
      // own timestamp) rather than `createdAt` (when WE scanned it in) is the
      // field that actually means "how recent" from a reader's perspective —
      // the two can diverge by hours if the scan cadence lags.
      orderBy: [
        { score: 'desc' },
        { opportunity: { postPublishedAt: 'desc' } },
      ],
      take: opts.limit,
      select: {
        id: true,
        opportunityId: true,
        score: true,
        matchedKeywords: true,
      },
    });
  }

  /**
   * How many replies are already generated and sitting in `QUEUE` for this
   * (project, platform) — read-only, unlike {@link claimDueEngageReplies},
   * which leases what it finds. Counts a currently-leased row too: it is still
   * "in the queue" from an operator's point of view, just mid-attempt.
   */
  async countQueuedEngageReplies(
    organizationId: string,
    projectId: string,
    platform: string
  ): Promise<number> {
    return this._sentReply.model.engageSentReply.count({
      where: {
        organizationId,
        projectId,
        opportunity: { platform },
        post: { state: 'QUEUE', deletedAt: null, releaseURL: null },
      },
    });
  }

  /**
   * How many opportunities could still become a queued reply — the read-only
   * count behind {@link pickAutoReplyCandidates}'s same where-clause, so a
   * status check and the actual pick can never disagree about what "eligible"
   * means.
   */
  async countEligibleOpportunities(
    organizationId: string,
    projectId: string,
    platform: string,
    opts: { minScore?: number; keywords?: string[] } = {}
  ): Promise<number> {
    return this._oppState.model.engageOpportunityState.count({
      where: {
        organizationId,
        projectId,
        status: 'NEW',
        isCurrentlyMatched: true,
        ...(opts.minScore !== undefined && { score: { gte: opts.minScore } }),
        // The plan's per-keyword budget, exactly as pickAutoReplyCandidates
        // applies it. Leaving it out is what let this report 134 eligible while
        // the pick handed out nothing for two days: the overview and the gate
        // disagreed, and the overview was the one being believed.
        //
        // Absent/empty means the caller has no keyword budget to apply (no
        // active plan), which is also when the pick runs unfiltered — so the
        // two stay in step in both directions.
        ...(opts.keywords?.length && {
          matchedKeywords: { hasSome: opts.keywords },
        }),
        opportunity: {
          deletedAt: null,
          // Mirrors pickAutoReplyCandidates — see the note on the disagreement
          // this pair exists to prevent, immediately below.
          repliesDisabledAt: null,
          platform,
          // Mirrors pickAutoReplyCandidates. Without it this reports work the
          // pick will never hand out, which is precisely the disagreement the
          // doc comment above promises cannot happen.
          externalPostUrl: { not: '' },
          sentReplies: { none: { organizationId, projectId } },
        },
      },
    });
  }

  /**
   * Reserve an auto-reply candidate before model generation. The conditional
   * update is the cross-worker claim: concurrent pollers may discover the same
   * NEW row, but only one can move it to AUTO_QUEUED and spend generation
   * credits on it.
   */
  async claimAutoReplyCandidate(
    organizationId: string,
    projectId: string,
    stateId: string
  ): Promise<boolean> {
    const updated =
      await this._oppState.model.engageOpportunityState.updateMany({
      where: { id: stateId, organizationId, projectId, status: 'NEW' },
      data: { status: 'AUTO_QUEUED' },
    });
    return updated.count === 1;
  }

  /** Release a failed auto-reply reservation so a later poll can retry it. */
  async releaseAutoReplyCandidate(
    organizationId: string,
    projectId: string,
    stateId: string
  ): Promise<void> {
    await this._oppState.model.engageOpportunityState.updateMany({
      where: { id: stateId, organizationId, projectId, status: 'AUTO_QUEUED' },
      data: { status: 'NEW' },
    });
  }

  /**
   * When this project last replied on this platform — the input to the driver's
   * human-like spacing. Without it a poll loop would empty a whole day's budget
   * into one burst the moment the active window opened, which is exactly the
   * behaviour that gets an account rate-limited.
   *
   * "Last replied" is the later of TWO timestamps, and reading only the first
   * is a bug that has already reached production:
   *
   *  - `createdAt` — when the draft was generated. Written once, by the drafting
   *    path only.
   *  - `post.claimedAt` — when the draft was HANDED TO THE EXTENSION to send
   *    (claimDueEngageReplies stamps it, same column the publish lease uses).
   *
   * A poll that hands out an ALREADY-QUEUED draft creates no row, so it moves
   * `createdAt` not at all. Against `createdAt` alone the gate therefore opens
   * once — when the newest draft ages past the interval — and never closes
   * again: every subsequent poll sees an even older timestamp and hands out one
   * more reply, so a backlog drains at the extension's poll rate (one per five
   * minutes) no matter what interval the project configured. Observed live as
   * three Reddit replies inside thirteen minutes against a 4-6 hour setting.
   *
   * Taking the later of the two makes every hand-out — fresh draft or queued
   * one — advance the clock, which is what the gate was always meant to measure.
   */
  async getLastSentReplyAt(
    organizationId: string,
    projectId: string,
    platform: string
  ): Promise<Date | null> {
    // Platform lives on the opportunity, not the reply row — same join the
    // daily-target counts use.
    const where = { organizationId, projectId, opportunity: { platform } };
    const [lastDrafted, lastHandedOut] = await Promise.all([
      this._sentReply.model.engageSentReply.findFirst({
        where,
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      this._sentReply.model.engageSentReply.findFirst({
        where: { ...where, post: { claimedAt: { not: null } } },
        orderBy: { post: { claimedAt: 'desc' } },
        select: { post: { select: { claimedAt: true } } },
      }),
    ]);
    return laterOf(lastDrafted?.createdAt, lastHandedOut?.post?.claimedAt);
  }

  /**
   * The last time ANY track wrote to this platform for this ORG — a reply, or a
   * post the extension took to publish.
   *
   * Deliberately NOT scoped to a project, unlike {@link getLastSentReplyAt}.
   * A project is our concept; the throttle belongs to the platform ACCOUNT, and
   * two projects publishing to the same Hacker News login share one. Scoping
   * this by project would let N projects each spend the full floor.
   *
   * `claimedAt` is the post side's write moment: it is stamped when the
   * extension takes the post to publish, which is the instant the platform
   * actually sees traffic — `publishDate` is only when we intended to.
   */
  async getLastPlatformWriteAt(
    organizationId: string,
    platform: string
  ): Promise<Date | null> {
    const [lastReply, lastPost] = await Promise.all([
      // ENGAGE replies. Keyed through `opportunity.platform`, which is the true
      // platform, and gated on `claimedAt` — the moment the extension took the
      // reply to post it, i.e. when the account is actually touched.
      //
      // Deliberately NOT `createdAt`, unlike getLastSentReplyAt. Creating a
      // draft is an LLM call and a row insert; a human draft parked in Awaiting
      // Review may never be sent at all. Counting it would let one person
      // generating drafts hold back every project's replies on that platform.
      this._sentReply.model.engageSentReply.findFirst({
        where: {
          organizationId,
          opportunity: { platform },
          post: { claimedAt: { not: null } },
        },
        orderBy: { post: { claimedAt: 'desc' } },
        select: { post: { select: { claimedAt: true } } },
      }),
      // PUBLISHED posts, excluding engage's own rows — those are covered above,
      // by their true platform.
      //
      // The exclusion is load-bearing, not tidiness. Two reasons, and the
      // second outlives the first:
      //
      //   1. Rows written before upsertDraft was fixed carry
      //      `providerIdentifier: platform === 'x' ? 'x' : 'reddit'` — every
      //      non-X reply filed under reddit. Matching on that column without
      //      the filter counted an HN reply as a reddit write and starved the
      //      org's reddit replies for a full floor. The backfill in
      //      `fix-engage-post-provider-identifier.sql` repairs them, but this
      //      query must be correct against an un-migrated database too.
      //   2. Even with every row correct, an engage reply is already counted
      //      above by its true `opportunity.platform` — leaving it in here
      //      would just match the same hand-out twice.
      //
      // The platform match mirrors how the publish path resolves it
      // (posts.service.getDuePublishPosts): the column first, then the bound
      // integration for legacy rows that never had it written. Without the
      // second arm those rows publish through the extension while staying
      // invisible to this clock — the floor simply would not apply to them.
      this._post.model.post.findFirst({
        where: {
          organizationId,
          claimedAt: { not: null },
          deletedAt: null,
          source: { not: 'engage' },
          OR: [
            { providerIdentifier: platform },
            {
              providerIdentifier: null,
              integration: { providerIdentifier: platform },
            },
          ],
        },
        orderBy: { claimedAt: 'desc' },
        select: { claimedAt: true },
      }),
    ]);
    return laterOf(lastReply?.post?.claimedAt, lastPost?.claimedAt);
  }

  /**
   * The same lookup as {@link getLastSentReplyAt}, batched across every
   * platform a project has a reply policy for — one caller (the Automation
   * overview) needs it for N platforms at once, and N sequential calls would
   * cost N round trips for what is otherwise a handful of rows.
   *
   * Shares that method's definition of "last replied" deliberately: this feeds
   * the countdown the user reads ("next reply in 4h 56m"), and a countdown
   * computed from a different clock than the gate it is describing is worse
   * than none — it was reporting hours remaining while replies went out every
   * five minutes.
   */
  async getLastSentReplyAtByPlatform(
    organizationId: string,
    projectId: string,
    platforms: string[]
  ): Promise<Record<string, Date>> {
    if (!platforms.length) return {};
    const rows = await this._sentReply.model.engageSentReply.findMany({
      where: { organizationId, projectId, opportunity: { platform: { in: platforms } } },
      orderBy: { createdAt: 'desc' },
      select: {
        createdAt: true,
        post: { select: { claimedAt: true } },
        opportunity: { select: { platform: true } },
      },
    });
    const out: Record<string, Date> = {};
    // Row order can NOT be trusted to pick the winner here: rows are sorted by
    // createdAt, but an older draft handed out five minutes ago outranks a
    // newer one that has never left the queue. Every row is compared.
    for (const row of rows) {
      const platform = row.opportunity.platform;
      const rowLatest = laterOf(row.createdAt, row.post?.claimedAt);
      if (!rowLatest) continue;
      const current = out[platform];
      if (!current || rowLatest > current) out[platform] = rowLatest;
    }
    return out;
  }

  private _opportunityWhere(
    organizationId: string,
    dto: Omit<ListOpportunitiesDto, 'sortBy' | 'sortOrder' | 'page' | 'limit'>
  ): {
    where: Prisma.EngageOpportunityStateWhereInput;
    oppFilter: Prisma.EngageOpportunityWhereInput;
  } {
    const postPublishedAtFilter = this._postPublishedAtFilter(dto);

    // Identity filters are CASE-INSENSITIVE on both axes. The scan-target key is
    // stored normalized (lowercased) while EngageOpportunity.channelId /
    // authorUsername keep the platform's display casing — an exact match would
    // silently return nothing for every mixed-case subreddit or handle. Each
    // axis is its own OR set, so they are combined through AND rather than
    // sharing one `OR` key (which would make the two filters alternatives).
    const identityFilters: Prisma.EngageOpportunityWhereInput[] = [];
    if (dto.channels?.length) {
      identityFilters.push({
        OR: dto.channels.map((c) => ({
          channelId: { equals: c, mode: 'insensitive' as const },
        })),
      });
    }
    if (dto.authors?.length) {
      identityFilters.push({
        OR: dto.authors.map((a) => ({
          authorUsername: { equals: a, mode: 'insensitive' as const },
        })),
      });
    }

    // Global (EngageOpportunity) filters.
    const oppFilter: Prisma.EngageOpportunityWhereInput = {
      deletedAt: null,
      ...(dto.platform?.length && { platform: { in: dto.platform } }),
      ...(identityFilters.length && { AND: identityFilters }),
      ...(dto.intent?.length && { intentTags: { hasSome: dto.intent } }),
      ...(dto.minScoreHeat !== undefined && {
        scoreHeat: { gte: dto.minScoreHeat },
      }),
      ...(dto.minScoreAuthority !== undefined && {
        scoreAuthority: { gte: dto.minScoreAuthority },
      }),
      ...(postPublishedAtFilter && { postPublishedAt: postPublishedAtFilter }),
    };

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
      ...(() => {
        const set = [
          ...(dto.keyword ? [dto.keyword] : []),
          ...(dto.keywords ?? []),
        ];
        return set.length ? { matchedKeywords: { hasSome: set } } : {};
      })(),
      opportunity: oppFilter,
    };

    return { where, oppFilter };
  }

  async listOpportunities(organizationId: string, dto: ListOpportunitiesDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;

    const { where } = this._opportunityWhere(organizationId, dto);

    // Route sort field to the table that owns it.
    const stateSortFields = new Set(['score', 'scoreKeyword', 'scoreTracked']);
    const oppSortFields = new Set([
      'scoreHeat',
      'scoreAuthority',
      'scoreRecency',
      'postPublishedAt',
    ]);
    const sortBy =
      dto.sortBy &&
      (stateSortFields.has(dto.sortBy) || oppSortFields.has(dto.sortBy))
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
    const orderBy = [
      primaryOrderBy,
      tiebreaker,
      { opportunityId: 'desc' as const },
    ];

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
    // Subreddit avatars live on the scan target's metadata (`metadata.avatar`),
    // keyed by (platform=reddit, username). Only Reddit rows carry a channel
    // avatar; every other platform resolves to null. One bounded query for the
    // channels referenced by the current page.
    //
    // NORMALIZED on both sides: the target's `username` is stored normalized
    // (lowercased) while EngageOpportunity.channelId keeps Reddit's display
    // casing (`AskReddit`), so an as-is comparison would miss every subreddit
    // whose name is not already lowercase.
    const redditChannelIds = [
      ...new Set(
        rows
          .filter(
            (r) =>
              r.opportunity.platform === 'reddit' && r.opportunity.channelId
          )
          .map((r) =>
            normalizeUsername('reddit', r.opportunity.channelId as string)
          )
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
              select: {
                id: true,
                opportunityId: true,
                post: { select: { releaseURL: true } },
              },
            })
            .then((r) => r ?? [])
        : Promise.resolve([]),
      redditChannelIds.length
        ? this._trackedAccount.model.engageTrackedAccount
            .findMany({
              // The subreddit avatar is a global property of the subreddit, not
              // per-org, so match on (platform, username) only. Scoping by
              // organizationId would miss the avatar whenever this org's own
              // channel row lacks the cached metadata — e.g. the post surfaced via
              // keyword scan for a subreddit this org doesn't monitor but another
              // org does, or this org's row was added without the search metadata.
              where: {
                platform: 'reddit',
                username: { in: redditChannelIds },
              },
              select: { username: true, metadata: true },
            })
            .then((rows) =>
              rows.map((r) => ({ channelId: r.username, metadata: r.metadata }))
            )
        : Promise.resolve([]),
    ]);

    // The manual-reply link status lets the feed show "replied, link pending"
    // and offer a backfill. The latest reply per opportunity wins (per-post
    // tracking means an opportunity may have several replies). `replyLink` is
    // the stored Post.releaseURL (null = not yet submitted); `sentReplyId` is
    // what the backfill endpoint (PATCH /sent/:id/reply-url) needs.
    const latestByOpp = new Map<
      string,
      { id: string; replyLink: string | null }
    >();
    for (const rep of replies) {
      if (!latestByOpp.has(rep.opportunityId)) {
        latestByOpp.set(rep.opportunityId, {
          id: rep.id,
          replyLink: rep.post?.releaseURL ?? null,
        });
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
    // The map is keyed by the NORMALIZED target key (ch.channelId is the row's
    // `username`), so reads must normalize too — see redditChannelIds above.
    const avatarFor = (platform: string, channelId: string | null) =>
      platform === 'reddit' && channelId
        ? channelAvatarById.get(normalizeUsername('reddit', channelId)) ?? null
        : null;

    const items = rows.map((r) => {
      const merged = this._merge(r);
      const rep = latestByOpp.get(merged.id);
      return {
        ...merged,
        sentReplyId: rep?.id ?? null,
        replyLink: rep?.replyLink ?? null,
        channelAvatar: avatarFor(merged.platform, merged.channelId),
      };
    });

    return { items, total, page, limit };
  }

  // Rollup for the feed's tab/platform badges: total + byStatus + byPlatform in
  // one round trip, all computed under the SAME conditions (the /opportunities
  // filter contract minus `status`/`platform` — those are the breakdown axes
  // here, not filters; narrowing by them is what countOpportunities is for).
  // `status` lives on EngageOpportunityState itself, so it groups in one
  // query. `platform` lives on the joined EngageOpportunity, which Prisma's
  // groupBy can't traverse — one scoped count per platform stands in for that
  // breakdown, same pattern as getSentStats/getSentCounts below.
  async getOpportunityCountsSummary(
    organizationId: string,
    dto: OpportunityCountsSummaryDto
  ) {
    // Every query gets an independently built where-tree: sharing one object
    // across the parallel counts lets anything that mutates its argument bleed
    // filters from one count into another (the exact bug the old structured-
    // Clone guard existed for).
    const build = () => this._opportunityWhere(organizationId, dto);

    const [total, statusGroups, platformCounts] = await Promise.all([
      this._oppState.model.engageOpportunityState.count({
        where: build().where,
      }),
      this._oppState.model.engageOpportunityState.groupBy({
        by: ['status'],
        where: build().where,
        _count: { _all: true },
      }),
      Promise.all(
        OPPORTUNITY_COUNT_PLATFORMS.map((platform) => {
          const { where, oppFilter } = build();
          return this._oppState.model.engageOpportunityState.count({
            where: { ...where, opportunity: { ...oppFilter, platform } },
          });
        })
      ),
    ]);

    return {
      total,
      byStatus: this._zeroFilledByStatus(statusGroups),
      byPlatform: Object.fromEntries(
        OPPORTUNITY_COUNT_PLATFORMS.map((p, i) => [p, platformCounts[i]])
      ) as Record<(typeof OPPORTUNITY_COUNT_PLATFORMS)[number], number>,
    };
  }

  // Count under EXACTLY the /opportunities filter contract, via the same shared
  // where-builder as listOpportunities so the two can't drift. `total` honors
  // every filter (status/platform included) — it is the same number the list
  // returns. `byStatus` honors every filter EXCEPT `status` itself (status is
  // the breakdown axis; applying it would zero the very badges the breakdown
  // exists for), so per-status badges stay complete while platform/keywords/
  // date/etc. all narrow them. Sort/pagination fields on the dto are ignored —
  // they can't change a count.
  async countOpportunities(organizationId: string, dto: ListOpportunitiesDto) {
    const [total, statusGroups] = await Promise.all([
      this._oppState.model.engageOpportunityState.count({
        where: this._opportunityWhere(organizationId, dto).where,
      }),
      this._oppState.model.engageOpportunityState.groupBy({
        by: ['status'],
        where: this._opportunityWhere(organizationId, {
          ...dto,
          status: undefined,
        }).where,
        _count: { _all: true },
      }),
    ]);
    return { total, byStatus: this._zeroFilledByStatus(statusGroups) };
  }

  // All EngageOpportunityStatus keys present (0 when empty) so clients can
  // render fixed tab badges without existence checks.
  private _zeroFilledByStatus(
    statusGroups: Array<{
      status: EngageOpportunityStatus;
      _count: { _all: number };
    }>
  ): Record<EngageOpportunityStatus, number> {
    const byStatus = Object.fromEntries(
      Object.values(EngageOpportunityStatus).map((s) => [s, 0])
    ) as Record<EngageOpportunityStatus, number>;
    for (const g of statusGroups) byStatus[g.status] = g._count._all;
    return byStatus;
  }

  async locateOpportunity(organizationId: string, dto: LocateOpportunityDto) {
    const limit = dto.limit ?? 20;

    // Mirror the `where` from `listOpportunities` exactly (shared builder).
    const { where } = this._opportunityWhere(organizationId, dto);

    const stateSortFields = new Set(['score', 'scoreKeyword', 'scoreTracked']);
    const oppSortFields = new Set([
      'scoreHeat',
      'scoreAuthority',
      'scoreRecency',
      'postPublishedAt',
    ]);
    const sortBy =
      dto.sortBy &&
      (stateSortFields.has(dto.sortBy) || oppSortFields.has(dto.sortBy))
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
    const baseOpp = (where.opportunity ??
      {}) as Prisma.EngageOpportunityWhereInput;

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
              ...((base.opportunity as Prisma.EngageOpportunityWhereInput) ??
                baseOpp),
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
          where: withField(equalPrimaryWhere, tbField, tbIsOppField, {
            gt: tbValue,
          }),
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

  /**
   * Retire an opportunity whose post no longer exists on the platform.
   *
   * The failure this closes: the extension posts a QUEUE reply, the poster
   * opens the permalink and finds the post deleted, the reply fails, the record
   * stays QUEUE, {@link claimDueEngageReplies}'s lease expires, and the very
   * same reply is handed out again on the next poll. Nothing in that cycle
   * learns anything, so it repeats for as long as the row exists — the users
   * saw the same four dead posts retried across days.
   *
   * Two writes, and BOTH are needed:
   *
   *   1. `deletedAt` on the opportunity stops any FURTHER draft being generated
   *      against it (pickAutoReplyCandidates already filters on it) and, with
   *      the matching filter added to claimDueEngageReplies, stops the existing
   *      one being re-offered.
   *   2. The replies already parked against it move QUEUE → ERROR. Without this
   *      they would simply stop being handed out and sit in QUEUE forever,
   *      invisible to the queue counts and to whoever is wondering why a
   *      project's reply budget never drains.
   *
   * TWO checks, answering two different questions — conflating them was the
   * original bug here:
   *
   *   WHO may report — the caller must own a reply actually parked against this
   *     opportunity. `EngageOpportunity` is GLOBAL (one row shared by every org
   *     that scanned the same post), so without this any authenticated caller
   *     could speak about any post. No such reply, no write, 404.
   *
   *   WHETHER the report may act GLOBALLY — `confirmed`. Owning a parked reply
   *     establishes standing, not truth. The extension's own detector grades its
   *     evidence: an HTTP 404/410 is the platform stating the address does not
   *     resolve, true for every tenant; a text match is our inference, and page
   *     text cannot separate "deleted for everyone" from "invisible to THIS
   *     browser session" — a protected account, a private community, an author
   *     who blocked that one login. `deletedAt` has no un-retire path anywhere
   *     (verified: three writers touch this table, none clears it, and scan
   *     re-ingest omits the column), and every opportunity read filters on it,
   *     so an unconfirmed verdict acted on globally would delete a live post
   *     from every other tenant's Engage surface permanently.
   *
   * So `confirmed: false` closes only the caller's parked replies and leaves the
   * opportunity alone. That still ends the loop for the reporter — the replies
   * are closed, and `pickAutoReplyCandidates` will not draft another because it
   * excludes opportunities this project already has a reply against.
   *
   * Idempotent: a second confirmed report (two projects, one dead post) finds
   * the row already stamped and keeps the ORIGINAL timestamp.
   */
  async markOpportunityTargetGone(
    organizationId: string,
    opportunityId: string,
    reason: string,
    confirmed: boolean,
    now = new Date()
  ): Promise<{ retired: boolean; repliesClosed: number }> {
    // The entitlement check AND the work list in one query: these are exactly
    // the replies that get closed below.
    const parked = await this._sentReply.model.engageSentReply.findMany({
      where: {
        organizationId,
        opportunityId,
        post: { state: 'QUEUE', deletedAt: null, releaseURL: null },
      },
      select: { postId: true },
    });
    if (!parked.length) {
      throw new NotFoundException(
        'No queued reply of yours is waiting on that opportunity'
      );
    }

    const error =
      `Target is gone: ${reason}`.slice(0, 400) +
      ' — the opportunity was retired, so this reply will not be retried.';

    // One transaction: an opportunity retired while its replies stayed QUEUE
    // would go on being claimed until the deletedAt filter caught it, and
    // replies closed against an opportunity that never got stamped would let
    // the next poll draft a fresh one for the same dead post.
    return this._tx.model.$transaction(async (tx) => {
      // The global write, and ONLY on platform-confirmed evidence — see the
      // doc comment. `deletedAt: null` in the where, not a blind update: a row
      // another org already retired keeps its ORIGINAL timestamp, which is when
      // the post was first observed gone rather than when the last report came.
      if (confirmed) {
        await tx.engageOpportunity.updateMany({
          where: { id: opportunityId, deletedAt: null },
          data: { deletedAt: now },
        });
      }
      // Scoped to THIS org's replies — writing into an organization that never
      // asked us to is not ours to do.
      //
      // NOTE the consequence, because it is not self-healing: once `deletedAt`
      // is stamped, `claimDueEngageReplies` filters the opportunity out for
      // EVERY org, so another org's parked reply is never handed out again and
      // that org can never make the report that would close it. Its row is left
      // QUEUE until the housekeeping shelf-life sweep closes it
      // (engage-housekeeping.activity.ts), which bounds the lifetime but
      // attributes the cause as "expired in queue".
      //
      // `releaseId` is cleared so no lease token is left pointing at a post that
      // will never be handed out again. `claimedAt` is deliberately NOT cleared:
      // it is not only a lease column. It is the sole reply-side input to
      // getLastPlatformWriteAt — "the moment the extension took the reply to
      // post it, i.e. when the account is actually touched" — which feeds the
      // platform write floor the auto-reply driver calls never negotiable.
      // Erasing it would rewind that clock to an older hand-out (or to null),
      // letting the next poll write to the same account inside the floor window,
      // which is the burst the floor exists to prevent. Nothing is left holding
      // the row either way: `state: 'ERROR'` already excludes it from
      // claimDueEngageReplies, whose where-clause requires `post.state: 'QUEUE'`.
      const closed = await tx.post.updateMany({
        where: { id: { in: parked.map((p) => p.postId) }, state: 'QUEUE' },
        data: { state: 'ERROR', error, releaseId: null },
      });
      // `retired` reports what actually happened, not what was asked for: an
      // unconfirmed report closes replies without retiring anything, and a
      // caller told otherwise would have no way to tell the two apart.
      return { retired: confirmed, repliesClosed: closed.count };
    });
  }

  /**
   * Mark a post the PLATFORM itself refuses replies on, and close the caller's
   * replies parked against it.
   *
   * The failure this closes is the one target-gone does not: the post is alive,
   * its address resolves, and every read of the page succeeds — but the reply
   * box does not exist, because the author turned comments off, locked the
   * thread, or closed responses. Reported as an ordinary failure it looked like
   * markup drift worth retrying, so the same un-repliable post was drafted
   * against and handed out on every poll, each round paying for one LLM
   * generation to produce a reply nothing could accept.
   *
   * WHY THIS IS A GLOBAL WRITE, unlike an unconfirmed target-gone report.
   * "Comments are off on this post" is a property of the POST: every org that
   * scanned it sees the same closed box, so one org's poster discovering it
   * spares all the others the same wasted generation. Contrast the refusals
   * target-gone grades as unconfirmed — a protected account, a private
   * community, an author who blocked one login — which are true of a SESSION
   * and would be a lie if written globally.
   *
   * WHY NOT `deletedAt`, given both are written once and never cleared:
   * deletedAt is filtered by every engage read (the feed, keyword previews,
   * score stats, even the admin list), so a false positive would erase a
   * healthy post from every tenant's surface SILENTLY — nobody notices what is
   * missing. This column is filtered by the three automated-reply queries only,
   * so a false positive leaves the post on the feed where it can be seen,
   * acted on by hand, and reported. With six of the seven platform detectors
   * newly written, that difference is the point.
   *
   * The authorisation check is the same as target-gone's and for the same
   * reason: `EngageOpportunity` is shared across orgs, so the caller must own a
   * reply actually parked against this one. No such reply, no write, 404.
   *
   * Idempotent: a second report (two orgs, one closed post) finds the row
   * already stamped and keeps the ORIGINAL timestamp — when the closure was
   * first observed, not when the latest report arrived.
   */
  async markOpportunityRepliesDisabled(
    organizationId: string,
    opportunityId: string,
    reason: string,
    now = new Date()
  ): Promise<{ marked: boolean; repliesClosed: number }> {
    // Entitlement check and work list in one query — exactly the replies closed
    // below, exactly as markOpportunityTargetGone does it.
    const parked = await this._sentReply.model.engageSentReply.findMany({
      where: {
        organizationId,
        opportunityId,
        post: { state: 'QUEUE', deletedAt: null, releaseURL: null },
      },
      select: { postId: true },
    });
    if (!parked.length) {
      throw new NotFoundException(
        'No queued reply of yours is waiting on that opportunity'
      );
    }

    const error =
      `Replies are disabled on this post: ${reason}`.slice(0, 400) +
      ' — the post accepts no replies, so this one will not be retried.';

    // One transaction, for the same reason target-gone uses one: a stamped row
    // whose replies stayed QUEUE would go on being claimed until the filter
    // caught it, and replies closed against an unstamped row would let the next
    // poll draft a fresh one for the same closed post.
    return this._tx.model.$transaction(async (tx) => {
      // `repliesDisabledAt: null` in the where rather than a blind update, so a
      // row another org already stamped keeps its first-observed timestamp.
      const stamped = await tx.engageOpportunity.updateMany({
        where: { id: opportunityId, repliesDisabledAt: null },
        data: { repliesDisabledAt: now },
      });
      // Scoped to THIS org's replies. Other orgs' parked replies are left for
      // their own runners — but unlike the target-gone case, they are not
      // stranded by it: the filter added to claimDueEngageReplies stops the
      // hand-out, and the housekeeping shelf-life sweep closes the row.
      //
      // `releaseId` cleared so no lease token points at a post that will never
      // be handed out again; `claimedAt` deliberately preserved — it is the
      // sole reply-side input to getLastPlatformWriteAt, and rewinding it would
      // let the next poll write to the same account inside the pacing floor.
      const closed = await tx.post.updateMany({
        where: { id: { in: parked.map((p) => p.postId) }, state: 'QUEUE' },
        data: { state: 'ERROR', error, releaseId: null },
      });
      return { marked: stamped.count > 0, repliesClosed: closed.count };
    });
  }

  /**
   * Close a reply whose send FIRED but could not be confirmed.
   *
   * Distinct from {@link markOpportunityTargetGone} in both claim and blast
   * radius. That one says "this post does not exist" and retires a row shared
   * by every org. This one says only "we submitted and could not read the
   * result", which is a fact about one attempt — so the opportunity stays live
   * and exactly one reply record is closed.
   *
   * Why close it at all, when the reply may be live: because leaving it QUEUE
   * is the strictly worse option. The lease expires, `claimDueEngageReplies`
   * offers it again, and the extension posts a SECOND copy of a comment that
   * may already be there. Closing risks losing a reply that never went out;
   * leaving it risks publishing one twice. Only the second is visible to the
   * audience and impossible to take back.
   *
   * And closing is recoverable. `utils/reply.unconfirmed.ts` in the extension
   * walks unresolved rows, looks each reply up on the platform by its own text,
   * and commits the record when it finds one — `publishExtensionReply` does not
   * gate on the record's current state, so ERROR → PUBLISHED still works.
   *
   * Idempotent: `state: 'QUEUE'` in the where means a second report (or a row
   * that went out in the meantime) is a no-op returning `closed: false`.
   */
  async closeUnconfirmedReply(
    organizationId: string,
    sentReplyId: string,
    reason: string
  ): Promise<{ closed: boolean }> {
    // Scoped by organizationId through the reply, so one org can never close
    // another's record by guessing an id.
    const reply = await this._sentReply.model.engageSentReply.findFirst({
      where: { id: sentReplyId, organizationId },
      select: { postId: true },
    });
    if (!reply) throw new NotFoundException('Sent reply not found');

    const error =
      `Send unconfirmed: ${reason}`.slice(0, 400) +
      ' — the reply may be live on the platform, so it will NOT be re-sent. ' +
      'Check the post before sending another.';

    const closed = await this._post.model.post.updateMany({
      // `state: 'QUEUE'` re-asserted at write time: a row that reached
      // PUBLISHED between the extension's attempt and this call went out for
      // real, and marking it ERROR would contradict a confirmed send.
      where: { id: reply.postId, state: 'QUEUE' },
      // `claimedAt` is preserved — see markOpportunityTargetGone for why. It
      // matters most HERE: this method's own premise is that the send FIRED, so
      // this row's claimedAt is the most recent moment the platform account was
      // actually written to. Clearing it would tell the pacing floor that the
      // account is idle seconds after a comment that probably landed.
      data: { state: 'ERROR', error, releaseId: null },
    });
    return { closed: closed.count > 0 };
  }

  async dismissOpportunity(
    organizationId: string,
    id: string,
    projectId?: string | null
  ) {
    // Atomic: only dismiss actionable opportunities. Replied/scheduled rows are protected.
    // `id` is the opportunity id; status lives on this org's (+project's) state row.
    const result = await this._oppState.model.engageOpportunityState.updateMany(
      {
      where: {
        organizationId,
        projectId: projectId ?? null,
        opportunityId: id,
        status: { in: ['NEW', 'AUTO_QUEUED'] },
      },
      data: { status: 'DISMISSED' },
      }
    );
    if (result.count === 0) {
      throw new NotFoundException(
        'Opportunity not found or no longer actionable'
      );
    }
    // Not findUnique: projectId is nullable, and a nullable column can never
    // satisfy a compound-unique lookup (Postgres NULL != NULL) — see the
    // schema comment on EngageOpportunityState's surrogate id.
    const row = await this._oppState.model.engageOpportunityState.findFirst({
      where: {
        organizationId,
        projectId: projectId ?? null,
        opportunityId: id,
      },
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
  private async _findReplyState(
    organizationId: string,
    id: string,
    projectId?: string | null
  ) {
    if (projectId !== undefined) {
      return this._oppState.model.engageOpportunityState.findFirst({
        where: {
          organizationId,
          projectId: projectId ?? null,
          opportunityId: id,
        },
        include: { opportunity: true },
      });
    }

    // Public reply routes use the surrogate state id. Fall back to the legacy
    // null-project opportunity id only for older callers that predate it.
    const state = await this._oppState.model.engageOpportunityState.findFirst({
      where: { organizationId, id },
      include: { opportunity: true },
    });
    if (state) return state;
    return this._oppState.model.engageOpportunityState.findFirst({
      where: { organizationId, projectId: null, opportunityId: id },
      include: { opportunity: true },
    });
  }

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
    const existing = await this._findReplyState(organizationId, id, projectId);
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

    const result = await this._oppState.model.engageOpportunityState.updateMany(
      {
      where: { organizationId, id: existing.id, status: priorStatus },
      data: { status: claimStatus },
      }
    );
    if (result.count === 0) {
      throw new ConflictException(
        'Opportunity already claimed by another request'
      );
    }
    const row = await this._oppState.model.engageOpportunityState.findFirst({
      where: { organizationId, id: existing.id },
      include: { opportunity: true },
    });
    if (!row) throw new NotFoundException('Opportunity not found');
    return {
      opp: this._merge(row),
      priorStatus,
      stateId: row.id,
      projectId: row.projectId,
      opportunityId: row.opportunityId,
    };
  }

  /**
   * Drop every UNSENT reply for an opportunity — a real reply has gone out, and
   * anything still waiting to say the same thing is now obsolete.
   *
   * Covers BOTH unsent states, and the QUEUE half is the one that matters:
   *   - `DRAFT` — a person's saved working copy.
   *   - `QUEUE` — an automated reply waiting for a browser to send it.
   *
   * Missing the QUEUE half would post the same opportunity twice. The driver
   * itself cannot cause that (`pickAutoReplyCandidates` excludes an opportunity
   * that already carries an `EngageSentReply`), but a reply queued BEFORE the
   * user replied by hand is already past that check and would go out anyway.
   *
   * `releaseURL: null` keeps this to replies that never went out. A published
   * row is history and is never deleted, whatever its state says.
   *
   * A reply under an ACTIVE claim is left alone, and that is not caution — it is
   * the only useful choice. The extension already holds its text and is posting
   * it; deleting the row cannot call that back. All it would do is destroy the
   * record of a reply that goes live anyway — unbillable, untrackable, and
   * invisible in Sent. Leaving it lets the send complete and commit normally.
   *
   * (The claim is read against the same lease window `claimDueEngageReplies`
   * uses; an EXPIRED claim means nobody is holding it, so it is deleted like any
   * other unsent row.)
   *
   * Deleting the Post cascades to its EngageSentReply (onDelete: Cascade).
   * No-op when none exist.
   */
  private async _deleteDraftsForOpportunity(
    organizationId: string,
    opportunityId: string,
    projectId?: string | null,
    leaseCutoff?: Date
  ): Promise<void> {
    const cutoff =
      leaseCutoff ??
      new Date(Date.now() - DEFAULT_CLAIM_LEASE_MINUTES * 60_000);
    const drafts = await this._sentReply.model.engageSentReply.findMany({
      where: {
        organizationId,
        projectId: projectId ?? null,
        opportunityId,
        post: {
          state: { in: ['DRAFT', 'QUEUE'] },
          releaseURL: null,
          // Un-held only: no claim, or one whose lease has lapsed.
          OR: [{ releaseId: null }, { claimedAt: { lte: cutoff } }],
        },
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
  /**
   * `state` decides who owns the reply, and it is the ONLY thing that does.
   *
   * `DRAFT` — a person saved it and is still deciding. Theirs to send; it sits
   * in Awaiting review and no automated path may touch it.
   *
   * `QUEUE` — the unattended driver produced it and it is waiting to go out,
   * exactly like a scheduled post waiting for its slot. `claimDueEngageReplies`
   * only ever picks these up.
   *
   * Both produce the same rows otherwise — same `EngageSentReply` over the same
   * `Post` — so there is no second signal to fall back on. Writing an automated
   * reply as DRAFT would put it somewhere nothing sends from; writing a human's
   * as QUEUE would publish something they never approved.
   */
  async upsertDraft(
    organizationId: string,
    opportunityId: string,
    data: {
      platform: string;
      content: string;
      inputData: object;
      /** Automated replies queue for sending; a person's draft waits for them. */
      state?: 'DRAFT' | 'QUEUE';
    },
    projectId?: string | null
  ) {
    const state = data.state ?? 'DRAFT';
    const { randomUUID } = await import('crypto');
    // Atomic: the existing-draft lookup and the Post + EngageSentReply writes run in
    // ONE transaction, so a mid-write failure can never leave an orphan DRAFT Post
    // without its tracking row. (A read-committed transaction does NOT by itself stop
    // two concurrent saves from both seeing no draft and inserting two — that needs a
    // DB-level partial unique index, deliberately skipped to avoid a migration; the
    // realistic trigger is a double-click, which the client should debounce.)
    return this._tx.model.$transaction(async (tx) => {
      // Scoped to the state being written: re-saving a human's draft updates
      // that draft, and the driver's own upsert can only ever meet its own
      // queued row. Without the scope a driver run would silently overwrite a
      // draft the user was editing — and hand it to the extension.
      const existing = await tx.engageSentReply.findFirst({
        where: {
          organizationId,
          projectId: projectId ?? null,
          opportunityId,
          post: { state },
        },
        select: {
          id: true,
          postId: true,
          // Needed to re-stamp the platform below without clobbering anything
          // else the settings blob carries.
          post: { select: { settings: true } },
        },
      });

      if (existing) {
        await tx.post.update({
          where: { id: existing.postId },
          data: {
            content: data.content,
            // Re-stamp the platform on every save, so a row written before this
            // was fixed repairs itself the next time its draft is edited rather
            // than waiting on the backfill migration. Idempotent: an
            // opportunity's platform never changes, so this rewrites the same
            // value on an already-correct row.
            providerIdentifier: data.platform,
            settings: mergeSettingsType(existing.post?.settings, data.platform),
          },
        });
        return tx.engageSentReply.update({
          where: { id: existing.id },
          data: { inputData: data.inputData as Prisma.InputJsonValue },
          include: {
            post: { select: { id: true, content: true, state: true } },
          },
        });
      }

      const post = await tx.post.create({
        data: {
          organizationId,
          projectId: projectId ?? null,
          content: data.content,
          publishDate: new Date(),
          state,
          source: 'engage',
          image: '[]',
          // The opportunity's OWN platform, verbatim. This used to be
          // `platform === 'x' ? 'x' : 'reddit'`, which filed every non-X reply
          // (hackernews, quora, linkedin, medium, devto) under reddit: the admin
          // Post list and the calendar filter on this column directly
          // (posts.repository `channel` filter), so a Hacker News reply showed up
          // as a reddit row whose releaseURL pointed at news.ycombinator.com.
          //
          // Safe to widen because nothing ROUTES on it for an engage reply: the
          // send path claims by `opportunity.platform`
          // (claimDueEngageReplies), and both publish queues exclude
          // `source: 'engage'` outright, so this value never reaches
          // getSocialTaskQueue or the extension's provider lookup. It is the
          // reporting/filtering column, and it must tell the truth.
          providerIdentifier: data.platform,
          settings: JSON.stringify({ __type: data.platform }),
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
            COALESCE("generationHistory", '[]'::jsonb) || ${JSON.stringify([
              entry,
            ])}::jsonb,
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
    await this.appendGenerationHistory(
      organizationId,
      opportunityId,
      entry,
      projectId
    );
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
      if (projectId === undefined) {
        const state =
          await this._oppState.model.engageOpportunityState.findFirst({
          where: { organizationId, id },
          select: { id: true },
        });
        if (state) {
          await this._oppState.model.engageOpportunityState.updateMany({
            where: { organizationId, id: state.id },
            data: { status: priorStatus },
          });
          return;
        }
      }
      await this._oppState.model.engageOpportunityState.updateMany({
        where: {
          organizationId,
          projectId: projectId ?? null,
          opportunityId: id,
        },
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
    if (projectId === undefined) {
      const state = await this._oppState.model.engageOpportunityState.findFirst(
        {
        where: { organizationId, id: opportunityId },
        select: { id: true },
        }
      );
      if (state) {
        const result =
          await this._oppState.model.engageOpportunityState.updateMany({
          where: { organizationId, id: state.id, status: 'SCHEDULED' },
          data: { status: 'NEW' },
        });
        if (result.count === 0) {
          throw new BadRequestException(
            'Opportunity is not in SCHEDULED state'
          );
        }
        return;
      }
    }
    const result = await this._oppState.model.engageOpportunityState.updateMany(
      {
        where: {
          organizationId,
          projectId: projectId ?? null,
          opportunityId,
          status: 'SCHEDULED',
        },
      data: { status: 'NEW' },
      }
    );
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

  async toggleBookmark(
    organizationId: string,
    id: string,
    projectId?: string | null
  ) {
    const row = await this._oppState.model.engageOpportunityState.findFirst({
      where: {
        organizationId,
        projectId: projectId ?? null,
        opportunityId: id,
      },
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

    const [
      stateAgg,
      oppAgg,
      distRows,
      trackedCount,
      bestKeyword,
      bestHeat,
      bestAuthority,
    ] = await Promise.all([
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
            opportunity: { select: { title: true, postContent: true } },
          },
        }),
        this._opportunity.model.engageOpportunity.findFirst({
          where: oppWhere,
          orderBy: { scoreHeat: 'desc' },
          select: { id: true, scoreHeat: true, title: true, postContent: true },
        }),
        this._opportunity.model.engageOpportunity.findFirst({
          where: oppWhere,
          orderBy: { scoreAuthority: 'desc' },
        select: {
          id: true,
          scoreAuthority: true,
          title: true,
          postContent: true,
        },
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
        distribution: [] as Array<{
          range: string;
          count: number;
          pct: number;
        }>,
        topByKeyword: null as null | {
          id: string;
          score: number;
          title: string;
        },
        topByHeat: null as null | { id: string; score: number; title: string },
        topByAuthority: null as null | {
          id: string;
          score: number;
          title: string;
        },
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
      const count = distRows.filter(
        (o) => o.score >= min && o.score <= max
      ).length;
      return {
        range,
        count,
        pct:
          distSampleSize > 0 ? Math.round((count / distSampleSize) * 100) : 0,
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
      // The post's own title when it has one; otherwise the opening of the body,
      // which is all a title-less platform (X, LinkedIn) ever offers.
      topByKeyword: bestKeyword && {
        id: bestKeyword.opportunityId,
        score: bestKeyword.scoreKeyword,
        title: highlightTitle(bestKeyword.opportunity),
      },
      topByHeat: bestHeat && {
        id: bestHeat.id,
        score: bestHeat.scoreHeat,
        title: highlightTitle(bestHeat),
      },
      topByAuthority: bestAuthority && {
        id: bestAuthority.id,
        score: bestAuthority.scoreAuthority,
        title: highlightTitle(bestAuthority),
      },
      trackedCount,
    };
  }

  async getOpportunityById(
    organizationId: string,
    id: string,
    projectId?: string | null
  ) {
    const row = await this._oppState.model.engageOpportunityState.findFirst({
      where: {
        organizationId,
        projectId: projectId ?? null,
        opportunityId: id,
      },
      include: { opportunity: true },
    });
    if (!row) throw new NotFoundException('Opportunity not found');

    const merged = this._merge(row);
    const [sentReply, channel] = await Promise.all([
      this._sentReply.model.engageSentReply.findFirst({
        where: {
          organizationId,
          // Scope to the same project as the state row above; a global opportunity
          // may have been replied under another project in this org, whose reply
          // must not leak onto this project's card.
          projectId: projectId ?? null,
          opportunityId: id,
          post: { state: { not: 'DRAFT' } },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, post: { select: { releaseURL: true } } },
      }),
      row.opportunity.platform === 'reddit' && row.opportunity.channelId
        ? this._trackedAccount.model.engageTrackedAccount.findFirst({
            where: {
              platform: 'reddit',
              // Normalized: the stored key is lowercased, the opportunity keeps
              // Reddit's display casing (see listOpportunities' redditChannelIds).
              username: normalizeUsername('reddit', row.opportunity.channelId),
            },
            select: { metadata: true },
          })
        : Promise.resolve(null),
    ]);

    const metadata = channel?.metadata as
      | Record<string, unknown>
      | null
      | undefined;
    const channelAvatar =
      metadata &&
      typeof metadata === 'object' &&
      typeof metadata.avatar === 'string'
        ? metadata.avatar
        : null;

    return {
      ...merged,
      sentReplyId: sentReply?.id ?? null,
      replyLink: sentReply?.post?.releaseURL ?? null,
      channelAvatar,
    };
  }

  async getOpportunityDetail(
    organizationId: string,
    id: string,
    projectId?: string | null
  ) {
    const row = await this._oppState.model.engageOpportunityState.findFirst({
      where: {
        organizationId,
        projectId: projectId ?? null,
        opportunityId: id,
      },
      include: { opportunity: true },
    });
    if (!row) throw new NotFoundException('Opportunity not found');

    const merged = this._merge(row);

    if (row.status === 'SCHEDULED' || row.status === 'REPLIED') {
      // An opportunity may now carry several replies (batch send); surface the
      // most recent for the detail panel.
      const sentReply = await this._sentReply.model.engageSentReply.findFirst({
        where: {
          organizationId,
          projectId: projectId ?? null,
          opportunityId: id,
        },
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
              title: true,
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

  async getOpportunityForReply(
    organizationId: string,
    id: string,
    projectId?: string | null
  ) {
    const row = await this._findReplyState(organizationId, id, projectId);
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

  /**
   * Copy the (org, project) state row's matchedKeywords onto a sent reply whose
   * snapshot is still empty. The extension flow's reply row is created at
   * save-draft time (upsertDraft) with NO snapshot, so publishExtensionReply
   * calls this at its commit point — the extension path's "send time" — giving
   * it the same send-time snapshot the direct-send paths take from their claim.
   * Operation-plan reply pacing attributes replies by this field. No-op when the
   * state row is missing/empty or the reply already has a snapshot.
   */
  async snapshotSentReplyMatchedKeywords(
    organizationId: string,
    sentReplyId: string,
    projectId: string | null | undefined,
    opportunityId: string
  ): Promise<void> {
    const state = await this._oppState.model.engageOpportunityState.findFirst({
      where: { organizationId, projectId: projectId ?? null, opportunityId },
      select: { matchedKeywords: true },
    });
    if (!state?.matchedKeywords?.length) return;
    await this._sentReply.model.engageSentReply.updateMany({
      where: {
        id: sentReplyId,
        organizationId,
        matchedKeywords: { isEmpty: true },
      },
      data: { matchedKeywords: state.matchedKeywords },
    });
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

  /**
   * Resolve EngageKeyword ids to their keyword TEXT.
   *
   * An operation plan stores `engagePolicies[].keywordTargets` keyed by keyword
   * ID, while every match snapshot — `EngageOpportunityState.matchedKeywords`
   * and `EngageSentReply.matchedKeywords` — stores keyword TEXT. Two array
   * filters compare the two directly (`hasSome` in pickAutoReplyCandidates,
   * `has` in countProjectKeywordSentRepliesToday), so without this translation
   * both compare an id against text and can only ever return the empty set: the
   * driver picks no candidate and every per-keyword tally reads zero, silently,
   * for as long as a plan is active.
   *
   * Ids that resolve to nothing are simply absent from the map, and the caller
   * keeps the original key. A key that is ALREADY text — a plan from an older
   * generator, or a hand-edited one — must keep working, and "leave it alone"
   * is the only reading that serves both shapes.
   */
  async resolveKeywordTexts(
    organizationId: string,
    ids: string[]
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const rows = await this._keyword.model.engageKeyword.findMany({
      where: { organizationId, id: { in: ids } },
      select: { id: true, keyword: true },
    });
    for (const row of rows) out.set(row.id, row.keyword);
    return out;
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
    dto: {
      date?: string;
      platform?: string;
      status?: string;
      projectId?: string;
    },
    opts: { includeDrafts?: boolean } = {}
  ): {
    postWhere: Prisma.PostWhereInput;
    sentWhere: Prisma.EngageSentReplyWhereInput;
  } {
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
          some: {
            organizationId,
            projectId: dto.projectId ?? null,
            status: 'EXPIRED',
          },
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
    const { sentWhere: where } = this._buildSentReplyFilter(
      organizationId,
      dto,
      {
      includeDrafts: true,
      }
    );

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
              title: true,
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

  // Cross-org Engage reply list for the admin console (GET /admin/engage/sent).
  // Anchored on EngageSentReply just like the org-scoped listSentReplies, but
  // NOT locked to a single org / project — an optional organizationId (string or
  // string[]) narrows it, otherwise every org's replies are returned. `platform`
  // filters via the linked opportunity, `state` via the reply Post. Returns the
  // admin envelope { results, total, page, pageSize, totalPages } to match
  // getAllPostsList (AdminPostsController), enriched with org + author info.
  // ── Broken-address triage (admin) ──────────────────────────────────────────
  // See docs/admin-engage-opportunities.md. Driven by the browser extension,
  // which is the only place a LinkedIn address can be re-resolved: those pages
  // are members-only, so no server-side job can read them.

  /**
   * Opportunities whose stored address can never be replied to: an entity page's
   * post LIST (…/company/<slug>/posts/ and the school/showcase equivalents), or
   * no address at all.
   *
   * Matched as a substring rather than a regex so it works identically on any
   * database Prisma targets; the single-post forms (/posts/, /pulse/,
   * /feed/update/) never contain these fragments.
   */
  private brokenUrlFilter(): Prisma.EngageOpportunityWhereInput {
    return {
      OR: [
        { externalPostUrl: '' },
        { externalPostUrl: { contains: 'linkedin.com/company/' } },
        { externalPostUrl: { contains: 'linkedin.com/school/' } },
        { externalPostUrl: { contains: 'linkedin.com/showcase/' } },
      ],
    };
  }

  /**
   * Which of these opportunities cost someone something.
   *
   * THE definition of "paid work", in one place, because both the listing (which
   * decides what an operator is shown) and the delete (which decides what is
   * destroyed) must agree — a row judged free by one and paid by the other is
   * exactly how paid work gets deleted.
   *
   * Three independent signals, ANY of which counts:
   *   1. an EngageSentReply — a reply was sent, or is queued to be;
   *   2. a non-empty generationHistory on any of its states;
   *   3. ANY engage_reply BillingRecord, whatever its status.
   *
   * (3) is not filtered by status even though 'released' means the reservation
   * was returned: releaseReplyGeneration fires both when generateDraft threw
   * (nothing produced) and when queueAutoReply failed to persist a draft that
   * WAS produced, and those are indistinguishable in the data. A draft that
   * exists must never be deleted, so the charge row alone spares the row.
   */
  private async opportunityIdsWithPaidWork(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const [replies, states, charges] = await Promise.all([
      this._sentReply.model.engageSentReply.findMany({
        where: { opportunityId: { in: ids } },
        select: { opportunityId: true },
      }),
      this._oppState.model.engageOpportunityState.findMany({
        where: { opportunityId: { in: ids }, generationHistory: { not: Prisma.DbNull } },
        select: { opportunityId: true, generationHistory: true },
      }),
      this._billingRecord.model.billingRecord.findMany({
        where: { relatedId: { in: ids }, businessType: 'engage_reply' },
        select: { relatedId: true },
      }),
    ]);

    const paid = new Set<string>();
    for (const r of replies) paid.add(r.opportunityId);
    for (const s of states) {
      // `not: DbNull` still lets through JSON null and an empty array.
      if (Array.isArray(s.generationHistory) && s.generationHistory.length > 0) {
        paid.add(s.opportunityId);
      }
    }
    for (const c of charges) if (c.relatedId) paid.add(c.relatedId);
    return paid;
  }

  async listOpportunitiesForAdmin(query: {
    platform?: string;
    page?: number;
    pageSize?: number;
    onlyBrokenUrls?: boolean;
  }) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;

    const where: Prisma.EngageOpportunityWhereInput = {
      deletedAt: null,
      ...(query.platform ? { platform: query.platform } : {}),
      ...(query.onlyBrokenUrls ? this.brokenUrlFilter() : {}),
    };

    const [rows, total] = await Promise.all([
      this._opportunity.model.engageOpportunity.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { postPublishedAt: 'desc' },
        select: {
          id: true,
          platform: true,
          externalPostId: true,
          externalPostUrl: true,
          postContent: true,
          authorDisplayName: true,
          // The repair handle for a row that stored no address at all: its
          // author's recent-activity page is a post list the extension can
          // re-read and match the stored content against. Without it those rows
          // are unrepairable, and they are exactly the ones that reach the reply
          // queue with nowhere to send to.
          authorUsername: true,
          postPublishedAt: true,
          // Surfaced here on purpose. This is the column's audit trail: the
          // admin list is where someone can ask "which posts did the detectors
          // close, and were they right", which is the whole reason the verdict
          // lands on a row that stays visible instead of on `deletedAt`.
          repliesDisabledAt: true,
        },
      }),
      this._opportunity.model.engageOpportunity.count({ where }),
    ]);

    const paid = await this.opportunityIdsWithPaidWork(rows.map((r) => r.id));

    return {
      items: rows.map((r) => ({
        ...r,
        postPublishedAt: r.postPublishedAt?.toISOString?.() ?? null,
        // The extension triages on this: > 0 means repair the address (paid work
        // is waiting on it), 0 means the row is safe to retire. It is a flag
        // reported as a count, not a reply tally — see opportunityIdsWithPaidWork.
        replyCount: paid.has(r.id) ? 1 : 0,
      })),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Rewrite verified addresses. Idempotent: re-sending the same pair updates
   * nothing new and is not an error, so a partially-failed batch can be re-run.
   *
   * Only externalPostUrl is touched. externalPostId backs
   * @@unique([platform, externalPostId]) and is the identity the extension
   * verified the new address against — re-keying a row is a separate migration.
   */
  async repairOpportunityUrlsForAdmin(items: { id: string; externalPostUrl: string }[]) {
    let updated = 0;
    for (const item of items) {
      const res = await this._opportunity.model.engageOpportunity.updateMany({
        where: { id: item.id, deletedAt: null },
        data: { externalPostUrl: item.externalPostUrl },
      });
      updated += res.count;
    }
    return { updated };
  }

  /**
   * Retire rows that produced no paid work, cascading to their states.
   *
   * The caller's own filtering is NOT trusted: it is a browser extension whose
   * counts are as old as its last list call, so every id is re-checked here, at
   * delete time. A row that gained a reply in between is skipped and counted,
   * never deleted. EngageSentReply is not cascaded in the schema either, so even
   * a bug here meets a foreign-key refusal rather than destroying a paid reply.
   */
  async deleteOpportunitiesForAdmin(ids: string[]) {
    const paid = await this.opportunityIdsWithPaidWork(ids);
    const deletable = ids.filter((id) => !paid.has(id));
    if (!deletable.length) return { deleted: 0, skipped: ids.length };

    const res = await this._opportunity.model.engageOpportunity.deleteMany({
      where: { id: { in: deletable } },
    });
    return { deleted: res.count, skipped: ids.length - deletable.length };
  }

  async listSentRepliesForAdmin(query: {
    page?: number;
    pageSize?: number;
    organizationId?: string | string[];
    platform?: string;
    externalPostUrl?: string;
    state?: State;
    sortOrder?: 'asc' | 'desc';
  }) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const offset = (page - 1) * pageSize;
    const sortOrder = query.sortOrder ?? 'desc';

    const postWhere: Prisma.PostWhereInput = {
      source: 'engage',
      ...(query.state ? { state: query.state } : {}),
    };

    // Normalised so a pasted `twitter.com/u/status/1?s=20` matches the row
    // stored as `x.com/u/status/1`; a no-op for any other platform's URL. A
    // substring match, so a bare status id finds the post too.
    const urlQuery = query.externalPostUrl?.trim();
    const normalizedUrl = urlQuery
      ? normalizeExternalPostUrl('x', urlQuery)
      : undefined;

    // Both filters narrow the SAME relation, so they must be merged into one
    // `opportunity` object — written as two keys, the second would silently
    // overwrite the first and drop a filter the caller asked for.
    const opportunityWhere: Prisma.EngageOpportunityWhereInput = {
      ...(query.platform ? { platform: query.platform } : {}),
      ...(normalizedUrl
        ? {
            externalPostUrl: {
              contains: normalizedUrl,
              mode: 'insensitive' as const,
            },
          }
        : {}),
    };

    const where: Prisma.EngageSentReplyWhereInput = {
      ...(query.organizationId
        ? {
            organizationId: Array.isArray(query.organizationId)
              ? { in: query.organizationId }
              : query.organizationId,
          }
        : {}),
      post: postWhere,
      ...(Object.keys(opportunityWhere).length
        ? { opportunity: opportunityWhere }
        : {}),
    };

    const [items, total] = await Promise.all([
      this._sentReply.model.engageSentReply.findMany({
        where,
        include: {
          organization: {
            select: {
              id: true,
              name: true,
              users: {
                where: {
                  role: { in: ['SUPERADMIN', 'ADMIN'] },
                  disabled: false,
                },
                orderBy: { role: 'asc' },
                take: 1,
                select: { userId: true },
              },
            },
          },
          post: {
            select: {
              id: true,
              content: true,
              state: true,
              releaseURL: true,
              publishDate: true,
              createdAt: true,
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
              title: true,
              postContent: true,
              authorUsername: true,
              authorDisplayName: true,
              authorFollowers: true,
              authorAvatarUrl: true,
              postPublishedAt: true,
            },
          },
        },
        // Stable tiebreaker (id) mirrors listSentReplies for deterministic pages.
        orderBy: [{ createdAt: sortOrder }, { id: 'desc' }],
        skip: offset,
        take: pageSize,
      }),
      this._sentReply.model.engageSentReply.count({ where }),
    ]);

    const results = items.map(
      ({ organization, post, opportunity, ...rest }) => {
      const base = {
        id: rest.id,
        createdAt: rest.createdAt,
        projectId: rest.projectId,
        matchedKeywords: rest.matchedKeywords,
        platform: opportunity.platform,
        organization: { id: organization.id, name: organization.name },
        userId: organization.users[0]?.userId ?? null,
        opportunity,
      };
      if (!post) return { ...base, post: null };
      const { settings, ...postRest } = post;
      return {
        ...base,
        post: {
          ...postRest,
          replyAuthor: resolveReplyAuthor(post.integration, settings),
          metrics: normalizeReplyMetrics(
            opportunity.platform,
            post.analytics,
            post.impressions,
            post.trafficScore
          ),
        },
      };
      }
    );

    return {
      results,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async locateSentReply(organizationId: string, dto: LocateSentReplyDto) {
    const limit = dto.limit ?? 20;

    // Mirror the `where` from `listSentReplies` exactly — including DRAFT in the
    // "All" view, so a draft row can be located on the same page the list shows it.
    const { sentWhere: where } = this._buildSentReplyFilter(
      organizationId,
      dto,
      {
      includeDrafts: true,
      }
    );

    const target = await this._sentReply.model.engageSentReply.findFirst({
      where: { ...where, id: dto.sentReplyId },
      select: { id: true, createdAt: true },
    });

    if (!target) {
      const total = await this._sentReply.model.engageSentReply.count({
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
    dto: {
      date?: string;
      platform?: string;
      status?: string;
      projectId?: string;
    } = {}
  ) {
    const { postWhere, sentWhere } = this._buildSentReplyFilter(
      organizationId,
      dto
    );

    // Totals and response rate via DB aggregation — no row cap.
    const [total, repliedCount, impressionsAgg, likeSample] = await Promise.all(
      [
      this._sentReply.model.engageSentReply.count({ where: sentWhere }),
      this._sentReply.model.engageSentReply.count({
        where: { ...sentWhere, authorReplied: true },
      }),
      // Impressions live on Post; sum across the windowed engage posts. The
      // platform filter goes through the post→engageSentReply→opportunity link.
      this._post.model.post.aggregate({
        where: {
          organizationId,
          // Match the project scope of `sentWhere` above: engage Posts carry the
          // same projectId as their EngageSentReply, so without this the
          // impressions/traffic totals sum org-wide while repliesCount/responseRate
          // are project-scoped — inconsistent numbers and a cross-project leak.
          projectId: dto.projectId ?? null,
          ...postWhere,
          ...(dto.platform
              ? {
                  engageSentReply: {
                    is: { opportunity: { platform: dto.platform } },
                  },
                }
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
      ]
    );

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

    return {
      repliesCount: total,
      responseRate,
      totalImpressions,
      totalTrafficScore,
      avgLikes,
    };
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
  // Rollup for the sent tabs' badges: total + byPlatform + rollups +
  // awaitingBreakdown under the /sent filter contract minus `status`/`platform`
  // (the breakdown axes here, not filters — narrowing by them is what
  // countSentReplies is for). Equivalent to countSentReplies with neither
  // filter set; kept as its own endpoint so the rollup contract is explicit
  // and a status/platform param can't silently skew the badges.
  async getSentCountsSummary(
    organizationId: string,
    dto: SentCountsSummaryDto = {}
  ) {
    return this.countSentReplies(organizationId, {
      projectId: dto.projectId,
      date: dto.date,
    });
  }

  // Filtered counts under EXACTLY the /sent filter contract, one round trip.
  // `total` honors every filter (status/platform/date included) — the same
  // number /sent returns. Each breakdown honors every filter EXCEPT its own
  // axis (applying it would zero the very badges the breakdown exists for):
  //   byPlatform        pins one platform per count; status/date still narrow.
  //   rollups           settled/awaiting with the status filter dropped;
  //                     platform/date still narrow.
  //   awaitingBreakdown drafts/link/expired — the awaiting rollup's sub-axis,
  //                     same status-less scoping as rollups.
  // Pagination fields are ignored (they can't change a count). All counts run
  // with includeDrafts to mirror the LIST, whose default view shows drafts.
  // Every count builds its own where-tree via _buildSentReplyFilter — no
  // shared mutable filter objects across the parallel queries.
  async countSentReplies(organizationId: string, dto: ListSentDto) {
    const where = (status?: string, platform?: string) =>
      this._buildSentReplyFilter(
        organizationId,
        { date: dto.date, projectId: dto.projectId, status, platform },
        { includeDrafts: true }
      ).sentWhere;
    const count = (w: Prisma.EngageSentReplyWhereInput) =>
      this._sentReply.model.engageSentReply.count({ where: w });

    const [total, platformCounts, settled, awaiting, drafts, link, expired] =
      await Promise.all([
        count(where(dto.status, dto.platform)),
        Promise.all(
          OPPORTUNITY_COUNT_PLATFORMS.map((platform) =>
            count(where(dto.status, platform))
          )
        ),
        count(where('settled', dto.platform)),
        count(where('awaiting', dto.platform)),
        count(where('awaiting-draft', dto.platform)),
        count(where('awaiting-link', dto.platform)),
        count(where('awaiting-expired', dto.platform)),
      ]);

    return {
      total,
      byPlatform: Object.fromEntries(
        OPPORTUNITY_COUNT_PLATFORMS.map((p, i) => [p, platformCounts[i]])
      ) as Record<(typeof OPPORTUNITY_COUNT_PLATFORMS)[number], number>,
      rollups: { settled, awaiting },
      awaitingBreakdown: { drafts, link, expired },
    };
  }

  // Pull the "likes" metric out of a Post.analytics JSON blob. X stores it under
  // a like/favorite label; Reddit's equivalent is the post score. The sync writes
  // each metric as { label, data: [{ total, date }], percentageChange }.
  private _extractLikes(analytics: unknown, platform: string): number {
    if (!Array.isArray(analytics)) return 0;
    const wanted =
      platform === 'reddit' ? /score|upvote/i : /like|favorite|reaction/i;
    const entry = (
      analytics as Array<{
        label?: string;
        data?: Array<{ total?: string | number }>;
      }>
    ).find((a) => a.label && wanted.test(a.label));
    const raw = entry?.data?.[entry.data.length - 1]?.total;
    const n =
      typeof raw === 'string'
        ? parseInt(raw, 10)
        : typeof raw === 'number'
        ? raw
        : 0;
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
  // (default all-time). Pass any OPPORTUNITY_COUNT_PLATFORMS value for the UI
  // tab/chip scope; `platformSplit`/`impressionsByPlatform`/`trafficByPlatform`
  // always break down across every engage platform, not just x/reddit.
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
      sentByPlatform,
      totalPostAgg,
      aggByPlatform,
      replyRows,
      bestReplyRows,
    ] = await Promise.all([
        // Response-rate DENOMINATOR. Removed replies are excluded, and the
        // reason is structural rather than cosmetic: `authorReplied` is only
        // ever set by the metrics sync, which now skips removed replies — so a
        // removed reply can never enter the numerator, no matter what happens.
        // Left in the denominator it would drag response rate down by exactly
        // the removal rate, and the panel would end up measuring how strict the
        // communities are instead of how good the replies are. Nobody can reply
        // to a comment they cannot see.
        this._sentReply.model.engageSentReply.count({
          where: {
            organizationId,
            post: windowedPostFilter,
            removedAt: null,
            ...platformFilter,
          },
        }),
        this._sentReply.model.engageSentReply.count({
        where: {
          organizationId,
          post: windowedPostFilter,
          removedAt: null,
          authorReplied: true,
          ...platformFilter,
        },
        }),
        this._sentReply.model.engageSentReply.count({
          where: { organizationId, post: sentPostFilter, ...platformFilter },
        }),
        // Per-platform SENT-reply counts across every engage platform (not just
        // x/reddit) — powers `platformSplit`. One scoped count per platform stands
        // in for a group-by, same pattern as countSentReplies/getOpportunityCountsSummary.
        Promise.all(
          OPPORTUNITY_COUNT_PLATFORMS.map((p) =>
            this._sentReply.model.engageSentReply.count({
              where: {
                organizationId,
                post: sentPostFilter,
                opportunity: { platform: p },
              },
            })
          )
        ),
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
        // Per-platform cumulative impressions + traffic across every engage
        // platform in window. Queried directly per platform (not `total - x`) —
        // with 5 non-x/reddit engage platforms now live, that subtraction would
        // silently fold all of their impressions/traffic into whichever platform
        // got queried last.
        Promise.all(
          OPPORTUNITY_COUNT_PLATFORMS.map((p) =>
            this._post.model.post.aggregate({
              where: {
                organizationId,
                source: 'engage',
                ...dateWindow,
                ...projectFilter,
                engageSentReply: { is: { opportunity: { platform: p } } },
              },
              _sum: { impressions: true, trafficScore: true },
            })
          )
        ),
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
          post: {
            select: { content: true, releaseURL: true, analytics: true },
          },
          },
        }),
      ]);

    const platformIndex = (p: (typeof OPPORTUNITY_COUNT_PLATFORMS)[number]) =>
      OPPORTUNITY_COUNT_PLATFORMS.indexOf(p);
    const xPostAgg = aggByPlatform[platformIndex('x')];
    const redditPostAgg = aggByPlatform[platformIndex('reddit')];

    const responseRate =
      total > 0 ? Math.round((repliedCount / total) * 100) : 0;

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
      const likes = this._extractLikes(
        r.post?.analytics,
        r.opportunity.platform
      );
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

    return {
      // All-time count of SENT replies (PUBLISHED only).
      repliesCount: sentReplies,
      responseRate,
      xImpressions, // legacy X-only helper, kept for existing callers
      xTrafficIndex: Math.round(xPostAgg._sum.trafficScore ?? 0), // legacy X-only helper
      totalImpressions,
      totalTrafficScore: Math.round(totalPostAgg._sum.trafficScore ?? 0),
      totalLikes: replyRows.reduce(
        (sum, r) =>
          sum + this._extractLikes(r.post?.analytics, r.opportunity.platform),
        0
      ),
      // Full breakdown across every engage platform (not just x/reddit).
      impressionsByPlatform: OPPORTUNITY_COUNT_PLATFORMS.map((p, i) => ({
        platform: p,
        value: aggByPlatform[i]._sum.impressions ?? 0,
      })),
      trafficByPlatform: OPPORTUNITY_COUNT_PLATFORMS.map((p, i) => ({
        platform: p,
        value: Math.round(aggByPlatform[i]._sum.trafficScore ?? 0),
      })),
      platformSplit: Object.fromEntries(
        OPPORTUNITY_COUNT_PLATFORMS.map((p, i) => [p, sentByPlatform[i]])
      ) as Record<(typeof OPPORTUNITY_COUNT_PLATFORMS)[number], number>,
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
      rangeStart = dayjs
        .utc()
        .subtract(11, 'week')
        .isoWeekday(1)
        .startOf('day')
        .toDate();
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
        const d = dayjs
          .utc()
          .subtract(i, 'week')
          .isoWeekday(1)
          .format('YYYY-MM-DD');
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
      // `count` covers every engage platform; x/reddit are broken out for the
      // chart's two named series only — a non-x/reddit platform (linkedin,
      // medium, devto, hackernews, quora) still counts toward `count` but is
      // deliberately NOT folded into either named bucket (it used to fall into
      // `x` via the `else` branch, mislabeling e.g. LinkedIn replies as X).
      if (r.opportunity.platform === 'reddit') b.reddit++;
      else if (r.opportunity.platform === 'x') b.x++;
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
          opportunity: {
            select: { id: true, platform: true, externalPostUrl: true },
          },
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
    const sinceDays =
      period === 'monthly' ? 365 : period === 'weekly' ? 90 : 30;
    const rangeStart = dayjs
      .utc()
      .subtract(sinceDays, 'day')
      .startOf('day')
      .toDate();

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
        buckets.set(key, {
          date: dateKey,
          platform,
          value: row.impressions ?? 0,
        });
      }
    }

    const result = Array.from(buckets.values());
    result.sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform)
    );
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
    const rankValue = (
      p: string,
      metrics: { likes?: number; upvotes?: number }
    ) => (p === 'reddit' ? metrics.upvotes ?? 0 : metrics.likes ?? 0);

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
          releaseURL:
            r.post?.releaseURL ?? r.opportunity?.externalPostUrl ?? null,
          publishDate: r.post?.publishDate ?? null,
          // The account that posted the reply (avatar + @handle), as in /sent.
          replyAuthor: resolveReplyAuthor(
            r.post?.integration ?? null,
            r.post?.settings ?? null
          ),
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
      throw new BadRequestException(
        'Reply has already been sent — cannot edit'
      );
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
        post: {
          select: { id: true, content: true, state: true, publishDate: true },
        },
      },
    });
  }

  async getSentReplyByOpportunity(
    organizationId: string,
    opportunityId: string,
    projectId?: string | null
  ) {
    // Per-post tracking means an opportunity can have multiple replies; return
    // the most recent (used by cancelAndSendNow to find a still-pending reply).
    let resolvedOpportunityId = opportunityId;
    let resolvedProjectId = projectId;
    if (projectId === undefined) {
      const state = await this._oppState.model.engageOpportunityState.findFirst(
        {
        where: { organizationId, id: opportunityId },
        select: { opportunityId: true, projectId: true },
        }
      );
      if (state) {
        resolvedOpportunityId = state.opportunityId;
        resolvedProjectId = state.projectId;
      }
    }
    return this._sentReply.model.engageSentReply.findFirst({
      where: {
        organizationId,
        opportunityId: resolvedOpportunityId,
        ...(resolvedProjectId !== undefined && {
          projectId: resolvedProjectId ?? null,
        }),
      },
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
            title: true,
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
    // null = extension confirmed the send but captured no permalink; the state
    // flip (markPublished) still applies and releaseURL stays null so the Sent
    // card offers the manual "submit link" flow.
    url: string | null,
    engageAuthor?: EngageAuthorProfile,
    // When markPublished is set (extension publish-on-success path), also flip the
    // post DRAFT→PUBLISHED in the same write. The human manual-paste path leaves it
    // unset: its post is already PUBLISHED (created so by confirmManualReply), so a
    // backfill there only fills the URL.
    opts: { markPublished?: boolean } = {}
  ) {
    // Join the opportunity for its platform: X gets releaseId derived from the
    // tweet URL so metrics sync can read it, X/Reddit get author enrichment
    // merged into settings — everything below is genuinely platform-specific
    // enrichment, gated per-branch, not a reason to refuse the write outright.
    // The caller (service) has already validated the URL matches this
    // platform via _validateReplyUrl; this only guards against an opportunity
    // whose platform fell outside SCANNABLE_PLATFORMS entirely.
    const reply = await this._sentReply.model.engageSentReply.findFirst({
      where: { id: sentReplyId, organizationId },
      include: { opportunity: { select: { platform: true } } },
    });
    if (!reply) throw new NotFoundException('Sent reply not found');
    const platform = reply.opportunity.platform;
    if (!(SCANNABLE_PLATFORMS as readonly string[]).includes(platform)) {
      throw new BadRequestException(
        `Reply-URL backfill is not supported for platform "${platform}"`
      );
    }
    const releaseId =
      platform === 'x' && url ? parseXTweetId(url) ?? undefined : undefined;

    // If this X reply was recorded without a connected account, the freshly
    // supplied URL lets us resolve the author's integration now (handle match)
    // so metrics sync can finally read it. Only fill when currently null —
    // never override an account the user explicitly chose at confirm time.
    let integrationId: string | undefined;
    let mergedSettings: string | undefined;
    // One read serves both jobs below, on every platform. It used to sit inside
    // an `if (platform === 'x') ... else if (platform === 'reddit')` chain,
    // which meant a hackernews/quora/linkedin/medium/devto reply had its author
    // SILENTLY DROPPED even when the extension had captured and sent one — the
    // caller supplied ground truth and the write threw it away.
    if (engageAuthor || (platform === 'x' && url)) {
      const post = await this._post.model.post.findUnique({
        where: { id: reply.postId },
        select: { integrationId: true, settings: true },
      });

      // X ONLY: an OAuth account can be matched back from the reply URL's
      // handle, so a reply recorded without one can still gain the integration
      // its metrics sync needs. No other engage platform has an integration to
      // resolve — this genuinely is X-specific, unlike the author recording.
      if (platform === 'x' && url && !post?.integrationId) {
        integrationId =
          (await this.resolveXReplyIntegrationId(organizationId, url))
            ?.integrationId ?? undefined;
      }

      // Record the actual poster whenever one is supplied, on ANY platform. The
      // browser extension posts as the logged-in session, which can differ from
      // the selected integration — that real author is ground truth, so it is
      // stored even when an integration is linked. Without an explicit author
      // the old behaviour stands: settings untouched, and the integration (or a
      // later background lookup) speaks for the reply.
      if (engageAuthor) {
        mergedSettings = this._mergeEngageAuthor(
          post?.settings,
          platform,
          engageAuthor
        );
      }
    }

    return this._post.model.post.update({
      where: { id: reply.postId },
      data: {
        // Empty/absent URL persists as null (never '') so every "awaiting its
        // link" check — which tests releaseURL for null — keeps working.
        releaseURL: url || null,
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
        projectId: true,
        post: { select: { state: true, releaseURL: true } },
        opportunity: { select: { platform: true } },
      },
    });
    if (!reply) return null;
    return {
      sentReplyId: reply.id,
      postId: reply.postId,
      opportunityId: reply.opportunityId,
      projectId: reply.projectId,
      state: reply.post?.state ?? null,
      releaseURL: reply.post?.releaseURL ?? null,
      platform: reply.opportunity?.platform ?? null,
    };
  }

  /**
   * Record that the platform removed a reply we posted, and stop the
   * opportunity from being handed out again.
   *
   * Three writes, and each is deliberately NOT the obvious alternative:
   *
   *   Post.state → PUBLISHED, keeping releaseURL. The reply WAS published; the
   *     platform removed it afterwards. Not ERROR — that is `retryPost`'s
   *     precondition, so it would offer to re-send content that was just
   *     removed, and `changeState(ERROR)` nulls releaseId, discarding the id
   *     needed to investigate. Not DRAFT either: that reads as "never sent" and
   *     invites a duplicate.
   *
   *   removedAt / removedReason on the reply. What the platform did afterwards
   *     is an engage-domain fact, not a state of our publish.
   *
   *   Opportunity → DISMISSED. Not left NEW: an opportunity is one specific
   *     post in one specific community, so re-offering it means posting into
   *     the same rule that just removed us — another write and another exposure
   *     of the account for an outcome already observed. Not REPLIED: that
   *     asserts a reply is standing there, which is the belief this whole path
   *     exists to correct.
   *
   * Nothing is charged here, because publishExtensionReply is never reached.
   */
  async markSentReplyRemoved(
    organizationId: string,
    sentReplyId: string,
    reason: string,
    url?: string | null
  ) {
    const reply = await this._sentReply.model.engageSentReply.findFirst({
      where: { id: sentReplyId, organizationId },
      select: { id: true, postId: true, opportunityId: true, projectId: true },
    });
    if (!reply) throw new NotFoundException('Sent reply not found');

    await this._sentReply.model.engageSentReply.update({
      where: { id: reply.id },
      data: { removedAt: new Date(), removedReason: reason },
    });

    await this._post.model.post.update({
      where: { id: reply.postId },
      data: {
        state: 'PUBLISHED',
        // Only when the extension captured one — never overwrite a stored URL
        // with an empty string.
        ...(url ? { releaseURL: url } : {}),
      },
    });

    // Best-effort, and last: the removal is recorded either way. updateMany
    // rather than update so a state row that has already moved on (a concurrent
    // claim, an expiry) is a no-op instead of a throw.
    await this._oppState.model.engageOpportunityState.updateMany({
      where: {
        organizationId,
        projectId: reply.projectId ?? null,
        opportunityId: reply.opportunityId,
      },
      data: { status: 'DISMISSED' },
    });

    return { id: reply.id, removed: true, reason };
  }

  /**
   * Patch ONLY settings.engageAuthor for a sent reply's post — the
   * display-only author/avatar enrichment the confirm + backfill paths resolve
   * out of band (the URL is saved synchronously; this fills the author once the
   * platform finally answers, or once a caller hands one over).
   *
   * Works on EVERY engage platform. It used to bail on anything that was not X
   * or Reddit, so a hackernews/quora/linkedin/medium/devto reply could never
   * record who posted it — not even when the caller already knew.
   *
   * The one platform rule that remains is X's, and it is a real semantic, not a
   * gate: a connected X integration IS the author, so settings are left alone
   * rather than shadowed by a second identity. Everywhere else there is no
   * integration to speak for the reply, so the supplied author is recorded.
   *
   * No-ops (returns undefined) when the reply or post is gone — a background
   * enrich must never throw.
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

    const post = await this._post.model.post.findUnique({
      where: { id: reply.postId },
      select: { integrationId: true, settings: true },
    });
    if (!post) return undefined;
    // X: a connected integration is the source of truth — leave settings untouched.
    if (platform === 'x' && post.integrationId) return undefined;

    const mergedSettings = this._mergeEngageAuthor(
      post.settings,
      platform,
      engageAuthor
    );
    return this._post.model.post.update({
      where: { id: reply.postId },
      data: { settings: mergedSettings },
    });
  }

  /** Merge engageAuthor into a Post.settings JSON string, preserving __type and any
   *  other keys; tolerant of null/unparseable input. */
  private _mergeEngageAuthor(
    settings: string | null | undefined,
    type: string,
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

  /**
   * Media URLs (external CDN — X/Reddit/etc, not yet re-hosted) attached to
   * an opportunity's original post, for the opt-in reference-post media reuse
   * path (docs/engage/reference-post-generation.md §6.1). A dedicated,
   * narrowly-`select`ed query rather than exposing `rawData` on the general
   * opportunity fetch path (_merge deliberately omits it — "bloats every
   * _merge-based response", see opportunityMediaUrls' own comment) — this
   * one extra query is paid only when a caller actually opts into media.
   */
  async getOpportunityMediaUrls(opportunityId: string): Promise<string[]> {
    const row = await this._opportunity.model.engageOpportunity.findUnique({
      where: { id: opportunityId },
      select: { rawData: true },
    });
    return opportunityMediaUrls(row?.rawData);
  }

  /**
   * Attach reference-post provenance to a just-created Post: the queryable FK
   * column plus a content snapshot merged into settings (durable display/audit
   * — EngageOpportunity rows can be hard-deleted or drift on re-scan, see
   * docs/engage/reference-post-generation.md §4). `createPost`'s own return
   * value carries no `settings`, hence the read-then-merge instead of a
   * blind overwrite (same tolerant-merge shape as _mergeEngageAuthor).
   */
  async attachReferenceOpportunity(
    postId: string,
    snapshot: {
      opportunityId: string;
      platform: string;
      externalPostUrl: string;
      authorUsername: string;
      snapshotTitle: string | null;
      snapshotContent: string;
    }
  ) {
    const post = await this._post.model.post.findUnique({
      where: { id: postId },
      select: { settings: true },
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(post?.settings ?? '{}') ?? {};
    } catch {
      /* keep {} on unparseable settings */
    }
    return this._post.model.post.update({
      where: { id: postId },
      data: {
        referenceOpportunityId: snapshot.opportunityId,
        settings: JSON.stringify({
          ...parsed,
          referenceOpportunity: snapshot,
        }),
      },
    });
  }

  // Lightweight status of a single sent reply — for the frontends to poll while
  // an in-browser extension reply posts + self-backfills its permalink. Success
  // is signalled by `replyUrl` (Post.releaseURL) flipping non-null; the Post is
  // already PUBLISHED at creation time, so state alone can't be the signal.
  async getSentReplyStatus(organizationId: string, sentReplyId: string) {
    const reply = await this._sentReply.model.engageSentReply.findFirst({
      where: { id: sentReplyId, organizationId },
      select: {
        id: true,
        post: { select: { state: true, releaseURL: true } },
        opportunity: { select: { externalPostUrl: true } },
      },
    });
    if (!reply) throw new NotFoundException('Sent reply not found');
    return {
      id: reply.id,
      state: reply.post?.state ?? null,
      replyUrl: reply.post?.releaseURL ?? null,
      // The CURRENT address of the post being replied to. The extension holds
      // its own copy from when the reply was drafted, and a manual retry of an
      // old failure would otherwise re-send to an address that has since been
      // repaired — failing again for a reason that no longer exists.
      targetUrl: reply.opportunity?.externalPostUrl ?? null,
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
        // Removed replies keep state=PUBLISHED and impressions=null forever, so
        // without this they are permanent residents of the "pending metrics"
        // set: re-fetched on every resync, never resolvable.
        removedAt: null,
        post: {
          source: 'engage',
          state: 'PUBLISHED',
          releaseURL: { not: null },
          impressions: null,
        },
        ...(platform ? { opportunity: { platform } } : {}),
      },
      select: {
        id: true,
        organizationId: true,
        authorReplied: true,
        post: { select: { id: true, releaseURL: true, integrationId: true } },
        opportunity: {
          select: {
            platform: true,
            externalPostId: true,
            authorUsername: true,
          },
        },
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
  async findEngageRepliesInWindow(
    sinceDays: number,
    orgId?: string,
    platform?: string
  ) {
    const cutoff = dayjs
      .utc()
      .subtract(sinceDays, 'day')
      .startOf('day')
      .toDate();
    return this._sentReply.model.engageSentReply.findMany({
      where: {
        ...(orgId ? { organizationId: orgId } : {}),
        // Same reason as findPendingEngageMetrics: a removed reply has no
        // counters to fetch, so re-polling it daily only spends platform calls.
        removedAt: null,
        post: {
          source: 'engage',
          state: 'PUBLISHED',
          releaseURL: { not: null },
          publishDate: { gte: cutoff },
        },
        ...(platform ? { opportunity: { platform } } : {}),
      },
      select: {
        id: true,
        organizationId: true,
        authorReplied: true,
        post: { select: { id: true, releaseURL: true, integrationId: true } },
        opportunity: {
          select: {
            platform: true,
            externalPostId: true,
            authorUsername: true,
          },
        },
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
        // A removed reply keeps state=PUBLISHED (it WAS published), so it would
        // otherwise stay a metrics candidate forever: every refresh spends a
        // platform call fetching counters for a comment nobody can read, and
        // gets nothing back. Skipped here rather than deeper down so it never
        // consumes the per-platform hourly budget either.
        removedAt: null,
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
          select: {
            platform: true,
            externalPostId: true,
            authorUsername: true,
          },
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
    const items: Array<{
      postId: string;
      integrationId: string;
      matchedBy: string;
    }> = [];

    for (const r of pending) {
      if (!r.post) continue;
      const pick = await this.resolveXReplyIntegrationId(
        organizationId,
        r.post.releaseURL
      );
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
      items.push({
        postId: r.post.id,
        integrationId: pick.integrationId,
        matchedBy: pick.matchedBy,
      });
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
    for (const s of Object.values(stats))
      s.totalTrafficScore = Math.round(s.totalTrafficScore);
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

  /**
   * A manual reply confirmed on any platform that is NOT X — reddit, hackernews,
   * quora, linkedin, medium, devto. X has its own path (createManualXPost)
   * because only there is a reply bound to a connected OAuth account, whose
   * token drives the metrics sync.
   *
   * `platform` is REQUIRED, and it is the whole point of this signature. The
   * method used to be `createManualRedditPost` and hard-coded `'reddit'`, so a
   * Hacker News reply was persisted as a reddit Post whose releaseURL pointed at
   * news.ycombinator.com — mislabelled everywhere the admin list, the calendar
   * and the platform write clock filter on `providerIdentifier`. Taking the
   * platform as an argument makes the caller say which one it is.
   */
  async createManualCommunityPost(data: {
    organizationId: string;
    platform: string;
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
        providerIdentifier: data.platform,
        // These platforms never have an integration, so engageAuthor (the
        // account that posted the reply) is the source of truth when known.
        settings: JSON.stringify({
          __type: data.platform,
          ...(data.engageAuthor ? { engageAuthor: data.engageAuthor } : {}),
        }),
        group: randomUUID(),
        delay: 0,
        ...(data.replyUrl ? { releaseURL: data.replyUrl } : {}),
        // Project attribution, so the manual reply's Post row is filtered/counted
        // by project like every other engage post (matches the EngageSentReply
        // row's projectId written by confirmManualReply).
        ...(data.projectId ? { projectId: data.projectId } : {}),
        // integrationId intentionally omitted: these platforms have no integration
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
        // Plural now — see listReplyAccountIntegrations's note (a
        // global UNIQUE(integrationId) no longer exists). Scoped to THIS
        // project's config so at most one row comes back per integration.
        integrationProjects: {
          where: { projectId: projectId ?? undefined },
          select: { engageEnabled: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return pickXReplyIntegration(
      liveX.map((i) => ({
        id: i.id,
        profile: i.profile,
        // Absent binding = never excluded. Previously this defaulted to FALSE,
        // which was harmless only because pickXReplyIntegration ignores the flag
        // entirely (it matches by handle) — keep the honest default now that the
        // field has one meaning everywhere.
        engageEnabled: i.integrationProjects?.[0]?.engageEnabled ?? true,
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
        throw new NotFoundException(
          'X integration not found for this organization'
        );
      }
    } else {
      // No account picked: resolve one so metrics aren't stuck null forever.
      // Prefer the tweet author's own integration (by handle) so impressions are
      // readable; else the org's engage reply account; else any live X account.
      integrationId =
        (
          await this.resolveXReplyIntegrationId(
            data.organizationId,
            data.replyUrl
          )
        )?.integrationId ?? undefined;
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
        providerIdentifier: 'x',
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
        // Project attribution — see createManualCommunityPost's note.
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
    const config = await this._tx.model.$transaction(async (tx) => {
      const config =
        projectId != null
          ? await tx.engageConfig.upsert({
              where: {
                organizationId_projectId: { organizationId, projectId },
              },
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

      // Channels and accounts land in the SAME table — two createMany calls only
      // because the DTO still carries them as two lists. BOTH go through
      // buildScanTargetKey, the same boundary the per-row add endpoints use:
      // this path takes the same externally-supplied DTO and writes the same
      // table, so skipping the scope + charset guards here (as it did) let a
      // `monitoredChannels` entry on platform `x` become a tracked target whose
      // key reached the shared X `from:` query unescaped.
      if (dto.monitoredChannels?.length) {
        await tx.engageTrackedAccount.createMany({
          data: dto.monitoredChannels.map((ch) => {
            const { platform, username } = buildScanTargetKey(
              ch.platform,
              ch.channelId,
              'channel'
            );
            return {
              configId: config.id,
              organizationId,
              platform,
              username,
              displayName: ch.channelName,
              audienceSize: ch.audienceSize ?? 0,
              ...(ch.metadata && {
                metadata: ch.metadata as Prisma.InputJsonValue,
              }),
            };
          }),
          skipDuplicates: true,
        });
      }

      if (dto.trackedAccounts?.length) {
        await tx.engageTrackedAccount.createMany({
          data: dto.trackedAccounts.map((acc) => {
            const { platform, username } = buildScanTargetKey(
              acc.platform ?? 'x',
              acc.username,
              'tracked'
            );
            return {
              configId: config.id,
              organizationId,
              platform,
              username,
              ...(acc.picture && { picture: acc.picture }),
              ...(acc.categoryLabel && { categoryLabel: acc.categoryLabel }),
            };
          }),
          skipDuplicates: true,
        });
      }

      return config;
    });

    // Fast-lane hint, raised AFTER the commit — never inside the transaction.
    // A hint the extension acts on mid-transaction would have it claim against
    // rows it cannot see yet, find nothing, and retract the hint, parking this
    // setup's units on the 15-min backstop — the exact opposite of the point.
    // (clearEngageScanWork's token check narrows that race but does not remove
    // the reason to mark late.)
    const setupCreatesUnit =
      (dto.keywords ?? []).some((kw) => kw.enabled ?? true) ||
      Boolean(dto.monitoredChannels?.length) ||
      Boolean(dto.trackedAccounts?.length);
    if (setupCreatesUnit) await markEngageScanWork(organizationId);

    return config;
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

  /**
   * Accounts Engage may reply as whose underlying integration is dead (needs a
   * re-auth, or is disabled) — a silent failure: the account still shows as
   * selectable while every send through it fails.
   *
   * Reads the project binding now that engageEnabled lives there. Rows for a
   * soft-deleted integration are excluded: that is a removed account, not a
   * broken one.
   */
  async findDeadReplyAccounts() {
    return this._integrationProject.model.integrationProject.findMany({
      where: {
        engageEnabled: true,
        integration: {
          deletedAt: null,
          OR: [{ refreshNeeded: true }, { disabled: true }],
        },
      },
      select: {
        id: true,
        organizationId: true,
        projectId: true,
        integrationId: true,
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
        post: {
          select: { id: true, state: true, error: true, createdAt: true },
        },
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

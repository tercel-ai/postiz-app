import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

// ─── Billing categories & prices ────────────────────────────────────────────
// READ categories are billed per RETURNED RECORD; WRITE categories per REQUEST.
// $1 = 100 credits. Prices live here (optionally overridable via Settings), never
// in the ApiUsageTick rows, so historical cost is recomputable without backfill.
export type ApiUsagePlatform = 'x' | 'reddit';

// X category keys — keep stable; they are persisted in ApiUsageTick.category.
export const X_USAGE = {
  // ── reads (billed per returned resource) ──
  POSTS_READ: 'posts_read',
  USER_READ: 'user_read',
  OWNED_READ: 'owned_read',
  LIKE_READ: 'like_read',
  MUTE_READ: 'mute_read',
  BLOCK_READ: 'block_read',
  DM_EVENT_READ: 'dm_event_read',
  FOLLOWING_FOLLOWERS_READ: 'following_followers_read',
  LIST_READ: 'list_read',
  SPACE_READ: 'space_read',
  COMMUNITY_READ: 'community_read',
  NOTE_READ: 'note_read',
  PROFILE_UPDATE_READ: 'profile_update_read',
  // ── writes (billed per request) ──
  POST_CREATE: 'post_create',
  POST_CREATE_URL: 'post_create_url',
  POST_CREATE_SUMMONED: 'post_create_summoned',
  USER_INTERACTION_CREATE: 'user_interaction_create',
  DM_INTERACTION_CREATE: 'dm_interaction_create',
  INTERACTION_DELETE: 'interaction_delete',
  LIST_CREATE: 'list_create',
  TRENDS: 'trends',
} as const;

// ─── Business-semantic categories ───────────────────────────────────────────
// Orthogonal to the X billing `category` above: the SAME billed unit is also
// classified by what business action triggered it. Threaded via runWithBizUsage
// at the business entry points (the deep provider calls inherit it), then
// persisted in ApiBizUsageTick(date, org, platform, bizCategory, category).
// Platform-agnostic on purpose — engage scan/reply/metrics apply to Reddit too.
export const BIZ_USAGE = {
  POST_PUBLISH: 'post_publish', // active publishing (Post.source = 'calendar')
  ENGAGE_REPLY: 'engage_reply', // engage reply (Post.source = 'engage')
  POST_METRICS: 'post_metrics', // metrics monitoring for active posts
  ENGAGE_METRICS: 'engage_metrics', // metrics monitoring for engage replies
  ENGAGE_SCAN: 'engage_scan', // engage opportunity discovery scan
  USER_LOOKUP: 'user_lookup', // standalone user-info query
  ENGAGE_AUTHOR_ENRICH: 'engage_author_enrich', // reply author profile/avatar
  AUTO_REPOST: 'auto_repost', // auto-repost automation
  AUTO_PLUG: 'auto_plug', // auto-plug automation
  ACCOUNT_METRICS: 'account_metrics', // account-level (not per-post) metrics
  MENTION_SCAN: 'mention_scan', // mention monitoring
} as const;

export type BizCategory = (typeof BIZ_USAGE)[keyof typeof BIZ_USAGE];

// Fixed, non-overlapping engage score bands. Lower-exclusive / upper-inclusive
// except the first (0-inclusive). The top band is a catch-all that also covers
// 101-105 (the scorer's true max), so no scored post is ever dropped.
export const ENGAGE_SCORE_BUCKETS = [
  '0-50',
  '50-60',
  '60-70',
  '70-85',
  '85-100',
] as const;
export type EngageScoreBucket = (typeof ENGAGE_SCORE_BUCKETS)[number];
export type EngageScorePhase = 'scanned' | 'persisted';

export function engageScoreBucket(score: number): EngageScoreBucket {
  if (score <= 50) return '0-50';
  if (score <= 60) return '50-60';
  if (score <= 70) return '60-70';
  if (score <= 85) return '70-85';
  return '85-100'; // catch-all: 85 < score (incl. 86-105)
}

// USD per unit (record for reads, request for writes).
export const API_PRICE_USD: Record<string, Record<string, number>> = {
  // Full mirror of https://docs.x.com/x-api/getting-started/pricing. Categories
  // without a recorder yet are kept here so a future call site is never silently
  // priced at $0 (priceFor falls back to 0 only for genuinely unknown keys).
  x: {
    // reads — per resource
    [X_USAGE.POSTS_READ]: 0.005, // Posts
    [X_USAGE.USER_READ]: 0.01, // User
    [X_USAGE.OWNED_READ]: 0.001, // Owned Reads (your own /2/users/{id}/* data)
    [X_USAGE.LIKE_READ]: 0.001, // Like
    [X_USAGE.MUTE_READ]: 0.001, // Mute
    [X_USAGE.BLOCK_READ]: 0.001, // Block
    [X_USAGE.DM_EVENT_READ]: 0.01, // DM Event
    [X_USAGE.FOLLOWING_FOLLOWERS_READ]: 0.01, // Following / Followers
    [X_USAGE.LIST_READ]: 0.005, // List
    [X_USAGE.SPACE_READ]: 0.005, // Space
    [X_USAGE.COMMUNITY_READ]: 0.005, // Community
    [X_USAGE.NOTE_READ]: 0.005, // Note
    [X_USAGE.PROFILE_UPDATE_READ]: 0.005, // Profile Update
    // writes — per request
    [X_USAGE.POST_CREATE]: 0.015, // Post: Create
    [X_USAGE.POST_CREATE_URL]: 0.2, // Post: Create (with URL)
    [X_USAGE.POST_CREATE_SUMMONED]: 0.01, // Post: Create (summoned)
    [X_USAGE.USER_INTERACTION_CREATE]: 0.015, // User Interaction Create (retweet/like/follow)
    [X_USAGE.DM_INTERACTION_CREATE]: 0.015, // DM Interaction Create
    [X_USAGE.INTERACTION_DELETE]: 0.01, // Interaction Delete
    [X_USAGE.LIST_CREATE]: 0.01, // List Create
    [X_USAGE.TRENDS]: 0.01, // Trends
  },
  // reddit: { ... }  // fill in when Reddit cost tracking is added
};

export function priceFor(platform: string, category: string): number {
  return API_PRICE_USD[platform]?.[category] ?? 0;
}


/**
 * True when `userId` is the X account that owns this developer app
 * (env X_APP_OWNER_USER_ID). Reads of the owner's OWN data are billed by X at
 * the discounted "Owned Reads" rate, so call sites that read a connected
 * account's own data use this to pick owned_read vs the standard read category.
 * Always false when the env is unset (no owner configured → nothing is owned).
 */
export function isXAppOwner(userId?: string | number | null): boolean {
  const owner = process.env.X_APP_OWNER_USER_ID;
  return !!owner && userId != null && String(userId) === owner;
}

// UTC midnight bucket for `date`. Stable per calendar day so upserts collapse to
// one row per (day, platform, category).
function dayBucket(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}

@Injectable()
export class ApiUsageService {
  private readonly _logger = new Logger(ApiUsageService.name);

  constructor(private readonly _prisma: PrismaService) {
    // Register as the process-wide recorder so pure helper functions (which have
    // no DI) can record via the `recordApiUsage` free function below.
    setApiUsageRecorder(this);
  }

  /**
   * Increment a (today, platform, category) counter by `quantity`. Atomic upsert
   * — safe under concurrency and across processes (unique key does the merge).
   * Fire-and-forget by contract: NEVER throws and NEVER blocks the caller's API
   * operation. A non-positive quantity is a no-op.
   */
  async record(
    platform: string,
    category: string,
    quantity: number,
    when: Date = new Date(),
    biz?: BizUsageContext
  ): Promise<void> {
    if (!quantity || quantity <= 0) return;
    const date = dayBucket(when);
    try {
      await this._prisma.apiUsageTick.upsert({
        where: { date_platform_category: { date, platform, category } },
        create: { date, platform, category, quantity: BigInt(quantity) },
        update: { quantity: { increment: BigInt(quantity) } },
      });
    } catch (err) {
      // Cost telemetry must never break the real operation; just log.
      this._logger.warn(
        `apiUsage record failed (${platform}/${category} +${quantity}): ${String(
          err
        )}`
      );
    }

    // Mirror the same unit under its business purpose when a context is active.
    // Independent of the cost upsert above: a failure in one must not skip the
    // other, and either may legitimately be unwired in some processes.
    if (biz?.bizCategory) {
      const organizationId = biz.organizationId ?? '';
      try {
        await this._prisma.apiBizUsageTick.upsert({
          where: {
            date_organizationId_platform_bizCategory_category: {
              date,
              organizationId,
              platform,
              bizCategory: biz.bizCategory,
              category,
            },
          },
          create: {
            date,
            organizationId,
            platform,
            bizCategory: biz.bizCategory,
            category,
            quantity: BigInt(quantity),
          },
          update: { quantity: { increment: BigInt(quantity) } },
        });
      } catch (err) {
        this._logger.warn(
          `apiBizUsage record failed (${platform}/${biz.bizCategory}/${category} +${quantity}): ${String(
            err
          )}`
        );
      }
    }
  }

  /**
   * Record an engage score distribution for one org/platform/phase: bucket the
   * raw scores and increment per-band counters. Fire-and-forget by contract —
   * never throws, never blocks the scan/ingest. `phase` separates 'scanned'
   * (every keyword-matched scored post) from 'persisted' (the >= MIN_SCORE
   * subset stored as opportunities).
   */
  async recordScores(
    organizationId: string,
    platform: string,
    phase: EngageScorePhase,
    scores: number[],
    when: Date = new Date()
  ): Promise<void> {
    if (!scores.length) return;
    const counts = new Map<string, number>();
    for (const s of scores) {
      const bucket = engageScoreBucket(s);
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    const date = dayBucket(when);
    for (const [bucket, quantity] of counts) {
      try {
        await this._prisma.engageScoreTick.upsert({
          where: {
            date_organizationId_platform_phase_bucket: {
              date,
              organizationId,
              platform,
              phase,
              bucket,
            },
          },
          create: {
            date,
            organizationId,
            platform,
            phase,
            bucket,
            quantity: BigInt(quantity),
          },
          update: { quantity: { increment: BigInt(quantity) } },
        });
      } catch (err) {
        this._logger.warn(
          `engageScore record failed (${organizationId}/${platform}/${phase}/${bucket} +${quantity}): ${String(
            err
          )}`
        );
      }
    }
  }

  /**
   * Cost report over [from, to) (UTC), grouped by platform+category, with USD
   * cost = quantity * price. Internal/admin use; not user-facing.
   */
  async report(
    from: Date,
    to: Date
  ): Promise<{
    items: {
      platform: string;
      category: string;
      quantity: number;
      costUsd: number;
    }[];
    totalUsd: number;
  }> {
    const rows = await this._prisma.apiUsageTick.groupBy({
      by: ['platform', 'category'],
      where: { date: { gte: dayBucket(from), lt: dayBucket(to) } },
      _sum: { quantity: true },
    });
    const items = rows.map((r) => {
      const quantity = Number(r._sum.quantity ?? BigInt(0));
      return {
        platform: r.platform,
        category: r.category,
        quantity,
        costUsd: quantity * priceFor(r.platform, r.category),
      };
    });
    return {
      items,
      totalUsd: items.reduce((s, i) => s + i.costUsd, 0),
    };
  }

  /**
   * Per-day, per-category cost trend over [from, to) (UTC). Returns one row per
   * (date, platform, category) so the admin UI can either sum across categories
   * (the "All" line) or filter to one category (the X-style dropdown). Sorted by
   * date asc. Internal/admin use.
   */
  async reportDaily(
    from: Date,
    to: Date
  ): Promise<
    {
      date: string;
      platform: string;
      category: string;
      quantity: number;
      costUsd: number;
    }[]
  > {
    const rows = await this._prisma.apiUsageTick.groupBy({
      by: ['date', 'platform', 'category'],
      where: { date: { gte: dayBucket(from), lt: dayBucket(to) } },
      _sum: { quantity: true },
    });
    return rows
      .map((r) => {
        const quantity = Number(r._sum.quantity ?? BigInt(0));
        return {
          date: r.date.toISOString().slice(0, 10), // YYYY-MM-DD
          platform: r.platform,
          category: r.category,
          quantity,
          costUsd: quantity * priceFor(r.platform, r.category),
        };
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  /**
   * Business-purpose cost report over [from, to) (UTC), grouped by
   * org+platform+bizCategory+category, with USD cost reusing the X price map.
   * Pass `organizationId` to scope to one org (omit for all orgs / system).
   * Internal/admin use.
   */
  async reportBiz(
    from: Date,
    to: Date,
    organizationId?: string
  ): Promise<{
    items: {
      organizationId: string;
      platform: string;
      bizCategory: string;
      category: string;
      quantity: number;
      costUsd: number;
    }[];
    totalUsd: number;
  }> {
    const rows = await this._prisma.apiBizUsageTick.groupBy({
      by: ['organizationId', 'platform', 'bizCategory', 'category'],
      where: {
        date: { gte: dayBucket(from), lt: dayBucket(to) },
        ...(organizationId != null ? { organizationId } : {}),
      },
      _sum: { quantity: true },
    });
    const items = rows.map((r) => {
      const quantity = Number(r._sum.quantity ?? BigInt(0));
      return {
        organizationId: r.organizationId,
        platform: r.platform,
        bizCategory: r.bizCategory,
        category: r.category,
        quantity,
        costUsd: quantity * priceFor(r.platform, r.category),
      };
    });
    return {
      items,
      totalUsd: items.reduce((s, i) => s + i.costUsd, 0),
    };
  }

  /**
   * Engage score distribution over [from, to) (UTC), grouped by
   * org+platform+phase+bucket. Pass `organizationId` to scope to one org.
   * Internal/admin use.
   */
  async reportScores(
    from: Date,
    to: Date,
    organizationId?: string
  ): Promise<
    {
      organizationId: string;
      platform: string;
      phase: string;
      bucket: string;
      quantity: number;
    }[]
  > {
    const rows = await this._prisma.engageScoreTick.groupBy({
      by: ['organizationId', 'platform', 'phase', 'bucket'],
      where: {
        date: { gte: dayBucket(from), lt: dayBucket(to) },
        ...(organizationId != null ? { organizationId } : {}),
      },
      _sum: { quantity: true },
    });
    return rows.map((r) => ({
      organizationId: r.organizationId,
      platform: r.platform,
      phase: r.phase,
      bucket: r.bucket,
      quantity: Number(r._sum.quantity ?? BigInt(0)),
    }));
  }
}

// ─── Process-wide recorder for DI-less call sites ───────────────────────────
// The leaf X helpers (x-tweet.ts, engage-metrics-sync.ts) and the stateless scan
// adapter are pure functions with no Nest DI. They call `recordApiUsage(...)`,
// which forwards to the singleton ApiUsageService once it has been constructed.
// Before init (e.g. unit tests, or a process that never loads DatabaseModule) it
// is a safe no-op — usage is simply not recorded, never an error.
let _recorder: ApiUsageService | null = null;

function setApiUsageRecorder(svc: ApiUsageService): void {
  _recorder = svc;
}

// ─── Business-purpose context (AsyncLocalStorage) ───────────────────────────
// The business entry points (controllers, Temporal activities) wrap their work
// in `runWithBizUsage`; every X/Reddit call made within that async scope — no
// matter how deep in the provider — has its recorded units automatically also
// attributed to (organizationId, bizCategory) via getBizUsageContext below.
// This keeps the deep recordApiUsage call sites untouched. Works within a single
// process/call stack only (which is exactly where a provider call executes).
export interface BizUsageContext {
  organizationId?: string; // '' / undefined ⇒ stored as '' (system / no org)
  bizCategory: string; // one of BIZ_USAGE
}

const _bizContext = new AsyncLocalStorage<BizUsageContext>();

/** Run `fn` with a business-usage context active for all nested API calls. */
export function runWithBizUsage<T>(ctx: BizUsageContext, fn: () => T): T {
  return _bizContext.run(ctx, fn);
}

/** The business-usage context active on the current async stack, if any. */
export function getBizUsageContext(): BizUsageContext | undefined {
  return _bizContext.getStore();
}

export function recordApiUsage(
  platform: string,
  category: string,
  quantity: number
): void {
  // Capture the business context synchronously at the call site (still inside
  // the runWithBizUsage scope) before the async record() detaches it.
  const biz = getBizUsageContext();
  // Fire-and-forget: do not await, do not surface errors to the caller.
  void _recorder?.record(platform, category, quantity, undefined, biz);
}

/**
 * Record an engage score distribution (DI-less entry point, mirrors
 * recordApiUsage). Buckets `scores` and increments per-band counters for the
 * given org/platform/phase. Safe no-op before the recorder is constructed.
 */
export function recordEngageScores(
  organizationId: string,
  platform: string,
  phase: EngageScorePhase,
  scores: number[]
): void {
  void _recorder?.recordScores(organizationId, platform, phase, scores);
}

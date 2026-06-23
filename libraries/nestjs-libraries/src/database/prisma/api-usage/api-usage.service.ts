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
    when: Date = new Date()
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

export function recordApiUsage(
  platform: string,
  category: string,
  quantity: number
): void {
  // Fire-and-forget: do not await, do not surface errors to the caller.
  void _recorder?.record(platform, category, quantity);
}

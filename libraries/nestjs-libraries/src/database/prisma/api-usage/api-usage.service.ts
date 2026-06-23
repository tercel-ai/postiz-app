import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

// ─── Billing categories & prices ────────────────────────────────────────────
// READ categories are billed per RETURNED RECORD; WRITE categories per REQUEST.
// $1 = 100 credits. Prices live here (optionally overridable via Settings), never
// in the ApiUsageTick rows, so historical cost is recomputable without backfill.
export type ApiUsagePlatform = 'x' | 'reddit';

// X category keys — keep stable; they are persisted in ApiUsageTick.category.
export const X_USAGE = {
  POSTS_READ: 'posts_read',
  USER_READ: 'user_read',
  DM_FOLLOW_READ: 'dm_follow_read',
  LIST_SPACE_ETC: 'list_space_etc',
  LIKE_MUTE_BLOCK: 'like_mute_block',
  OWNED_READ: 'owned_read',
  POST_CREATE: 'post_create',
  POST_CREATE_URL: 'post_create_url',
  REPLY_QUOTE: 'reply_quote',
  INTERACTION_OTHER: 'interaction_other',
} as const;

// USD per unit (record for reads, request for writes).
export const API_PRICE_USD: Record<string, Record<string, number>> = {
  x: {
    [X_USAGE.POSTS_READ]: 0.005, // Posts: Read / record
    [X_USAGE.USER_READ]: 0.01, // User: Read / record
    [X_USAGE.DM_FOLLOW_READ]: 0.01, // DM Event / Following / Followers / record
    [X_USAGE.LIST_SPACE_ETC]: 0.005, // List / Space / Community / Note / record
    [X_USAGE.LIKE_MUTE_BLOCK]: 0.001, // Like / Mute / Block / record
    [X_USAGE.OWNED_READ]: 0.001, // Owned Reads / record
    [X_USAGE.POST_CREATE]: 0.015, // Post: Create / request
    [X_USAGE.POST_CREATE_URL]: 0.2, // Post: Create with URL / request
    [X_USAGE.REPLY_QUOTE]: 0.01, // Post Create (summoned reply/quote) / request
    [X_USAGE.INTERACTION_OTHER]: 0.015, // User Interaction Create (retweet, etc.) / request
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

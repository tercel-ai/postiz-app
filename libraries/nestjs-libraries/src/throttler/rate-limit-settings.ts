import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';

export const API_RATE_LIMITS_KEY = 'api_rate_limits';

/**
 * Named rate-limit buckets, one per throttled route family.
 *
 * Names, not raw numbers at the call site, because a limit is a product
 * decision that gets retuned from an incident channel at 2am — and until this
 * existed every one of them was a literal inside a decorator, changeable only by
 * a deploy. Every value is requests per hour, per user.
 */
export interface ApiRateLimits {
  /** `POST /posts` — the editor's save path (drafts and scheduled alike). */
  createPost: number;
  /** `POST /engage/opportunities/:id/draft` — one AI reply generation. */
  engageDraft: number;
  /** `POST /engage/opportunities/:id/generate-post` — one AI original post. */
  engageGeneratePost: number;
  /** `POST /engage/scan` — a manual, whole-org scan trigger. */
  engageScan: number;
  /** `POST /engage/opportunities/:id/target-gone` — a client-reported 404. */
  engageTargetGone: number;
  /** The engage admin resync/sync-metrics endpoints. */
  engageAdminSync: number;
  /** Both engage ingest endpoints — the extension's write-back path. */
  engageIngest: number;
}

export const DEFAULT_API_RATE_LIMITS: ApiRateLimits = {
  // Generous: a person saving a batch of posts in the editor is a normal burst,
  // and this limit exists to stop an automated flood, not to pace a human.
  createPost: 300,
  // Both AI paths are metered by credits as well; the throttle is only the
  // second line, bounding damage before a balance can even be drawn down.
  engageDraft: 20,
  engageGeneratePost: 20,
  // Whole-org work per call, so tight on purpose.
  engageScan: 5,
  engageTargetGone: 30,
  engageAdminSync: 5,
  // The extension's chained scan loop is one unit per round trip, paced by
  // interUnit (60s) — about 60 calls/hour per browser session. Sized for several
  // sessions plus retries; the per-org RECORD ceiling (engage_ingest_quota) is
  // what actually bounds the volume, this only bounds the request rate.
  engageIngest: 300,
};

/**
 * Last known values, read by the throttle resolvers below.
 *
 * Module-level because `@Throttle`'s resolvable receives only an
 * ExecutionContext — it has no route into the DI container — so the value has to
 * be somewhere a plain function can reach. Refreshed by the service below rather
 * than read per request: a settings round trip on every throttled call would put
 * the database on the hot path of the thing meant to protect it.
 */
let cached: ApiRateLimits = { ...DEFAULT_API_RATE_LIMITS };

/** Test seam; also how the service publishes a refreshed read. */
export function setApiRateLimits(next: Partial<ApiRateLimits>): void {
  cached = { ...DEFAULT_API_RATE_LIMITS, ...sanitize(next) };
}

export function getApiRateLimits(): ApiRateLimits {
  return cached;
}

/** Reset to defaults — for tests that must not leak a tuned value. */
export function resetApiRateLimits(): void {
  cached = { ...DEFAULT_API_RATE_LIMITS };
}

function sanitize(raw: Partial<ApiRateLimits> | null | undefined): Partial<ApiRateLimits> {
  const out: Partial<ApiRateLimits> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(DEFAULT_API_RATE_LIMITS) as (keyof ApiRateLimits)[]) {
    const value = (raw as Record<string, unknown>)[key];
    // A junk or non-positive value falls back to the default, never to
    // "unlimited" and never to 0 — a typo must not silently remove a limit, nor
    // lock every caller out of a route.
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      out[key] = Math.floor(value);
    }
  }
  return out;
}

/** One hour, in ms — the window every bucket above is expressed against. */
export const RATE_LIMIT_TTL_MS = 3_600_000;

/**
 * The value to hand `@Throttle({ default: { limit: limitFor('x'), ttl } })`.
 * A function, so the guard resolves it per request and a settings change takes
 * effect on the next call instead of the next deploy.
 */
export function limitFor(bucket: keyof ApiRateLimits): () => number {
  return () => getApiRateLimits()[bucket];
}

/**
 * Seeds `api_rate_limits` and keeps the module-level cache fresh.
 *
 * The refresh is a poll rather than an invalidation hook because the admin
 * console writes the row directly through the settings API; there is nothing to
 * hook, and a stale limit for under a minute is harmless for a backstop.
 */
@Injectable()
export class ApiRateLimitService implements OnModuleInit {
  private readonly logger = new Logger(ApiRateLimitService.name);
  private timer?: ReturnType<typeof setInterval>;

  static readonly REFRESH_MS = 60_000;

  constructor(private readonly _settings: SettingsService) {}

  async onModuleInit(): Promise<void> {
    const existing = await this._settings.get(API_RATE_LIMITS_KEY);
    if (existing === null || existing === undefined) {
      await this._settings.set(API_RATE_LIMITS_KEY, DEFAULT_API_RATE_LIMITS, {
        type: 'object',
        description:
          'Per-route request ceilings, in requests per hour per user. Enforced by ' +
          '@Throttle and shared across replicas via RedisThrottlerStorage. A junk ' +
          'or non-positive value falls back to that default, never to ' +
          'unlimited and never to 0.',
        defaultValue: DEFAULT_API_RATE_LIMITS,
      });
      this.logger.log(`Seeded default ${API_RATE_LIMITS_KEY}`);
    }
    await this.refresh();
    this.timer = setInterval(
      () => void this.refresh(),
      ApiRateLimitService.REFRESH_MS
    );
    // Never hold the process open for a cache refresh.
    this.timer.unref?.();
  }

  async refresh(): Promise<ApiRateLimits> {
    try {
      const stored = await this._settings.get<Partial<ApiRateLimits>>(
        API_RATE_LIMITS_KEY
      );
      setApiRateLimits(stored ?? {});
    } catch (err) {
      // Keep the last known values rather than snapping back to defaults: a
      // transient settings failure must not quietly widen a tuned-down limit.
      this.logger.error(
        `Failed to refresh ${API_RATE_LIMITS_KEY}; keeping the current values`,
        err as Error
      );
    }
    return getApiRateLimits();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

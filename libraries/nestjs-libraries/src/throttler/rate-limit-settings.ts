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

/**
 * The STORED shape. Differs from the resolved one in a single field, because
 * `engageIngest` is the one bucket that should not be a standalone number: the
 * extension's request rate is set by `engage_scan_pacing.extension.interUnit`,
 * so pinning a literal here means the two silently drift the moment anyone
 * retunes the client's pacing.
 */
export interface ApiRateLimitSettings
  extends Omit<ApiRateLimits, 'engageIngest'> {
  /** Explicit ceiling, or `null` (the default) to derive it — see below. */
  engageIngest: number | null;
  /**
   * Multiplier on the derived ingest rate: how many concurrent browser sessions
   * (plus retries) one org may have hitting the ingest endpoints.
   *
   * Ignored when `engageIngest` pins a number.
   */
  engageIngestAllowance: number;
}

/**
 * Requests/hour one browser session can make when it honours `interUnit`, if the
 * pacing config cannot be read at all.
 */
const FALLBACK_INGEST_PER_SESSION = 60;

export const DEFAULT_API_RATE_LIMIT_SETTINGS: ApiRateLimitSettings = {
  createPost: 300,
  engageDraft: 100,
  engageGeneratePost: 100,
  engageScan: 5,
  engageTargetGone: 30,
  engageAdminSync: 5,
  engageIngest: null,
  engageIngestAllowance: 5,
};

export const DEFAULT_API_RATE_LIMITS: ApiRateLimits = {
  // Generous: a person saving a batch of posts in the editor is a normal burst,
  // and this limit exists to stop an automated flood, not to pace a human.
  createPost: 300,
  // Both AI paths are metered by credits as well; the throttle is only the
  // second line, bounding damage before a balance can even be drawn down.
  //
  // engageDraft was 20 until measurement showed that was the one limit at real
  // risk of refusing paying work. Over 30 days the busiest org generated 28
  // reply drafts in a DAY, and generation is the one path here that legitimately
  // bursts: the unattended loop cannot (maxPerPoll 1, minGapMinutes 25), but a
  // person working through a feed easily lands a day's worth inside an hour.
  // 100/hour clears that peak with room, and still sits far under the business
  // gate that actually governs replies — engage_reply_account_daily_cap, 50 per
  // account per day. A throttle tighter than the quota it guards only refuses
  // requests the customer is paying credits for.
  //
  // engageGeneratePost is MATCHED to engageDraft, not measured. It has no
  // frontend entry point yet (docs/engage/reference-post-generation.md), so 30
  // days of billing records show zero calls — there is nothing to tune it from.
  // Given that, matching the one path of the same shape (user-driven, credit
  // metered, generated one at a time) beats inventing a third number with its
  // own unstated reasoning. Re-check it against the `engageGeneratePost` row in
  // scripts/analyze-write-limits.ts once the UI ships; the two paths may well
  // burst differently, since a reply is clicked while working a feed and an
  // original post tends to be composed deliberately.
  engageDraft: 100,
  engageGeneratePost: 100,
  // Whole-org work per call, so tight on purpose.
  engageScan: 5,
  engageTargetGone: 30,
  engageAdminSync: 5,
  // Only a fallback; the live value is derived per refresh. 60 requests/hour is
  // what one session honouring a 60s interUnit delay makes, times the default
  // allowance of 5. The per-org RECORD ceiling (engage_ingest_quota) is what
  // actually bounds the volume; this only bounds the request rate.
  engageIngest: FALLBACK_INGEST_PER_SESSION * 5,
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
      await this._settings.set(API_RATE_LIMITS_KEY, DEFAULT_API_RATE_LIMIT_SETTINGS, {
        type: 'object',
        description:
          'Per-route request ceilings, in requests per hour per user. Enforced by ' +
          '@Throttle on the HTTP route, so INTERNAL service calls (autopost, ' +
          'operation-plan materialization, engage) are not subject to them. ' +
          'Shared across replicas via RedisThrottlerStorage. engageIngest null = ' +
          'derive from engage_scan_pacing interUnit x engageIngestAllowance. A ' +
          'junk or non-positive value falls back to that default, never to ' +
          'unlimited and never to 0.',
        defaultValue: DEFAULT_API_RATE_LIMIT_SETTINGS,
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
      const stored = await this._settings.get<Partial<ApiRateLimitSettings>>(
        API_RATE_LIMITS_KEY
      );
      setApiRateLimits({
        ...(stored ?? {}),
        engageIngest: await this._resolveIngestLimit(stored ?? {}),
      });
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

  /**
   * Requests/hour for the ingest endpoints: the pinned value if an admin set
   * one, else derived from the pacing the extension is already told to honour.
   *
   *   3600s / interUnit.delayMs   requests one session makes per hour
   *   x engageIngestAllowance     concurrent sessions, plus retries
   *
   * Derived rather than pinned so widening the client's pacing is not silently
   * throttled here instead — the same reason engage_ingest_quota computes its
   * record ceiling instead of carrying a number.
   */
  private async _resolveIngestLimit(
    stored: Partial<ApiRateLimitSettings>
  ): Promise<number> {
    if (
      typeof stored.engageIngest === 'number' &&
      Number.isFinite(stored.engageIngest) &&
      stored.engageIngest > 0
    ) {
      return Math.floor(stored.engageIngest);
    }
    const allowance =
      typeof stored.engageIngestAllowance === 'number' &&
      Number.isFinite(stored.engageIngestAllowance) &&
      stored.engageIngestAllowance > 0
        ? stored.engageIngestAllowance
        : DEFAULT_API_RATE_LIMIT_SETTINGS.engageIngestAllowance;

    let perSession = FALLBACK_INGEST_PER_SESSION;
    try {
      const pacing = await this._settings.get<any>('engage_scan_pacing');
      const delayMs = pacing?.extension?.interUnit?.delayMs;
      if (typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs > 0) {
        perSession = Math.ceil(RATE_LIMIT_TTL_MS / delayMs);
      }
    } catch (err) {
      this.logger.error(
        `Could not read engage_scan_pacing to derive the ingest rate limit; using ${FALLBACK_INGEST_PER_SESSION}/session`,
        err as Error
      );
    }
    return Math.max(1, Math.floor(perSession * allowance));
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

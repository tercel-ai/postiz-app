import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import { EngageScanConfigService } from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';
import { EngageEntitlementService } from '@gitroom/nestjs-libraries/engage/engage-entitlement.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

// ─── Settings key (admin-configurable via /admin/settings, no redeploy) ──────
export const ENGAGE_INGEST_QUOTA_KEY = 'engage_ingest_quota';

/** Rolling window the cap is measured over. */
const WINDOW_MS = 3_600_000;
/** Two buckets are read per check, so both must outlive the window itself. */
const BUCKET_TTL_SECONDS = (WINDOW_MS / 1000) * 2;

export interface EngageIngestQuota {
  /** Master switch. Off = count nothing, reject nothing. */
  enabled: boolean;
  /**
   * How many browser sessions ONE organization may legitimately run at once —
   * the multiplier on the BURST term below.
   */
  sessionsAllowance: number;
  /**
   * Head-room multiplier on the PLAN term below. A plan's cadence gives an
   * average, and real collection is not flat: every unit of a new project comes
   * due at once, and an org that was offline for a day comes back to a full
   * backlog. Without this, catching up would read as abuse.
   */
  burstFactor: number;
  /**
   * Final multiplier on the COMPUTED ceiling, applied after the two terms are
   * combined. 1 = the formula's own answer; below 1 tightens, above 1 loosens.
   *
   * The one knob to reach for when the ceiling is wrong in practice: it moves
   * the ceiling without touching a single input the formula shares with
   * something else. Raising `sessionsAllowance` or `burstFactor` to buy head-room
   * would also restate what those words mean, and `engage_scan_pacing` is a
   * contract shipped to the extension — editing either to tune the server
   * ceiling makes both lie. Ignored for a pinned `recordsPerHour`, which is
   * already an exact number by definition.
   */
  scale: number;
  /**
   * Explicit records/hour ceiling. `null` (the default) computes it instead —
   * see {@link EngageIngestQuotaService.resolveLimit}. Pin a number only to
   * override the computation for an incident; every input it uses is itself an
   * admin-tunable setting, so the computed value already follows the plan.
   */
  recordsPerHour: number | null;
}

export const DEFAULT_INGEST_QUOTA: EngageIngestQuota = {
  enabled: true,
  // Two sessions. One session flat out is NOT headroom: with interUnit 60s a
  // single browser reaches ~40 units/hour, which on a first backfill (reddit
  // initial = 3 pages/unit) is 120 fetches/hour — exactly hourlyRequestCap. So
  // a one-session allowance would reject an ordinary onboarding backfill the
  // moment the user opened the extension on a second device.
  sessionsAllowance: 2,
  burstFactor: 2,
  scale: 1,
  recordsPerHour: null,
};

/** Used only when NEITHER term can be computed (both config reads failed). */
const FALLBACK_RECORDS_PER_HOUR = 3000;

/**
 * Server-side ceiling on how much scan data one organization may push in.
 *
 * Until this existed the ingest endpoints were unbounded: `engage_scan_pacing`
 * carries the numbers that bound a well-behaved client, but every one of them
 * is shipped TO the extension as advice (ScanTaskPacing) and none was ever
 * checked on the way back in. A client that ignores its pacing — or is not the
 * extension at all — met no limit beyond the DTO's per-request array cap.
 *
 * Counted on records SUBMITTED, not records accepted. The cost this protects
 * (validation, TTL filtering, scoring, the LLM intent classification, and the
 * per-subscriber fan-out write) is paid before anything is discarded, so
 * charging only for what survives would make a batch of junk free.
 */
@Injectable()
export class EngageIngestQuotaService implements OnModuleInit {
  private readonly logger = new Logger(EngageIngestQuotaService.name);

  constructor(
    private readonly _settings: SettingsService,
    private readonly _scanConfig: EngageScanConfigService,
    private readonly _entitlement: EngageEntitlementService
  ) {}

  async onModuleInit(): Promise<void> {
    const existing = await this._settings.get(ENGAGE_INGEST_QUOTA_KEY);
    if (existing === null || existing === undefined) {
      await this._settings.set(ENGAGE_INGEST_QUOTA_KEY, DEFAULT_INGEST_QUOTA, {
        type: 'object',
        description:
          'Server-side ingest ceiling: max scan records ONE organization may ' +
          'submit per rolling hour across every engage ingest endpoint. ' +
          'recordsPerHour null = COMPUTE it as the larger of: BURST = ' +
          'engage_scan_pacing hourlyRequestCap × largest extension pageSize × ' +
          'sessionsAllowance; PLAN = (keywordsMax + priorityAccountsMax) × ' +
          'scannable platforms × largest pageSize × burstFactor / ' +
          'scanIntervalHours, from the org\'s own engage_entitlements. Every ' +
          'input is itself tunable, so the ceiling follows the plan instead of ' +
          'throttling it. Counted on records SUBMITTED, not accepted; an ' +
          'over-quota batch is refused whole. `scale` multiplies the computed ' +
          'result (1 = the formula as-is) and is the knob to tune first.',
        defaultValue: DEFAULT_INGEST_QUOTA,
      });
      this.logger.log(`Seeded default ${ENGAGE_INGEST_QUOTA_KEY}`);
    }
  }

  /**
   * Largest number of records ONE extension fetch can return, across every
   * platform and both scan phases. The ceiling multiplies by this rather than a
   * per-platform value because the backend cannot know, at ingest time, which
   * mix of platforms the hour's fetches came from — so it has to assume the
   * most generous one.
   */
  private async _maxRecordsPerFetch(): Promise<number> {
    const pacing = await this._scanConfig.getPacing();
    const { interUnit, session, ...platforms } = pacing.extension as Record<
      string,
      any
    >;
    const sizes = Object.values(platforms).flatMap((p: any) =>
      [p?.initial?.pageSize, p?.incremental?.pageSize].filter(
        (n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
      )
    );
    return sizes.length ? Math.max(...sizes) : 0;
  }

  /** The stored knobs, with junk values replaced by their defaults. */
  private async _settingsOrDefaults(): Promise<EngageIngestQuota> {
    const stored = await this._settings.get<Partial<EngageIngestQuota>>(
      ENGAGE_INGEST_QUOTA_KEY
    );
    // A junk value falls back to the DEFAULT, never to "unlimited": a typo in
    // the admin UI must not silently reopen the hole this closes. Same stance
    // as post_plan_limits.
    const positive = (raw: unknown, fallback: number, field: string): number => {
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        return Math.floor(raw);
      }
      if (raw !== undefined && raw !== null) {
        this.logger.warn(
          `${ENGAGE_INGEST_QUOTA_KEY}.${field}=${JSON.stringify(
            raw
          )} is unusable; using ${fallback}`
        );
      }
      return fallback;
    };
    const fraction = (raw: unknown, fallback: number, field: string): number => {
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
      if (raw !== undefined && raw !== null) {
        this.logger.warn(
          `${ENGAGE_INGEST_QUOTA_KEY}.${field}=${JSON.stringify(
            raw
          )} is unusable; using ${fallback}`
        );
      }
      return fallback;
    };
    return {
      enabled: stored?.enabled ?? DEFAULT_INGEST_QUOTA.enabled,
      sessionsAllowance: positive(
        stored?.sessionsAllowance,
        DEFAULT_INGEST_QUOTA.sessionsAllowance,
        'sessionsAllowance'
      ),
      burstFactor: positive(
        stored?.burstFactor,
        DEFAULT_INGEST_QUOTA.burstFactor,
        'burstFactor'
      ),
      // Fractional on purpose — halving the ceiling is `0.5`, and rounding that
      // to 0 would be a silent total block, so this one is not floored.
      scale: fraction(stored?.scale, DEFAULT_INGEST_QUOTA.scale, 'scale'),
      // `null` here is not junk — it is the documented "compute it" value, so it
      // must reach resolveLimit rather than be coerced away.
      recordsPerHour:
        stored?.recordsPerHour === null || stored?.recordsPerHour === undefined
          ? null
          : positive(stored.recordsPerHour, 0, 'recordsPerHour') || null,
    };
  }

  /**
   * BURST term — what a legitimate client can push in an hour, whatever it is
   * catching up on:
   *
   *   hourlyRequestCap × largest extension pageSize × sessionsAllowance
   *
   * `hourlyRequestCap` counts FETCHES (pages), not units and not ingest calls
   * (see ScanTaskPacing), so the product is a true records/hour bound whatever
   * mix of initial (multi-page) and incremental (single-page) units the client
   * happens to be working through.
   */
  private async _burstCeiling(sessionsAllowance: number): Promise<number> {
    const pacing = await this._scanConfig.getPacing();
    const { interUnit, session, ...platforms } = pacing.extension as Record<
      string,
      any
    >;
    const sizes = Object.values(platforms).flatMap((p: any) =>
      [p?.initial?.pageSize, p?.incremental?.pageSize].filter(
        (n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
      )
    );
    const perFetch = sizes.length ? Math.max(...sizes) : 0;
    const cap = session?.hourlyRequestCap;
    if (!perFetch || typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
      return 0;
    }
    return Math.floor(cap * perFetch * sessionsAllowance);
  }

  /**
   * PLAN term — what THIS org's own entitlement can legitimately generate:
   *
   *   scanUnits × largest pageSize / scanIntervalHours × burstFactor
   *   scanUnits = (keywordsMax + priorityAccountsMax) × scannable platforms
   *
   * Every keyword fans out to one unit PER PLATFORM (see _enumerateUnits), and
   * `priorityAccountsMax` is already a per-platform pool — so both multiply by
   * the platform count. Dividing by the plan's scan cadence turns a unit count
   * into a rate, which is what makes the ceiling follow the plan: raise
   * keywordsMax, or shorten scanIntervalHours, and this rises with it instead
   * of throttling the change that was just paid for.
   *
   * Returns 0 when the plan leaves a cap `null` (unlimited) — an unlimited input
   * cannot yield a finite rate, so the burst term stands alone rather than the
   * ceiling silently becoming infinite.
   */
  private async _planCeiling(
    organizationId: string,
    burstFactor: number
  ): Promise<number> {
    const [entitlement, platforms, pacing] = await Promise.all([
      this._entitlement.getEntitlement(organizationId),
      this._scanConfig.getSupportedScanPlatforms(),
      this._scanConfig.getPacing(),
    ]);
    const { keywordsMax, priorityAccountsMax, scanIntervalHours } = entitlement;
    if (
      keywordsMax === null ||
      priorityAccountsMax === null ||
      !platforms.length ||
      !Number.isFinite(scanIntervalHours) ||
      scanIntervalHours <= 0
    ) {
      return 0;
    }
    const { interUnit, session, ...perPlatform } = pacing.extension as Record<
      string,
      any
    >;
    const sizes = Object.values(perPlatform).flatMap((p: any) =>
      [p?.initial?.pageSize, p?.incremental?.pageSize].filter(
        (n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
      )
    );
    if (!sizes.length) return 0;
    const scanUnits = (keywordsMax + priorityAccountsMax) * platforms.length;
    return Math.floor(
      (scanUnits * Math.max(...sizes) * burstFactor) / scanIntervalHours
    );
  }

  /**
   * Effective records/hour ceiling for one org: the pinned value if an admin set
   * one, else the LARGER of the burst and plan terms.
   *
   * Larger, not smaller, because the two model different legitimate regimes and
   * an org can be in either. A small org bursts far above its own cadence while
   * backfilling a new project; a maxed-out org sustains far above what one
   * browser session can push. Taking the minimum would reject one of those two
   * ordinary situations, and a refused batch costs real collected data — while
   * taking the maximum still turns "unbounded" into "bounded", which is the
   * point.
   */
  async resolveLimit(organizationId?: string): Promise<{
    enabled: boolean;
    recordsPerHour: number;
    source: 'pinned' | 'burst' | 'plan' | 'fallback';
  }> {
    const quota = await this._settingsOrDefaults();
    if (quota.recordsPerHour !== null) {
      return {
        enabled: quota.enabled,
        recordsPerHour: quota.recordsPerHour,
        source: 'pinned',
      };
    }

    const safely = async (label: string, fn: () => Promise<number>) => {
      try {
        return await fn();
      } catch (err) {
        this.logger.error(
          `Could not compute the ${label} term of the ingest ceiling`,
          err as Error
        );
        return 0;
      }
    };
    const [burst, plan] = await Promise.all([
      safely('burst', () => this._burstCeiling(quota.sessionsAllowance)),
      organizationId
        ? safely('plan', () => this._planCeiling(organizationId, quota.burstFactor))
        : Promise.resolve(0),
    ]);

    // At least 1, so a scale small enough to round the ceiling to zero degrades
    // to "almost nothing gets through" rather than "every ingest is refused".
    const scaled = (n: number) => Math.max(1, Math.floor(n * quota.scale));
    if (!burst && !plan) {
      return {
        enabled: quota.enabled,
        recordsPerHour: scaled(FALLBACK_RECORDS_PER_HOUR),
        source: 'fallback',
      };
    }
    return {
      enabled: quota.enabled,
      recordsPerHour: scaled(Math.max(burst, plan)),
      source: plan > burst ? 'plan' : 'burst',
    };
  }

  private _key(organizationId: string, bucket: number): string {
    return `postiz:engage:ingest-quota:${organizationId}:${bucket}`;
  }

  /**
   * Reject the batch when it would carry the org past its hourly ceiling.
   *
   * The whole batch is refused, never truncated: the extension pages against a
   * cursor it advances only on a completed unit, so silently dropping the tail
   * of a page would make it re-submit the same records forever instead of
   * backing off.
   *
   * Measured with the standard weighted two-bucket approximation of a sliding
   * window (previous bucket decayed by how far into the current one we are),
   * which needs only GET/INCRBY and so cannot drift the way a read-modify-write
   * counter would across backend instances. The check and the increment are not
   * one atomic step, so concurrent submissions can overshoot by up to
   * (concurrency × batch size) — acceptable for a backstop whose job is to turn
   * "unbounded" into "bounded", not to meter to the record.
   */
  async assertWithinQuota(
    organizationId: string,
    records: number
  ): Promise<void> {
    if (!organizationId || records <= 0) return;

    const { enabled, recordsPerHour } = await this.resolveLimit(organizationId);
    if (!enabled) return;

    const now = Date.now();
    const bucket = Math.floor(now / WINDOW_MS);
    const elapsedFraction = (now % WINDOW_MS) / WINDOW_MS;

    let used: number;
    try {
      const [currentRaw, previousRaw] = await Promise.all([
        ioRedis.get(this._key(organizationId, bucket)),
        ioRedis.get(this._key(organizationId, bucket - 1)),
      ]);
      const current = Number(currentRaw) || 0;
      const previous = Number(previousRaw) || 0;
      used = previous * (1 - elapsedFraction) + current;
    } catch (err) {
      // Fail OPEN. Ingest is the product's only data path now that background
      // scanning is off (engage_touch_switch), so a Redis outage must not stop
      // every customer's collection; the DTO array caps and the route throttle
      // still bound a single request. Logged at error so an outage that silently
      // suspends the ceiling is visible rather than assumed.
      this.logger.error(
        `Ingest quota check failed for org=${organizationId}; allowing ${records} record(s) unmetered`,
        err as Error
      );
      return;
    }

    if (used + records > recordsPerHour) {
      const retryAfterSeconds = Math.ceil((WINDOW_MS - (now % WINDOW_MS)) / 1000);
      this.logger.warn(
        `Ingest quota exceeded for org=${organizationId}: used=${Math.round(
          used
        )} + requested=${records} > ${recordsPerHour}/hour`
      );
      throw new HttpException(
        {
          code: 'engage_ingest_quota_exceeded',
          limit: recordsPerHour,
          used: Math.round(used),
          requested: records,
          retryAfterSeconds,
          message:
            `Ingest quota exceeded: ${Math.round(used)} of ${recordsPerHour} ` +
            `records already submitted this hour, and this batch carries ` +
            `${records} more. Retry in ${retryAfterSeconds}s, or raise ` +
            `${ENGAGE_INGEST_QUOTA_KEY}.recordsPerHour.`,
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    try {
      const key = this._key(organizationId, bucket);
      await ioRedis.incrby(key, records);
      await ioRedis.expire(key, BUCKET_TTL_SECONDS);
    } catch (err) {
      // The batch was already admitted by the check above; losing its tally only
      // costs accuracy in this window, so it must not fail the request.
      this.logger.error(
        `Ingest quota accounting failed for org=${organizationId} (${records} record(s) uncounted)`,
        err as Error
      );
    }
  }
}

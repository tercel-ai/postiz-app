import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import {
  clampXMaxResults,
  X_MAX_RESULTS,
} from '@gitroom/nestjs-libraries/engage/scan/x-scan-adapter';

// ─── Settings key (admin-configurable via /admin/settings, no redeploy) ───────
export const ENGAGE_SCAN_PACING_KEY = 'engage_scan_pacing';

// Freshness window (hours) per platform: a scan never surfaces a post older than
// `now - hours`. Used as the `start_time` floor on a first scan / long gap and as
// a client-side cutoff. Admin-configurable; env fallback per platform. X only for
// now (Reddit TBD), but stored per-platform so Reddit can opt in without a schema
// change. Resolution order: stored setting → env → default.
export const ENGAGE_SCAN_FRESHNESS_KEY = 'engage_scan_freshness_hours';
export interface ScanFreshnessHours {
  x: number;
  reddit: number;
}
export const DEFAULT_SCAN_FRESHNESS_HOURS: ScanFreshnessHours = { x: 24, reddit: 24 };

// Per-call page size for X keyword scans (X `max_results`). Resolution order:
// stored setting → env (ENGAGE_X_SCAN_MAX_RESULTS) → default. The default (10)
// lives on the X adapter; X bills per returned record, so this stays low unless
// an admin opts into bigger pages. Clamped to X's valid [10, 100] range.
export const ENGAGE_X_SCAN_MAX_RESULTS_KEY = 'engage.keyword_x_scan_max_results';
export const ENGAGE_X_SCAN_MAX_RESULTS_ENV = 'ENGAGE_X_SCAN_MAX_RESULTS';
export type SettingSource = 'db' | 'env' | 'default';

// Backend ("touch") scan switches — allow disabling server-side Temporal scan
// per platform so the browser extension can be the sole executor.
// All default to true (backend scan ON); set to false via /admin/settings to
// hand off that platform's scanning to the extension.
export const ENGAGE_TOUCH_SWITCH_KEY = 'engage_touch_switch';
export const ENGAGE_TOUCH_X_SWITCH_KEY = 'engage_touch_x_switch';
export const ENGAGE_TOUCH_REDDIT_SWITCH_KEY = 'engage_touch_reddit_switch';

export type ScanPlatform = 'x' | 'reddit';
export type ScanPhase = 'initial' | 'incremental';
export type ScanPath = 'workflow' | 'extension';

/**
 * Pagination pacing for ONE (path, platform, phase): how many pages to pull and
 * how long to wait between them. `pageDelayMs` is the floor; an extra random
 * `0..jitterMs` is added per page so the cadence is not machine-regular.
 */
export interface PagePacing {
  /** Hard cap on pages (≈ upstream calls) per scan unit per run. */
  maxPages: number;
  /** Items requested per page. Smaller = more human-like + smaller ingest
   * payload (Reddit web search uses 25; X SearchTimeline ~20). Currently
   * consumed by the extension executor only; workflow adapters page on their
   * own internal sizes. */
  pageSize: number;
  /** Minimum wait between two page fetches. */
  pageDelayMs: number;
  /** Extra random wait (0..jitterMs) added on top of pageDelayMs per page. */
  jitterMs: number;
}

export interface PerPlatformPacing {
  initial: PagePacing;
  incremental: PagePacing;
}

/**
 * Whole engage scan pacing config, split by execution PATH because the two
 * behave differently:
 *  - workflow  → server tokens/proxy + rate-limit headers; can be near-instant.
 *  - extension → the user's PERSONAL browser session; a flagged account is
 *    catastrophic, so it must be slow, jittered, low-concurrency, and capped.
 */
export interface EngageScanPacing {
  workflow: Record<ScanPlatform, PerPlatformPacing>;
  extension: Record<ScanPlatform, PerPlatformPacing> & {
    /** Wait between two DIFFERENT scan units (keywords/subreddits) in one
     * browser, so it never machine-guns distinct queries back-to-back. */
    interUnit: { delayMs: number; jitterMs: number };
    /** Hard ceiling on fetches per browser session per hour — a deterministic
     * backstop independent of the probabilistic delays above. */
    session: { hourlyRequestCap: number };
  };
}

// ─── Defaults (seeded on first boot) ──────────────────────────────────────────
// Workflow: sub-second, defence-in-depth only (headers drive real back-off).
// Extension: seconds-scale + ~1min jitter; X stricter than Reddit on automation.
export const DEFAULT_SCAN_PACING: EngageScanPacing = {
  workflow: {
    // Incremental defaults to ONE page (no pagination): with per-keyword units +
    // since_id + the freshness window, a single newest page covers the increment;
    // pagination only risked one unit hogging the call budget. Bump per platform
    // via the engage_scan_pacing setting if a unit legitimately needs more.
    x: {
      initial: { maxPages: 5, pageSize: 20, pageDelayMs: 300, jitterMs: 300 },
      incremental: { maxPages: 1, pageSize: 20, pageDelayMs: 300, jitterMs: 300 },
    },
    reddit: {
      initial: { maxPages: 5, pageSize: 25, pageDelayMs: 1200, jitterMs: 600 },
      incremental: { maxPages: 1, pageSize: 25, pageDelayMs: 1200, jitterMs: 600 },
    },
  },
  extension: {
    x: {
      initial: { maxPages: 1, pageSize: 20, pageDelayMs: 8000, jitterMs: 60000 },
      incremental: { maxPages: 1, pageSize: 20, pageDelayMs: 8000, jitterMs: 60000 },
    },
    reddit: {
      initial: { maxPages: 1, pageSize: 25, pageDelayMs: 5000, jitterMs: 60000 },
      incremental: { maxPages: 1, pageSize: 25, pageDelayMs: 5000, jitterMs: 60000 },
    },
    interUnit: { delayMs: 60000, jitterMs: 60000 },
    session: { hourlyRequestCap: 60 },
  },
};

/**
 * Owns the engage scan pacing config: page caps + inter-page/inter-unit delays
 * + per-session request ceiling, split by workflow vs extension path. Stored in
 * the Settings table so an admin can tune it without a redeploy; a partial
 * admin override deep-merges onto the defaults so no leaf is ever dropped.
 */
@Injectable()
export class EngageScanConfigService implements OnModuleInit {
  private readonly logger = new Logger(EngageScanConfigService.name);

  constructor(private readonly _settings: SettingsService) {}

  async onModuleInit(): Promise<void> {
    const existing = await this._settings.get(ENGAGE_SCAN_PACING_KEY);
    if (existing === null || existing === undefined) {
      await this._settings.set(ENGAGE_SCAN_PACING_KEY, DEFAULT_SCAN_PACING, {
        type: 'object',
        description:
          'Engage scan pagination pacing (maxPages + page/inter-unit delays + jitter + per-session cap), split by workflow vs extension path and by platform/phase.',
        defaultValue: DEFAULT_SCAN_PACING,
      });
      this.logger.log(`Seeded default ${ENGAGE_SCAN_PACING_KEY}`);
    }

    const freshness = await this._settings.get(ENGAGE_SCAN_FRESHNESS_KEY);
    if (freshness === null || freshness === undefined) {
      await this._settings.set(ENGAGE_SCAN_FRESHNESS_KEY, DEFAULT_SCAN_FRESHNESS_HOURS, {
        type: 'object',
        description:
          'Engage scan freshness window in hours per platform — caps how far back a scan looks (start_time = now - hours) on first scan / long gaps, plus a client-side cutoff. X honoured today; Reddit TBD.',
        defaultValue: DEFAULT_SCAN_FRESHNESS_HOURS,
      });
      this.logger.log(`Seeded default ${ENGAGE_SCAN_FRESHNESS_KEY}`);
    }

    for (const [key, description] of [
      [ENGAGE_TOUCH_SWITCH_KEY, 'Global backend ("touch") scan switch. Set to false to disable all server-side Temporal scanning and hand off to the browser extension.'],
      [ENGAGE_TOUCH_X_SWITCH_KEY, 'X backend scan switch. Set to false to disable only X scanning in the Temporal workflow (extension takes over X).'],
      [ENGAGE_TOUCH_REDDIT_SWITCH_KEY, 'Reddit backend scan switch. Set to false to disable only Reddit scanning in the Temporal workflow (extension takes over Reddit).'],
    ] as const) {
      const existing = await this._settings.get(key);
      if (existing === null || existing === undefined) {
        await this._settings.set(key, true, {
          type: 'boolean',
          description,
          defaultValue: true,
        });
        this.logger.log(`Seeded default ${key}`);
      }
    }
  }

  /**
   * Returns false if the global backend scan is disabled, OR if the specified
   * platform's backend scan is disabled. Defaults to true (enabled) if the
   * setting has not been created yet.
   */
  async isTouchEnabled(platform?: ScanPlatform): Promise<boolean> {
    const global = await this._settings.get<boolean>(ENGAGE_TOUCH_SWITCH_KEY);
    if (global === false) return false;
    if (platform) {
      const key =
        platform === 'x' ? ENGAGE_TOUCH_X_SWITCH_KEY : ENGAGE_TOUCH_REDDIT_SWITCH_KEY;
      const platformOn = await this._settings.get<boolean>(key);
      if (platformOn === false) return false;
    }
    return true;
  }

  /**
   * Resolve the freshness window (ms) for a platform: stored setting → env
   * (`ENGAGE_X_SCAN_WINDOW_HOURS` / `ENGAGE_REDDIT_SCAN_WINDOW_HOURS`) → default.
   * Returned in ms so callers pass it straight to the adapter's freshnessWindowMs.
   */
  async getFreshnessWindowMs(platform: ScanPlatform): Promise<number> {
    const stored = await this._settings.get<Partial<ScanFreshnessHours>>(
      ENGAGE_SCAN_FRESHNESS_KEY
    );
    const envName =
      platform === 'x'
        ? 'ENGAGE_X_SCAN_WINDOW_HOURS'
        : 'ENGAGE_REDDIT_SCAN_WINDOW_HOURS';
    const envH = Number(process.env[envName]);
    const fallback =
      Number.isFinite(envH) && envH > 0 ? envH : DEFAULT_SCAN_FRESHNESS_HOURS[platform];
    const hours = num(stored?.[platform], fallback);
    return hours * 3_600_000;
  }

  /** Effective pacing config: stored value deep-merged onto the defaults. */
  async getPacing(): Promise<EngageScanPacing> {
    const stored = await this._settings.get<Partial<EngageScanPacing>>(
      ENGAGE_SCAN_PACING_KEY
    );
    return mergePacing(DEFAULT_SCAN_PACING, stored);
  }

  /** Resolve the page pacing for one (path, platform, phase). */
  async getPagePacing(
    path: ScanPath,
    platform: ScanPlatform,
    phase: ScanPhase
  ): Promise<PagePacing> {
    const pacing = await this.getPacing();
    return pacing[path][platform][phase];
  }

  /**
   * Resolve the effective X scan `max_results` (per-call page size) WITH its
   * source, mirroring the resolution the orchestrator uses:
   *   stored setting (engage.keyword_x_scan_max_results)
   *     → env (ENGAGE_X_SCAN_MAX_RESULTS)
   *     → default (X_MAX_RESULTS = 10)
   * Always clamped to X's valid [10, 100] range. `source` lets the admin UI show
   * where the live value came from (same shape as the initial-scan-budget API).
   */
  async resolveXScanMaxResults(): Promise<{ value: number; source: SettingSource }> {
    const stored = await this._settings.get(ENGAGE_X_SCAN_MAX_RESULTS_KEY);
    if (stored !== null && stored !== undefined) {
      const n = Number(stored);
      if (Number.isFinite(n) && n > 0) {
        return { value: clampXMaxResults(n), source: 'db' };
      }
    }
    const env = Number(process.env[ENGAGE_X_SCAN_MAX_RESULTS_ENV]);
    if (Number.isFinite(env) && env > 0) {
      return { value: clampXMaxResults(env), source: 'env' };
    }
    return { value: clampXMaxResults(X_MAX_RESULTS), source: 'default' };
  }

  /** Effective X scan `max_results` value only (orchestrator hot path). */
  async getXScanMaxResults(): Promise<number> {
    return (await this.resolveXScanMaxResults()).value;
  }
}

/**
 * Deep-merge a partial admin override onto the defaults. Only the known nested
 * shape is walked; per-leaf numbers fall back to the default when absent or not
 * a finite positive number, so a malformed partial can never zero out a guard.
 */
export function mergePacing(
  base: EngageScanPacing,
  override: Partial<EngageScanPacing> | null | undefined
): EngageScanPacing {
  if (!override || typeof override !== 'object') return base;

  const mergePage = (b: PagePacing, o?: Partial<PagePacing>): PagePacing => ({
    maxPages: num(o?.maxPages, b.maxPages),
    pageSize: num(o?.pageSize, b.pageSize),
    pageDelayMs: num(o?.pageDelayMs, b.pageDelayMs, true),
    jitterMs: num(o?.jitterMs, b.jitterMs, true),
  });
  const mergePlatform = (
    b: PerPlatformPacing,
    o?: Partial<PerPlatformPacing>
  ): PerPlatformPacing => ({
    initial: mergePage(b.initial, o?.initial),
    incremental: mergePage(b.incremental, o?.incremental),
  });

  const ow = (override.workflow ?? {}) as any;
  const oe = (override.extension ?? {}) as any;
  return {
    workflow: {
      x: mergePlatform(base.workflow.x, ow.x),
      reddit: mergePlatform(base.workflow.reddit, ow.reddit),
    },
    extension: {
      x: mergePlatform(base.extension.x, oe.x),
      reddit: mergePlatform(base.extension.reddit, oe.reddit),
      interUnit: {
        delayMs: num(oe.interUnit?.delayMs, base.extension.interUnit.delayMs, true),
        jitterMs: num(oe.interUnit?.jitterMs, base.extension.interUnit.jitterMs, true),
      },
      session: {
        hourlyRequestCap: num(
          oe.session?.hourlyRequestCap,
          base.extension.session.hourlyRequestCap
        ),
      },
    },
  };
}

/** Coerce to a finite number; allow 0 only when `allowZero` (delays can be 0). */
function num(value: unknown, fallback: number, allowZero = false): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return fallback;
  if (n === 0 && !allowZero) return fallback;
  return n;
}

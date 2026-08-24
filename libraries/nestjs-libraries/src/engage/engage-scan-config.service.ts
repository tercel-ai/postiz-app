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
  linkedin: number;
  devto: number;
  hackernews: number;
  medium: number;
  quora: number;
}
export const DEFAULT_SCAN_FRESHNESS_HOURS: ScanFreshnessHours = {
  x: 24,
  reddit: 24,
  linkedin: 24,
  devto: 24,
  hackernews: 24,
  medium: 24,
  quora: 24,
};

// Per-call page size for X keyword scans (X `max_results`). Resolution order:
// stored setting → env (ENGAGE_X_SCAN_MAX_RESULTS) → default. The default (10)
// lives on the X adapter; X bills per returned record, so this stays low unless
// an admin opts into bigger pages. Clamped to X's valid [10, 100] range.
export const ENGAGE_X_SCAN_MAX_RESULTS_KEY = 'engage.keyword_x_scan_max_results';
export const ENGAGE_X_SCAN_MAX_RESULTS_ENV = 'ENGAGE_X_SCAN_MAX_RESULTS';
export type SettingSource = 'db' | 'env' | 'default';

// Opportunity TTL (days): how long a NEW-status opportunity stays actionable
// before EngageHousekeepingActivity's hourly cron marks it EXPIRED (an opportunistic
// per-org sweep also runs inline during an active scan tick, but the cron is
// the durable, system-wide sweep). Measured from EngageOpportunityState.createdAt
// (when the org first matched the post), not the post's own publish time.
// Resolution order: stored setting → env (ENGAGE_OPPORTUNITY_TTL_DAYS) →
// default. Seeded on first boot so the admin UI can edit it via
// PUT /admin/settings/:key immediately.
export const ENGAGE_OPPORTUNITY_TTL_DAYS_KEY = 'engage_opportunity_ttl_days';
export const DEFAULT_OPPORTUNITY_TTL_DAYS = 7;

// Per-platform opportunity TTL (days). Supersedes the single-value key above,
// which stays readable as the all-platform fallback so an existing deployment
// keeps its configured number until an admin edits the per-platform map.
//
// A uniform 7 days does not fit every platform: a timeline post is dead within
// days, while an article or a Q&A answer keeps drawing readers (and stays worth
// replying to) for weeks. Same shape and resolution style as
// ENGAGE_SCAN_FRESHNESS_KEY so both admin cards read alike.
//
// This TTL now drives TWO gates, both measured against the SAME cutoff
// (`now - ttlDays[platform]`):
//   • the sweep that flips a NEW state to EXPIRED (state.createdAt OR the
//     post's own postPublishedAt — whichever crosses the line first), and
//   • the ingest gate, which refuses to persist a post already published
//     before the cutoff (an expired opportunity supports no action, so storing
//     it only costs an LLM intent call and feed noise).
export const ENGAGE_OPPORTUNITY_TTL_DAYS_BY_PLATFORM_KEY =
  'engage_opportunity_ttl_days_by_platform';
export type OpportunityTtlDays = Record<ScanPlatform, number>;
export const DEFAULT_OPPORTUNITY_TTL_DAYS_BY_PLATFORM: OpportunityTtlDays = {
  // Timeline platforms: a reply past ~72h reaches nobody.
  x: 3,
  // Front-page cycle is ~a day; a 2-day-old item is off every list.
  hackernews: 2,
  // Thread-shaped: still gets traffic through the first week.
  reddit: 7,
  linkedin: 7,
  // Article / Q&A long tail — the case the single 7-day value got wrong.
  devto: 30,
  medium: 30,
  quora: 30,
};

/**
 * Env/default-only TTL resolution, for callers that cannot reach Settings (an
 * activity or service constructed without EngageScanConfigService — unit tests
 * do this). Mirrors the last two rungs of resolveOpportunityTtlDays, so a
 * degraded caller still gets the per-platform shape rather than a flat 7.
 */
export function fallbackOpportunityTtlDays(platform: ScanPlatform): number {
  // Same resolver as the Settings-backed path, with no stored values — so the
  // env and default rungs cannot drift between the two.
  return resolveOpportunityTtlFor(platform, undefined, null).value;
}

/** Every platform's env/default TTL — the degraded form of getOpportunityTtlDaysMap. */
export function fallbackOpportunityTtlDaysMap(): OpportunityTtlDays {
  return Object.fromEntries(
    SCANNABLE_PLATFORMS.map((p) => [p, fallbackOpportunityTtlDays(p)])
  ) as OpportunityTtlDays;
}

/**
 * Resolve ONE platform's TTL from already-read Settings values. Pure, so the
 * single-platform reader and the whole-map reader cannot drift, and so the map
 * reader can resolve every platform from ONE pair of Settings reads.
 *
 * The legacy single value applies only when the per-platform map is entirely
 * ABSENT, never per missing key. Otherwise a platform added to
 * SCANNABLE_PLATFORMS later (present in code, missing from the stored map)
 * would silently inherit the legacy number instead of the default chosen for
 * it — on a fresh install that legacy key is seeded to 7, so a new article
 * platform would quietly get 7 days rather than its intended 30.
 */
export function resolveOpportunityTtlFor(
  platform: ScanPlatform,
  storedMap: Partial<OpportunityTtlDays> | null | undefined,
  legacyValue: unknown
): { value: number; source: SettingSource } {
  const perPlatform = Number(storedMap?.[platform]);
  if (Number.isFinite(perPlatform) && perPlatform > 0) {
    return { value: perPlatform, source: 'db' };
  }

  // Per-platform env override. New platforms get their own name so they never
  // silently inherit another platform's value (mirrors the freshness window).
  const envPlatform = Number(
    process.env[`ENGAGE_${platform.toUpperCase()}_OPPORTUNITY_TTL_DAYS`]
  );
  if (Number.isFinite(envPlatform) && envPlatform > 0) {
    return { value: envPlatform, source: 'env' };
  }

  if (storedMap === null || storedMap === undefined) {
    const legacy = Number(legacyValue);
    if (Number.isFinite(legacy) && legacy > 0) return { value: legacy, source: 'db' };
  }

  const env = Number(process.env.ENGAGE_OPPORTUNITY_TTL_DAYS);
  if (Number.isFinite(env) && env > 0) return { value: env, source: 'env' };

  return {
    value: DEFAULT_OPPORTUNITY_TTL_DAYS_BY_PLATFORM[platform],
    source: 'default',
  };
}

/**
 * The instant before which a post of `platform` counts as expired. Returns null
 * for a platform absent from the TTL map: an unknown platform has no configured
 * lifetime, and the gate must never drop a post it cannot judge (a scanner for a
 * new platform would otherwise silently ingest nothing until the map is edited).
 */
export function opportunityExpiryCutoff(
  platform: string,
  ttlDays: Partial<OpportunityTtlDays>,
  now: number = Date.now()
): Date | null {
  const days = ttlDays[platform as ScanPlatform];
  if (!Number.isFinite(days) || (days as number) <= 0) return null;
  return new Date(now - (days as number) * 86_400_000);
}

// Backend ("touch") scan switches — allow disabling server-side Temporal scan
// per platform so the browser extension can be the sole executor.
// All default to true (backend scan ON); set to false via /admin/settings to
// hand off that platform's scanning to the extension.
export const ENGAGE_TOUCH_SWITCH_KEY = 'engage_touch_switch';
export const ENGAGE_TOUCH_X_SWITCH_KEY = 'engage_touch_x_switch';
export const ENGAGE_TOUCH_REDDIT_SWITCH_KEY = 'engage_touch_reddit_switch';

export type ScanPlatform =
  | 'x'
  | 'reddit'
  | 'linkedin'
  | 'devto'
  | 'hackernews'
  | 'medium'
  | 'quora';
export type ScanPhase = 'initial' | 'incremental';
export type ScanPath = 'workflow' | 'extension';

/**
 * Platforms a scanner exists for. The operation-plan allowlist may list any of
 * the ~30 providers (it drives the plan platform picker), so scan resolution
 * intersects it with these.
 *
 * This is CAPABILITY, not configuration: membership means "an implementation
 * can fetch this platform", while `getSupportedScanPlatforms()` answers the
 * separate question "is the operator currently scanning it" (settings /
 * ENGAGE_SUPPORTED_PLATFORMS, default `x,reddit`). The write boundary rejects a
 * platform missing from THIS list — no scanner will ever serve it — but accepts
 * one that is merely disabled, since that is a config state an operator flips.
 *
 * Exported as the single definition: identical copies previously sat in
 * engage-scan-tasks.service.ts, and a fourth in the scan-target module, so
 * adding a platform to some of them silently dropped its targets in the rest.
 */
export const SCANNABLE_PLATFORMS: readonly ScanPlatform[] = [
  'x',
  'reddit',
  'linkedin',
  'devto',
  'hackernews',
  'medium',
  'quora',
];

/**
 * The public hostname(s) each platform's post/reply URLs live on. Lives here,
 * beside SCANNABLE_PLATFORMS, for the same reason that list does: this is the
 * kind of per-platform fact that gets copied and then silently drifts. Reply-URL
 * validation used to hold private copies of it (an `isRedditUrl`, an `isXUrl`,
 * and a third map for everything else), so adding a platform to
 * SCANNABLE_PLATFORMS left it rejecting that platform's URLs with "not
 * supported" — a config-shaped error for what was really a missing table entry.
 *
 * Typed `Record<ScanPlatform, ...>` rather than a partial map ON PURPOSE: adding
 * a member to ScanPlatform without adding its hosts is then a COMPILE error, not
 * a runtime surprise. That is the whole guarantee — the list cannot change
 * without this changing with it.
 *
 * Hosts only, never path shapes: platforms rewrite their permalink structure
 * over time, and the id-shape checks that some flows additionally need (X's
 * /status/<id>, Reddit's comment id) live with the parsers that consume them.
 */
export const PLATFORM_HOSTS: Record<ScanPlatform, readonly string[]> = {
  x: ['x.com', 'twitter.com'],
  reddit: ['reddit.com'],
  linkedin: ['linkedin.com'],
  devto: ['dev.to'],
  hackernews: ['news.ycombinator.com'],
  medium: ['medium.com'],
  quora: ['quora.com'],
};

/**
 * Whether `url`'s host belongs to `platform`. Subdomains count (www.reddit.com,
 * old.reddit.com), an unparseable URL never does, and an unknown platform is
 * always false — callers must treat "cannot judge" as "reject", since the only
 * caller is URL validation.
 */
export function hostMatchesPlatform(platform: string, url: string): boolean {
  const domains = PLATFORM_HOSTS[platform as ScanPlatform];
  if (!domains) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false; // not a parseable absolute URL
  }
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

// Canonical key literal for the admin operation-plan platform allowlist. Inlined
// (not imported from operation-plan.service) to avoid an engage ↔ operation-plan
// module import cycle — operation-plan.service already imports from engage.
// Mirrors OPERATION_PLAN_ALLOWED_PLATFORMS_KEY.
const OPERATION_PLAN_ALLOWED_PLATFORMS_SETTING = 'operation_plan.allowed_platforms';

/**
 * Parse a platform allowlist (a settings string[] OR an env comma-string) down to
 * the scannable set, deduped and lowercased. Anything not in SCANNABLE_PLATFORMS
 * (e.g. instagram/youtube from the operation-plan picker) is dropped.
 */
export function toScanPlatforms(raw: unknown): ScanPlatform[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const out = new Set<ScanPlatform>();
  for (const p of list) {
    const v = String(p).trim().toLowerCase();
    if ((SCANNABLE_PLATFORMS as readonly string[]).includes(v)) {
      out.add(v as ScanPlatform);
    }
  }
  return [...out];
}

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
    // LinkedIn has no backend (workflow) scan adapter — the extension is its
    // only executor. This entry exists solely to satisfy the per-platform Record
    // type; the workflow never reads it.
    linkedin: {
      initial: { maxPages: 3, pageSize: 25, pageDelayMs: 1500, jitterMs: 600 },
      incremental: { maxPages: 1, pageSize: 25, pageDelayMs: 1500, jitterMs: 600 },
    },
    // devto/hackernews/medium/quora have no backend (workflow) scan adapter — the
    // extension is their only executor. These entries exist solely to satisfy the
    // per-platform Record type; the workflow never reads them.
    devto: {
      initial: { maxPages: 3, pageSize: 30, pageDelayMs: 500, jitterMs: 300 },
      incremental: { maxPages: 1, pageSize: 30, pageDelayMs: 500, jitterMs: 300 },
    },
    hackernews: {
      initial: { maxPages: 3, pageSize: 20, pageDelayMs: 500, jitterMs: 300 },
      incremental: { maxPages: 1, pageSize: 20, pageDelayMs: 500, jitterMs: 300 },
    },
    medium: {
      initial: { maxPages: 1, pageSize: 20, pageDelayMs: 1500, jitterMs: 600 },
      incremental: { maxPages: 1, pageSize: 20, pageDelayMs: 1500, jitterMs: 600 },
    },
    quora: {
      initial: { maxPages: 1, pageSize: 20, pageDelayMs: 1500, jitterMs: 600 },
      incremental: { maxPages: 1, pageSize: 20, pageDelayMs: 1500, jitterMs: 600 },
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
    // LinkedIn scan drives the user's personal session (DOM scrape + scroll) and
    // is at least as automation-risky as X, so it is slow + single-page like X.
    linkedin: {
      initial: { maxPages: 1, pageSize: 20, pageDelayMs: 8000, jitterMs: 60000 },
      incremental: { maxPages: 1, pageSize: 20, pageDelayMs: 8000, jitterMs: 60000 },
    },
    // Dev.to + Hacker News scan hit PUBLIC APIs (no personal session, no
    // automation risk), so they can page a little and pace fast like a normal
    // API client — closer to the workflow tier than the risky browser tiers.
    devto: {
      initial: { maxPages: 3, pageSize: 30, pageDelayMs: 800, jitterMs: 1200 },
      incremental: { maxPages: 1, pageSize: 30, pageDelayMs: 800, jitterMs: 1200 },
    },
    hackernews: {
      initial: { maxPages: 3, pageSize: 20, pageDelayMs: 800, jitterMs: 1200 },
      incremental: { maxPages: 1, pageSize: 20, pageDelayMs: 800, jitterMs: 1200 },
    },
    // Medium (RSS via the user's session) + Quora (personal-session DOM scrape)
    // are automation-risky like X/LinkedIn, so they are slow + single-page.
    medium: {
      initial: { maxPages: 1, pageSize: 20, pageDelayMs: 8000, jitterMs: 60000 },
      incremental: { maxPages: 1, pageSize: 20, pageDelayMs: 8000, jitterMs: 60000 },
    },
    quora: {
      initial: { maxPages: 1, pageSize: 20, pageDelayMs: 8000, jitterMs: 60000 },
      incremental: { maxPages: 1, pageSize: 20, pageDelayMs: 8000, jitterMs: 60000 },
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

    const opportunityTtl = await this._settings.get(ENGAGE_OPPORTUNITY_TTL_DAYS_KEY);
    if (opportunityTtl === null || opportunityTtl === undefined) {
      await this._settings.set(ENGAGE_OPPORTUNITY_TTL_DAYS_KEY, DEFAULT_OPPORTUNITY_TTL_DAYS, {
        type: 'number',
        description:
          'Legacy single-value opportunity TTL (days), kept as the all-platform fallback for engage_opportunity_ttl_days_by_platform.',
        defaultValue: DEFAULT_OPPORTUNITY_TTL_DAYS,
      });
      this.logger.log(`Seeded default ${ENGAGE_OPPORTUNITY_TTL_DAYS_KEY}`);
    }

    const ttlByPlatform = await this._settings.get(
      ENGAGE_OPPORTUNITY_TTL_DAYS_BY_PLATFORM_KEY
    );
    if (ttlByPlatform === null || ttlByPlatform === undefined) {
      // Seed from the legacy single value when one is already configured, so an
      // upgrade is behaviour-preserving: the per-platform defaults only apply to
      // a deployment that never set the old key. An admin then tunes per
      // platform from a map that matches what production was already doing.
      const legacy = Number(opportunityTtl);
      const seed: OpportunityTtlDays =
        Number.isFinite(legacy) && legacy > 0
          ? (Object.fromEntries(
              SCANNABLE_PLATFORMS.map((p) => [p, legacy])
            ) as OpportunityTtlDays)
          : DEFAULT_OPPORTUNITY_TTL_DAYS_BY_PLATFORM;
      await this._settings.set(ENGAGE_OPPORTUNITY_TTL_DAYS_BY_PLATFORM_KEY, seed, {
        type: 'object',
        description:
          'Days a NEW engage opportunity stays actionable, per platform. Drives both the EXPIRED sweep (state.createdAt OR the post\'s postPublishedAt, whichever is older) and the ingest gate (a post published before now - days is never persisted).',
        defaultValue: DEFAULT_OPPORTUNITY_TTL_DAYS_BY_PLATFORM,
      });
      this.logger.log(`Seeded default ${ENGAGE_OPPORTUNITY_TTL_DAYS_BY_PLATFORM_KEY}`);
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
    // Per-platform backend ("touch") switches only exist for the platforms the
    // WORKFLOW can scan (x, reddit). LinkedIn has no backend scan adapter — it is
    // extension-only — so only the global switch applies to it.
    if (platform === 'x' || platform === 'reddit') {
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
    // Per-platform window override env var. New platforms get their own name so
    // they never silently inherit Reddit's override; an unset var just falls
    // through to DEFAULT_SCAN_FRESHNESS_HOURS[platform] below.
    const envName = `ENGAGE_${platform.toUpperCase()}_SCAN_WINDOW_HOURS`;
    const envH = Number(process.env[envName]);
    const fallback =
      Number.isFinite(envH) && envH > 0 ? envH : DEFAULT_SCAN_FRESHNESS_HOURS[platform];
    const hours = num(stored?.[platform], fallback);
    return hours * 3_600_000;
  }

  /**
   * Resolve the platforms the extension is allowed to scan, preferring the
   * admin-configured operation-plan allowlist (`operation_plan.allowed_platforms`
   * — the same list the plan-creation platform picker uses), intersected with the
   * platforms the extension can actually scan (x/reddit/linkedin). Falls back to
   * the `ENGAGE_SUPPORTED_PLATFORMS` env allowlist, then to `x,reddit`, when the
   * setting is empty/absent — i.e. `settings.operation_plan.allowed_platforms ||
   * ENGAGE_SUPPORTED_PLATFORMS`. Never throws (allowlist is a gate, not a hot
   * path): a Settings read hiccup degrades to the env fallback.
   */
  async getSupportedScanPlatforms(): Promise<ScanPlatform[]> {
    let configured: unknown = null;
    try {
      configured = await this._settings.get(OPERATION_PLAN_ALLOWED_PLATFORMS_SETTING);
    } catch (err) {
      this.logger.warn(
        `operation_plan.allowed_platforms read failed; using ENGAGE_SUPPORTED_PLATFORMS: ${(err as Error).message}`
      );
    }
    const fromSettings = toScanPlatforms(configured);
    if (fromSettings.length) return fromSettings;
    return toScanPlatforms(process.env.ENGAGE_SUPPORTED_PLATFORMS ?? 'x,reddit');
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

  /**
   * Resolve ONE platform's opportunity TTL (days) WITH its source:
   *   per-platform setting → env `ENGAGE_<PLATFORM>_OPPORTUNITY_TTL_DAYS`
   *     → legacy single-value setting (only when no per-platform map exists)
   *     → env ENGAGE_OPPORTUNITY_TTL_DAYS
   *     → per-platform default
   * `source` lets the admin UI show where the live value came from (same shape
   * as resolveXScanMaxResults). See resolveOpportunityTtlFor for the rules.
   */
  async resolveOpportunityTtlDays(
    platform: ScanPlatform
  ): Promise<{ value: number; source: SettingSource }> {
    const [storedMap, legacy] = await this._readTtlSettings();
    return resolveOpportunityTtlFor(platform, storedMap, legacy);
  }

  /** Effective TTL (days) for one platform. */
  async getOpportunityTtlDays(platform: ScanPlatform): Promise<number> {
    return (await this.resolveOpportunityTtlDays(platform)).value;
  }

  /**
   * Every platform's effective TTL from ONE pair of Settings reads. This is the
   * hot-path reader: the ingest TTL gate runs it per batch (up to three times
   * per ingest) and the hourly sweeps run it per tick, so resolving platform by
   * platform would mean 7-14 uncached `findUnique` round-trips each time —
   * SettingsService.get hits Postgres on every call.
   */
  async getOpportunityTtlDaysMap(): Promise<OpportunityTtlDays> {
    const [storedMap, legacy] = await this._readTtlSettings();
    return Object.fromEntries(
      SCANNABLE_PLATFORMS.map((p) => [
        p,
        resolveOpportunityTtlFor(p, storedMap, legacy).value,
      ])
    ) as OpportunityTtlDays;
  }

  /** The two Settings keys the TTL chain can consult, read concurrently. */
  private async _readTtlSettings(): Promise<
    [Partial<OpportunityTtlDays> | null, unknown]
  > {
    return Promise.all([
      this._settings.get<Partial<OpportunityTtlDays>>(
        ENGAGE_OPPORTUNITY_TTL_DAYS_BY_PLATFORM_KEY
      ),
      this._settings.get(ENGAGE_OPPORTUNITY_TTL_DAYS_KEY),
    ]);
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
  // Merge EVERY platform key present in the base (derived from ScanPlatform via
  // DEFAULT_SCAN_PACING) so adding a platform is a one-line change to the
  // defaults, never a per-key edit here. Platform keys come from base.workflow (a
  // pure Record<ScanPlatform, …>); base.extension also carries interUnit/session,
  // which are merged explicitly below and must be excluded from the per-platform loop.
  const platformKeys = Object.keys(base.workflow) as ScanPlatform[];
  const mergePlatformRecord = (
    baseRec: Record<ScanPlatform, PerPlatformPacing>,
    overrideRec: Record<string, Partial<PerPlatformPacing>>
  ): Record<ScanPlatform, PerPlatformPacing> => {
    const out = {} as Record<ScanPlatform, PerPlatformPacing>;
    for (const key of platformKeys) {
      out[key] = mergePlatform(baseRec[key], overrideRec?.[key]);
    }
    return out;
  };
  return {
    workflow: mergePlatformRecord(base.workflow, ow),
    extension: {
      ...mergePlatformRecord(base.extension, oe),
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

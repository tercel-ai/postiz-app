import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';

// ─── Settings key (admin-configurable via /admin/settings, no redeploy) ───────
export const ENGAGE_SCAN_PACING_KEY = 'engage_scan_pacing';

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
    x: {
      initial: { maxPages: 5, pageDelayMs: 300, jitterMs: 300 },
      incremental: { maxPages: 5, pageDelayMs: 300, jitterMs: 300 },
    },
    reddit: {
      initial: { maxPages: 5, pageDelayMs: 1200, jitterMs: 600 },
      incremental: { maxPages: 5, pageDelayMs: 1200, jitterMs: 600 },
    },
  },
  extension: {
    x: {
      initial: { maxPages: 3, pageDelayMs: 8000, jitterMs: 60000 },
      incremental: { maxPages: 1, pageDelayMs: 8000, jitterMs: 60000 },
    },
    reddit: {
      initial: { maxPages: 3, pageDelayMs: 5000, jitterMs: 60000 },
      incremental: { maxPages: 1, pageDelayMs: 5000, jitterMs: 60000 },
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

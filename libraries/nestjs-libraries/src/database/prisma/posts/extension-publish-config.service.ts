import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import {
  DEFAULT_SEGMENT_GAP_RANGE,
  DEFAULT_SEGMENT_GAP_S,
  MAX_SEGMENT_GAP_S,
  PublishPlatform,
  SegmentGapRange,
} from '@gitroom/helpers/extension/post-publish';

// ─── Settings key (admin-configurable via /admin/settings, no redeploy) ───────
export const EXTENSION_PUBLISH_SEGMENT_GAP_KEY = 'extension_publish.segment_gap';

/** Resolved per-platform view — what publish-due stamping and the admin GET consume. */
export type SegmentGapConfig = Record<PublishPlatform, SegmentGapRange>;

/**
 * Stored setting shape: one global `default` range plus optional per-platform
 * overrides. A platform resolves to `platforms[p]` when that entry is a
 * well-formed range, else to `default`, else to the built-in
 * DEFAULT_SEGMENT_GAP_RANGE — so an admin tunes ONE value to move every
 * platform and only pins the platforms that should differ.
 */
export interface SegmentGapSetting {
  default?: SegmentGapRange;
  platforms?: Partial<Record<PublishPlatform, SegmentGapRange>>;
}

export const DEFAULT_SEGMENT_GAP_SETTING: SegmentGapSetting = {
  default: DEFAULT_SEGMENT_GAP_RANGE,
  platforms: {},
};

/**
 * Owns the extension publish pacing config: the random pause range
 * ([minSeconds, maxSeconds]) drawn between THREAD segments when the browser
 * extension publishes a multi-segment post. Stored in the Settings table so an
 * admin can tune it without a redeploy (edit via
 * PUT /admin/settings/extension_publish.segment_gap); resolution per platform
 * is platform override → stored global default → built-in default, and any
 * malformed range falls through to the next tier so a bad edit can never
 * remove the human-like pause. The resolved range rides on each publish-due
 * item as `segmentGapSeconds` — the extension itself stays config-free.
 */
@Injectable()
export class ExtensionPublishConfigService implements OnModuleInit {
  private readonly logger = new Logger(ExtensionPublishConfigService.name);

  constructor(private readonly _settings: SettingsService) {}

  async onModuleInit(): Promise<void> {
    const existing = await this._settings.get(EXTENSION_PUBLISH_SEGMENT_GAP_KEY);
    if (existing === null || existing === undefined) {
      await this._settings.set(
        EXTENSION_PUBLISH_SEGMENT_GAP_KEY,
        DEFAULT_SEGMENT_GAP_SETTING,
        {
          type: 'object',
          description:
            'Extension publish segment-gap: { default: [minSeconds, maxSeconds], platforms: { <platform>: [min, max] } }. A random pause in the range is drawn between the segments of one thread (never between different posts). A platform without its own entry uses `default`. [0, 0] disables the pause; each bound is capped at 600s.',
          defaultValue: DEFAULT_SEGMENT_GAP_SETTING,
        }
      );
      this.logger.log(`Seeded default ${EXTENSION_PUBLISH_SEGMENT_GAP_KEY}`);
    }
  }

  /** Effective per-platform gap config: stored setting resolved onto the defaults. */
  async getSegmentGaps(): Promise<SegmentGapConfig> {
    const stored = await this._settings.get<SegmentGapSetting>(
      EXTENSION_PUBLISH_SEGMENT_GAP_KEY
    );
    return resolveSegmentGaps(stored);
  }
}

/**
 * Resolve the stored setting to the effective per-platform map. Per platform:
 * platform override → stored global default → built-in default; a tier only
 * wins when it is a well-formed [min, max] (finite numbers, 0 ≤ min ≤ max),
 * and both bounds are clamped to MAX_SEGMENT_GAP_S, mirroring the cap the
 * extension queue applies when drawing the pause.
 *
 * Also accepts the legacy flat shape (a bare per-platform map with no
 * `default`/`platforms` wrapper) written by the first version of this setting,
 * treating it as `platforms`.
 */
export function resolveSegmentGaps(
  stored: SegmentGapSetting | null | undefined
): SegmentGapConfig {
  const normalized = normalizeSetting(stored);
  const globalDefault = isValidRange(normalized.default)
    ? clampRange(normalized.default)
    : null;
  const out = {} as SegmentGapConfig;
  for (const platform of Object.keys(DEFAULT_SEGMENT_GAP_S) as PublishPlatform[]) {
    const override = normalized.platforms?.[platform];
    out[platform] = isValidRange(override)
      ? clampRange(override)
      : globalDefault ?? DEFAULT_SEGMENT_GAP_S[platform];
  }
  return out;
}

function normalizeSetting(
  stored: SegmentGapSetting | null | undefined
): SegmentGapSetting {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  if ('default' in stored || 'platforms' in stored) return stored;
  // Legacy flat shape: the object IS the per-platform map.
  return { platforms: stored as SegmentGapSetting['platforms'] };
}

function isValidRange(value: unknown): value is SegmentGapRange {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    value[0] >= 0 &&
    value[1] >= value[0]
  );
}

function clampRange([min, max]: SegmentGapRange): SegmentGapRange {
  const lo = Math.min(min, MAX_SEGMENT_GAP_S);
  const hi = Math.max(lo, Math.min(max, MAX_SEGMENT_GAP_S));
  return [lo, hi];
}

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import {
  DEFAULT_SEGMENT_GAP_RANGE,
  DEFAULT_SEGMENT_GAP_S,
  EXTENSION_PUBLISHABLE_PLATFORMS,
  MAX_SEGMENT_GAP_S,
  PublishPlatform,
  SegmentGapRange,
} from '@gitroom/helpers/extension/post-publish';

dayjs.extend(utc);
dayjs.extend(timezone);

// ─── Settings key (admin-configurable via /admin/settings, no redeploy) ───────
export const EXTENSION_PUBLISH_SEGMENT_GAP_KEY = 'extension_publish.segment_gap';

// ─── Per-platform publish TIME WINDOW ──────────────────────────────────────
export const EXTENSION_PUBLISH_TIME_WINDOW_KEY = 'extension_publish.time_window';

/** 'HH:MM' local bounds + the IANA timezone they're expressed in. */
export interface PublishTimeWindow {
  windowStart: string;
  windowEnd: string;
  /** IANA timezone; absent/invalid resolves to UTC. */
  timezone?: string;
}

/**
 * Stored setting shape: one global `default` window plus optional per-platform
 * overrides — same default→override→built-in resolution as SegmentGapSetting.
 * No built-in non-empty default here (unlike segment-gap): an unconfigured
 * platform has NO window, so nothing about today's publish times changes until
 * an admin opts a platform in.
 */
export interface PublishTimeWindowSetting {
  default?: PublishTimeWindow;
  platforms?: Partial<Record<PublishPlatform, PublishTimeWindow>>;
}

export const DEFAULT_PUBLISH_TIME_WINDOW_SETTING: PublishTimeWindowSetting = {
  platforms: {},
};

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

    const existingWindow = await this._settings.get(EXTENSION_PUBLISH_TIME_WINDOW_KEY);
    if (existingWindow === null || existingWindow === undefined) {
      await this._settings.set(
        EXTENSION_PUBLISH_TIME_WINDOW_KEY,
        DEFAULT_PUBLISH_TIME_WINDOW_SETTING,
        {
          type: 'object',
          description:
            'Allowed publish clock-time window per platform: { default?: {windowStart,windowEnd,timezone}, platforms: { <platform>: {windowStart,windowEnd,timezone} } }. windowStart/windowEnd are \'HH:MM\' local to `timezone` (IANA; omitted = UTC); a window that wraps past midnight (e.g. 22:00–02:00) is honoured as a wrap. A platform with NO effective window (no override and no `default`) is unconstrained — this is the out-of-the-box state, so configuring nothing changes nothing. When a plan is scheduled (POST /posts/schedule), any post on a constrained platform whose materialized time falls outside its window is re-picked to a random time inside it, on the same local date.',
          defaultValue: DEFAULT_PUBLISH_TIME_WINDOW_SETTING,
        }
      );
      this.logger.log(`Seeded default ${EXTENSION_PUBLISH_TIME_WINDOW_KEY}`);
    }
  }

  /** Effective per-platform gap config: stored setting resolved onto the defaults. */
  async getSegmentGaps(): Promise<SegmentGapConfig> {
    const stored = await this._settings.get<SegmentGapSetting>(
      EXTENSION_PUBLISH_SEGMENT_GAP_KEY
    );
    return resolveSegmentGaps(stored);
  }

  /**
   * Effective per-platform publish time window. Only returns entries for
   * platforms that resolve to an ACTUAL window (override, or a global
   * `default`) — a platform absent from the result is unconstrained, which the
   * caller (schedulePlanPosts) reads as "leave this post's time alone".
   */
  async getPublishTimeWindows(): Promise<
    Partial<Record<PublishPlatform, PublishTimeWindow>>
  > {
    const stored = await this._settings.get<PublishTimeWindowSetting>(
      EXTENSION_PUBLISH_TIME_WINDOW_KEY
    );
    return resolvePublishTimeWindows(stored);
  }
}

/** Resolve the stored setting to the effective per-platform map (see getPublishTimeWindows). */
export function resolvePublishTimeWindows(
  stored: PublishTimeWindowSetting | null | undefined
): Partial<Record<PublishPlatform, PublishTimeWindow>> {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const globalDefault = isValidWindow(stored.default) ? stored.default : null;
  const out: Partial<Record<PublishPlatform, PublishTimeWindow>> = {};
  const platforms = new Set<PublishPlatform>([
    ...(Object.keys(stored.platforms ?? {}) as PublishPlatform[]),
    ...(globalDefault ? EXTENSION_PUBLISHABLE_PLATFORMS : []),
  ]);
  for (const platform of platforms) {
    const override = stored.platforms?.[platform];
    const resolved = isValidWindow(override) ? override : globalDefault;
    if (resolved) out[platform] = resolved;
  }
  return out;
}

function isValidWindow(value: unknown): value is PublishTimeWindow {
  if (!value || typeof value !== 'object') return false;
  const w = value as Partial<PublishTimeWindow>;
  const toMinutes = (value: unknown): number | null => {
    if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return null;
    const [hours, minutes] = value.split(':').map(Number);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  };
  const start = toMinutes(w.windowStart);
  const end = toMinutes(w.windowEnd);
  if (start === null || end === null || start === end) return false;
  if (w.timezone === undefined) return true;
  if (typeof w.timezone !== 'string' || !w.timezone) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: w.timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * If `date` falls outside `window` (evaluated in the window's local timezone,
 * UTC when omitted — same convention as engage's `withinLocalWindow`), pick a
 * NEW random instant uniformly inside the window and return it; otherwise
 * return `date` unchanged. Deliberately re-picks rather than clamping to the
 * nearest boundary: the incoming time is a plan-generated default with no
 * value worth preserving, so every out-of-window post should scatter across
 * the window rather than pile up on its edge.
 *
 * The window is anchored to `date`'s OWN local calendar day (its `windowStart`
 * instant is that day's start-of-day + windowStart) — for a window that wraps
 * past midnight (e.g. 22:00-02:00) this means the pick can land in the early
 * hours of the FOLLOWING calendar day, which is inherent to what a wrapping
 * night window means and mirrors how `withinLocalWindow` treats the same wrap.
 */
export function redistributePublishTimeIfOutsideWindow(
  date: Date,
  window: Pick<PublishTimeWindow, 'windowStart' | 'windowEnd' | 'timezone'>
): Date {
  const local = window.timezone ? dayjs(date).tz(window.timezone) : dayjs.utc(date);
  const toMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const startMin = toMinutes(window.windowStart);
  const endMin = toMinutes(window.windowEnd);
  const nowMin = local.hour() * 60 + local.minute();
  const wraps = startMin > endMin;
  const inWindow = wraps
    ? nowMin >= startMin || nowMin < endMin
    : nowMin >= startMin && nowMin < endMin;
  if (inWindow) return date;

  const spanMin = wraps ? 24 * 60 - startMin + endMin : endMin - startMin;
  const offsetMin = spanMin > 0 ? Math.floor(Math.random() * spanMin) : 0;
  return local
    .startOf('day')
    .add(startMin + offsetMin, 'minute')
    .toDate();
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

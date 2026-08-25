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

// ─── Per-platform MINIMUM GAP between two posts ────────────────────────────
export const EXTENSION_PUBLISH_MIN_GAP_KEY = 'extension_publish.min_gap';

/**
 * Minutes that must separate two posts of the SAME platform on the same day.
 *
 * 30 rather than something small: this is a best-effort target, not a hard
 * constraint — when the window is too narrow to honour it the allocator
 * degrades (see redistributePublishTimesWithinWindow), so a generous default
 * costs nothing on a tight window and is the only thing that spreads posts out
 * on a wide one. A small default can never be undone: 3 posts landing inside 5
 * minutes of a nine-hour window "satisfies" it, and nothing would pull them
 * apart. For comparison the engage reply driver's own minGapMinutes is 25, and
 * an original post is a higher-risk action than a reply.
 *
 * NOT to be confused with the segment gap above: that is the SECONDS-scale
 * pause between the segments of one thread, which is what a real thread looks
 * like. Different posts are not a thread.
 */
export const DEFAULT_MIN_GAP_MINUTES = 30;

/** Sanity ceiling. Above half a day a "gap" is really a schedule, not a pause. */
export const MAX_MIN_GAP_MINUTES = 720;

/**
 * Stored setting shape — same default→override→built-in resolution as
 * SegmentGapSetting, so an admin tunes ONE value to move every platform and
 * only pins the platforms that should differ (Reddit rate-limits low-karma
 * accounts and wants more; a low-frequency long-form channel wants less).
 */
export interface MinGapSetting {
  default?: number;
  platforms?: Partial<Record<PublishPlatform, number>>;
}

export const DEFAULT_MIN_GAP_SETTING: MinGapSetting = {
  default: DEFAULT_MIN_GAP_MINUTES,
  platforms: {},
};

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
            'Allowed publish clock-time window per platform: { default?: {windowStart,windowEnd,timezone}, platforms: { <platform>: {windowStart,windowEnd,timezone} } }. windowStart/windowEnd are \'HH:MM\' local to `timezone` (IANA; omitted = UTC); a window that wraps past midnight (e.g. 22:00–02:00) is honoured as a wrap. A platform with NO effective window (no override and no `default`) is unconstrained — this is the out-of-the-box state, so configuring nothing changes nothing. When a plan is activated (POST /projects/:projectId/automation/publishing), any post on a constrained platform whose materialized time falls outside its window is re-picked to a random time inside it, on the same local date. A project may narrow this window further through its own Automation settings; the project tier wins over these.',
          defaultValue: DEFAULT_PUBLISH_TIME_WINDOW_SETTING,
        }
      );
      this.logger.log(`Seeded default ${EXTENSION_PUBLISH_TIME_WINDOW_KEY}`);
    }

    const existingMinGap = await this._settings.get(EXTENSION_PUBLISH_MIN_GAP_KEY);
    if (existingMinGap === null || existingMinGap === undefined) {
      await this._settings.set(EXTENSION_PUBLISH_MIN_GAP_KEY, DEFAULT_MIN_GAP_SETTING, {
        type: 'object',
        description:
          'Minimum minutes between two posts of the SAME platform on the same day: { default: 30, platforms: { <platform>: 45 } }. Applied when plan posts are redistributed into their publish time window — it is a best-effort TARGET, not a hard constraint: a window too narrow to honour it degrades to an even spread rather than pushing a post outside the window. Distinct from extension_publish.segment_gap, which is the seconds-scale pause between the segments of ONE thread. 0 disables spacing; capped at 720.',
        defaultValue: DEFAULT_MIN_GAP_SETTING,
      });
      this.logger.log(`Seeded default ${EXTENSION_PUBLISH_MIN_GAP_KEY}`);
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

  /** Effective per-platform minimum gap in minutes (see resolveMinGaps). */
  async getMinGapMinutes(): Promise<Record<PublishPlatform, number>> {
    const stored = await this._settings.get<MinGapSetting>(EXTENSION_PUBLISH_MIN_GAP_KEY);
    return resolveMinGaps(stored);
  }
}

/**
 * Resolve the stored setting to the effective per-platform map. Per platform:
 * platform override → stored global default → built-in default; a tier only
 * wins when it is a finite number ≥ 0, and the result is capped at
 * MAX_MIN_GAP_MINUTES. Mirrors resolveSegmentGaps so a malformed edit falls
 * through to the next tier instead of silently disabling spacing.
 */
export function resolveMinGaps(
  stored: MinGapSetting | null | undefined
): Record<PublishPlatform, number> {
  const isValid = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const clamp = (value: number) => Math.min(value, MAX_MIN_GAP_MINUTES);
  const normalized =
    stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const globalDefault = isValid(normalized.default)
    ? clamp(normalized.default)
    : DEFAULT_MIN_GAP_MINUTES;
  const out = {} as Record<PublishPlatform, number>;
  for (const platform of EXTENSION_PUBLISHABLE_PLATFORMS) {
    const override = normalized.platforms?.[platform];
    out[platform] = isValid(override) ? clamp(override) : globalDefault;
  }
  return out;
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

/**
 * A window is only usable when both bounds are 'HH:MM' clock times that differ
 * and the timezone (when present) is a real IANA zone. Exported because the
 * PROJECT-level window override (ProjectPublishingService) must accept exactly
 * what the admin-level setting accepts — one rule, so a value that survives one
 * tier can never be silently dropped by the other.
 */
export function isValidWindow(value: unknown): value is PublishTimeWindow {
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
  const { startMin, endMin, wraps } = windowBounds(window);
  const nowMin = local.hour() * 60 + local.minute();
  const inWindow = wraps
    ? nowMin >= startMin || nowMin < endMin
    : nowMin >= startMin && nowMin < endMin;
  if (inWindow) return date;

  const { start, spanMin } = windowInstanceOn(local.format('YYYY-MM-DD'), window);
  if (spanMin <= 0) return date;
  return start.add(Math.floor(Math.random() * spanMin), 'minute').toDate();
}

/** One post's identity + planned time, as the window allocator sees it. */
export interface WindowAllocatable {
  id: string;
  publishDate: Date;
  /**
   * Whether this post may be moved. Default true.
   *
   * A post that is NOT movable still takes part: it occupies its slot and the
   * gap is measured against it. That is the whole reason the flag exists —
   * placing a DRAFT has to account for the QUEUE posts already sitting in the
   * same window (and vice versa), or the two passes would happily put a post on
   * top of one the other pass just placed.
   */
  movable?: boolean;
}

/** What the allocator did, for logging — see redistributePublishTimesWithinWindow. */
export interface WindowAllocationResult {
  /** New instant per moved post id. Posts already inside the window are ABSENT. */
  moved: Map<string, Date>;
  /** Window instances where minGapMinutes could not be honoured in full. */
  degraded: Array<{ windowStart: Date; requestedGapMinutes: number; appliedGapMinutes: number }>;
}

/**
 * Wall-clock geometry of a window: the two bounds in minutes-of-day, and
 * whether it wraps past midnight.
 *
 * Deliberately NOT a duration. `18:00 - 09:00` is nine hours on the clock but
 * eight or ten real hours on a DST transition day, and every duration this file
 * needs is a real one — see windowInstanceOn.
 */
function windowBounds(window: Pick<PublishTimeWindow, 'windowStart' | 'windowEnd'>) {
  const toMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const startMin = toMinutes(window.windowStart);
  const endMin = toMinutes(window.windowEnd);
  return { startMin, endMin, wraps: startMin > endMin };
}

/** Calendar-day arithmetic, done in UTC so no DST-length day can distort it. */
function shiftDay(dayStamp: string, days: number): string {
  return dayjs.utc(dayStamp).add(days, 'day').format('YYYY-MM-DD');
}

/**
 * The concrete occurrence of `window` that OPENS on the local day `dayStamp`
 * ('YYYY-MM-DD'): the instant it opens, and how many REAL minutes it lasts.
 *
 * Both bounds are resolved as WALL-CLOCK times rather than by adding minutes to
 * midnight, because across a DST transition those are not the same thing:
 * midnight + 9h is 10:00 on a spring-forward day, and a 09:00-18:00 window is
 * only eight real hours long that day (ten on the fall-back day). Anchoring on
 * the wall clock is what makes "09:00 to 18:00" mean the same hours every day of
 * the year — which is the whole point of expressing a window in local time.
 *
 * Offsets are then REAL minutes from `start`, so a time picked inside
 * [0, spanMin) always lands inside the wall-clock window too.
 */
function windowInstanceOn(
  dayStamp: string,
  window: Pick<PublishTimeWindow, 'windowStart' | 'windowEnd' | 'timezone'>
): { start: dayjs.Dayjs; spanMin: number } {
  const at = (day: string, hhmm: string) => {
    const stamp = `${day}T${hhmm}:00`;
    return window.timezone ? dayjs.tz(stamp, window.timezone) : dayjs.utc(stamp);
  };
  const { wraps } = windowBounds(window);
  const start = at(dayStamp, window.windowStart);
  const end = at(wraps ? shiftDay(dayStamp, 1) : dayStamp, window.windowEnd);
  return { start, spanMin: end.diff(start, 'minute') };
}

/**
 * The sub-intervals of [0, span) that are at least `gap` minutes away from
 * every already-occupied offset. Window EDGES do not impose a gap — only other
 * posts do — so a post may sit at the very start or end of the window.
 */
function freeIntervals(
  spanMin: number,
  occupied: number[],
  gapMin: number
): Array<[number, number]> {
  if (gapMin <= 0) return [[0, spanMin]];
  const blocked = occupied
    .map((point): [number, number] => [point - gapMin, point + gapMin])
    .sort((a, b) => a[0] - b[0]);
  const free: Array<[number, number]> = [];
  let cursor = 0;
  for (const [from, to] of blocked) {
    if (from > cursor) free.push([cursor, Math.min(from, spanMin)]);
    cursor = Math.max(cursor, to);
    if (cursor >= spanMin) break;
  }
  if (cursor < spanMin) free.push([cursor, spanMin]);
  return free.filter(([from, to]) => to > from);
}

/** How many placement retries before a gap tier is declared unusable. */
const PLACEMENT_ATTEMPTS = 8;

/**
 * Place `count` new offsets inside [0, span), each at least `gap` from every
 * occupied offset AND from each other. Random rather than evenly spaced — the
 * point is to look like a person, not a cron — which means a greedy pass can
 * paint itself into a corner, hence the retries. Returns null when it could not
 * fit them, which is the caller's signal to degrade the gap.
 */
function placeWithGap(
  spanMin: number,
  occupied: number[],
  count: number,
  gapMin: number
): number[] | null {
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
    const points = [...occupied];
    const placed: number[] = [];
    let ok = true;
    for (let i = 0; i < count; i++) {
      const free = freeIntervals(spanMin, points, gapMin);
      const total = free.reduce((sum, [from, to]) => sum + (to - from), 0);
      if (total <= 0) {
        ok = false;
        break;
      }
      let roll = Math.random() * total;
      let picked = free[0][0];
      for (const [from, to] of free) {
        if (roll < to - from) {
          picked = from + roll;
          break;
        }
        roll -= to - from;
      }
      placed.push(picked);
      points.push(picked);
    }
    if (ok) return placed;
    // gap 0 can only fail on a zero-width window, which no retry fixes.
    if (gapMin <= 0) return null;
  }
  return null;
}

/**
 * Redistribute a batch of posts into their platform's publish window, keeping
 * them at least `minGapMinutes` apart.
 *
 * The group-aware counterpart of redistributePublishTimeIfOutsideWindow, and it
 * exists because that function is per-post and blind: two posts it re-picks
 * independently can land in the same minute, which is exactly what a minimum
 * gap is for. Batching by window INSTANCE (one platform, one local day's
 * occurrence of the window) is what lets a placement see its siblings.
 *
 * ONLY posts OUTSIDE the window move, and only those marked movable. A post
 * already inside the window is a fixed point: its time is either already
 * compliant or something a person chose, and re-rolling it would make every save
 * of the automation settings shuffle times that were fine. The consequence is
 * that two in-window posts sitting a minute apart STAY a minute apart — the gap
 * is enforced against the posts being placed, not retrofitted onto the whole
 * day. A post marked `movable: false` is pinned wherever it is, inside the
 * window or not, and still occupies its slot (see WindowAllocatable.movable).
 *
 * When the window cannot hold everything at `minGapMinutes`, the gap degrades
 * — full gap → an even span/(n+1) share → none at all — rather than the window
 * being widened. Overflowing the window is the precise thing this whole
 * mechanism exists to prevent, so it is never traded for spacing; a window too
 * narrow for its posts is a configuration problem and is reported in
 * `degraded` so the caller can say so out loud.
 */
/** A post whose slot has already passed and needs a new one. */
export interface PastDueAllocatable {
  id: string;
  publishDate: Date;
}

/** How far ahead the deferral pass will look for room before giving up. */
const MAX_DEFER_DAYS = 90;

/**
 * Give past-due posts the NEXT available slots, spread across as many future
 * window occurrences as it takes.
 *
 * Why this exists: a switch that parks the queue (QUEUE -> DRAFT) leaves every
 * parked post holding the slot the plan gave it. Switch back on a week later
 * and every one of those slots is in the past, so committing them means the
 * publish-due query returns the whole week at once and the extension posts them
 * back to back — the burst that pacing exists to prevent, arriving the moment
 * the user turns automation on.
 *
 * Distinct from redistributePublishTimesWithinWindow, which anchors each post
 * to the window occurrence on its OWN day and deliberately refuses to move
 * anything into the past. That is right for realignment and useless here: these
 * posts' own days are gone. This walks FORWARD from `after` instead, filling
 * each occurrence subject to the same minimum gap, and spilling into the next
 * day when one is full.
 *
 * `occupiedFuture` is every slot already taken on this platform (posts that are
 * still in the future), so a deferred post never lands on top of one.
 *
 * Order is preserved: the post that was scheduled first is placed first, so a
 * thread of a plan's content keeps the sequence its author intended.
 */
export function deferPastDueIntoWindow(
  pastDue: PastDueAllocatable[],
  occupiedFuture: Date[],
  window: Pick<PublishTimeWindow, 'windowStart' | 'windowEnd' | 'timezone'>,
  minGapMinutes: number,
  after: Date
): Map<string, Date> {
  const placed = new Map<string, Date>();
  const { startMin, endMin } = windowBounds(window);
  if (!pastDue.length || startMin === endMin) return placed;

  const queue = [...pastDue].sort(
    (a, b) => a.publishDate.valueOf() - b.publishDate.valueOf()
  );
  const gap = Math.max(0, minGapMinutes);
  const afterMs = after.valueOf();
  let day = (window.timezone ? dayjs(after).tz(window.timezone) : dayjs.utc(after))
    .format('YYYY-MM-DD');

  for (let dayIndex = 0; dayIndex < MAX_DEFER_DAYS && queue.length; dayIndex++) {
    const { start, spanMin } = windowInstanceOn(day, window);
    day = shiftDay(day, 1);
    if (spanMin <= 0) continue;

    const startMs = start.valueOf();
    const toOffset = (at: number) => (at - startMs) / 60_000;
    const inThisInstance = (offset: number) => offset >= 0 && offset < spanMin;

    // Everything already sitting in this occurrence — other posts' slots, and
    // whatever earlier iterations of this loop put here.
    const occupied = [
      ...occupiedFuture.map((at) => toOffset(at.valueOf())),
      ...[...placed.values()].map((at) => toOffset(at.valueOf())),
    ].filter(inThisInstance);

    // Never place before `after`: the window may have opened hours ago.
    const earliest = Math.max(0, Math.ceil(toOffset(afterMs)));
    if (earliest >= spanMin) continue;

    // Recomputed per placement: each one becomes an obstacle for the next.
    while (queue.length) {
      const slot = freeIntervals(spanMin, occupied, gap)
        .map(([from, to]): [number, number] => [Math.max(from, earliest), to])
        .find(([from, to]) => from < to);
      if (!slot) break;
      const offset = slot[0];
      placed.set(queue.shift()!.id, new Date(startMs + offset * 60_000));
      occupied.push(offset);
    }
  }

  return placed;
}

export function redistributePublishTimesWithinWindow(
  posts: WindowAllocatable[],
  window: Pick<PublishTimeWindow, 'windowStart' | 'windowEnd' | 'timezone'>,
  minGapMinutes: number
): WindowAllocationResult {
  const moved = new Map<string, Date>();
  const degraded: WindowAllocationResult['degraded'] = [];
  const { startMin, endMin, wraps } = windowBounds(window);
  if (!posts.length || startMin === endMin) return { moved, degraded };

  const localOf = (date: Date) =>
    window.timezone ? dayjs(date).tz(window.timezone) : dayjs.utc(date);

  // Bucket by window INSTANCE: the concrete occurrence of the window a post
  // sits in (or would be placed into). Keyed by that occurrence's start instant
  // so a wrapping window's late-night and early-morning halves are one bucket.
  const buckets = new Map<
    string,
    {
      start: dayjs.Dayjs;
      spanMin: number;
      occupied: number[];
      toPlace: WindowAllocatable[];
    }
  >();
  for (const post of posts) {
    const local = localOf(post.publishDate);
    const nowMin = local.hour() * 60 + local.minute();
    const inWindow = wraps
      ? nowMin >= startMin || nowMin < endMin
      : nowMin >= startMin && nowMin < endMin;
    // Pinned posts occupy wherever they are — including OUTSIDE the window.
    // A pinned out-of-window post is one nothing may move (already claimed, or
    // about to publish); it is going out at that time whether the window likes
    // it or not, so the gap must still be measured against it.
    const pinned = post.movable === false;
    // An in-window post in a wrapping window's early-morning tail belongs to
    // the occurrence that STARTED yesterday. Out-of-window posts anchor to
    // their own local day, matching redistributePublishTimeIfOutsideWindow.
    const localDay = local.format('YYYY-MM-DD');
    const { start, spanMin } = windowInstanceOn(
      inWindow && wraps && nowMin < endMin ? shiftDay(localDay, -1) : localDay,
      window
    );
    const key = start.toISOString();
    const bucket = buckets.get(key) ?? { start, spanMin, occupied: [], toPlace: [] };
    if (inWindow || pinned) {
      bucket.occupied.push(local.diff(start, 'minute'));
    } else {
      bucket.toPlace.push(post);
    }
    buckets.set(key, bucket);
  }

  for (const bucket of buckets.values()) {
    // spanMin is resolved PER INSTANCE, not once for the window: a DST
    // transition makes one day's occurrence an hour shorter (or longer) than
    // its neighbours, and packing posts into it uses the length it actually has.
    const spanMin = bucket.spanMin;
    if (!bucket.toPlace.length || spanMin <= 0) continue;
    const total = bucket.occupied.length + bucket.toPlace.length;
    // Ladder, most generous first. The even share is what a fully-packed window
    // could manage at best; 0 always succeeds and is the floor.
    const tiers = [minGapMinutes, spanMin / (total + 1), 0].filter(
      (gap, index, all) => gap >= 0 && all.indexOf(gap) === index
    );
    for (const gap of tiers) {
      const offsets = placeWithGap(spanMin, bucket.occupied, bucket.toPlace.length, gap);
      if (!offsets) continue;
      if (gap < minGapMinutes) {
        degraded.push({
          windowStart: bucket.start.toDate(),
          requestedGapMinutes: minGapMinutes,
          appliedGapMinutes: gap,
        });
      }
      bucket.toPlace.forEach((post, index) => {
        moved.set(post.id, bucket.start.add(offsets[index], 'minute').toDate());
      });
      break;
    }
  }

  return { moved, degraded };
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

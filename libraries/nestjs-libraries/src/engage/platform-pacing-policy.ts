import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import {
  DEFAULT_PLATFORM_PACING,
  withinPacingWindow,
  type PacingWindow,
  type PlatformPacing,
  type PlatformPacingEntry,
} from '@gitroom/helpers/extension/platform-pacing';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Resolve a stored value onto the built-in floor.
 *
 * A stored config that is missing, malformed, or only partially filled in must
 * never REMOVE the floor — every tier falls through to the shipped default, the
 * same posture the segment-gap and min-gap settings already take. The one thing
 * an admin can do here is make the floor wider or narrower, never absent.
 */
export function sanitizePlatformPacing(stored: unknown): PlatformPacing {
  if (!stored || typeof stored !== 'object') return DEFAULT_PLATFORM_PACING;
  const raw = stored as Partial<PlatformPacing>;
  const platforms: Record<string, PlatformPacingEntry> = {};
  if (raw.platforms && typeof raw.platforms === 'object') {
    for (const [key, entry] of Object.entries(raw.platforms)) {
      if (!entry || typeof entry !== 'object') continue;
      const clean: PlatformPacingEntry = { ...(entry as PlatformPacingEntry) };
      // A malformed window must not survive: it reaches the PUBLISH allocator,
      // which reads `window.windowStart.split(':')` and `dayjs.tz(...)`
      // unguarded. Dropping it leaves the platform unconstrained — the same
      // failure direction the old resolvePublishTimeWindows took, and the same
      // one the reply side takes when withinPacingWindow fails closed.
      if (!pickWindow(clean.window)) delete clean.window;
      platforms[key] = clean;
    }
  }
  return {
    default: {
      write: pickRange(raw.default?.write, DEFAULT_PLATFORM_PACING.default.write),
      read: pickRange(raw.default?.read, DEFAULT_PLATFORM_PACING.default.read),
      // An unset window is a meaningful value ("unconstrained"), so it must
      // survive as absent — but a malformed one is dropped rather than passed
      // on, for the reason above.
      ...(pickWindow(raw.default?.window) ? { window: raw.default!.window } : {}),
    },
    platforms,
  };
}

/**
 * A window wins only when it is structurally usable: 'HH:MM' bounds inside real
 * clock ranges, a non-empty span, and — when present — a timezone the runtime
 * can actually resolve.
 *
 * This restores the check `resolvePublishTimeWindows`/`isValidWindow` used to
 * apply before the window moved here. Without it the publish allocator receives
 * whatever JSON an admin PUT: `{start,end}` (wrong field names) reaches
 * `window.windowStart.split(':')` as undefined, and an unresolvable zone reaches
 * `dayjs.tz` — a TypeError and a RangeError respectively, both thrown from plan
 * activation rather than being quietly ignored.
 *
 * The reply side needs no equivalent because `withinPacingWindow` already fails
 * closed; dropping the value here makes the two sides agree on "unusable window
 * = no window" instead of one refusing and the other throwing.
 */
function pickWindow(candidate: unknown): candidate is PacingWindow {
  if (!candidate || typeof candidate !== 'object') return false;
  const w = candidate as Partial<PacingWindow>;
  const toMinutes = (v: unknown): number | null => {
    if (typeof v !== 'string' || !/^\d{2}:\d{2}$/.test(v)) return null;
    const [hours, minutes] = v.split(':').map(Number);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  };
  const start = toMinutes(w.windowStart);
  const end = toMinutes(w.windowEnd);
  // start === end is how an empty window is spelled — it would block every
  // write, so it is treated as unusable rather than honoured.
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

/** A range wins only when both bounds are finite, ordered and non-negative. */
function pickRange(
  candidate: unknown,
  fallback: [number, number]
): [number, number] {
  if (!Array.isArray(candidate) || candidate.length !== 2) return fallback;
  const [lo, hi] = candidate as [unknown, unknown];
  if (typeof lo !== 'number' || typeof hi !== 'number') return fallback;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return fallback;
  if (lo < 0 || hi < lo) return fallback;
  return [lo, hi];
}

/**
 * Wall-clock geometry of a window: the two bounds in minutes-of-day, and
 * whether it wraps past midnight.
 *
 * Deliberately NOT a duration. `18:00 - 09:00` is nine hours on the clock but
 * eight or ten real hours on a DST transition day, and every duration this file
 * needs is a real one — see windowInstanceOn.
 */
export function windowBounds(window: Pick<PacingWindow, 'windowStart' | 'windowEnd'>) {
  const toMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const startMin = toMinutes(window.windowStart);
  const endMin = toMinutes(window.windowEnd);
  return { startMin, endMin, wraps: startMin > endMin };
}

/** Calendar-day arithmetic, done in UTC so no DST-length day can distort it. */
export function shiftDay(dayStamp: string, days: number): string {
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
export function windowInstanceOn(
  dayStamp: string,
  window: PacingWindow
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

const MINUTES_PER_UTC_DAY = 24 * 60;
const MS_PER_MINUTE = 60_000;
const MS_PER_UTC_DAY = MINUTES_PER_UTC_DAY * MS_PER_MINUTE;

/** Enumerate physical UTC intervals so a repeated hour can't reorder adjacent civil windows. */
function writeIntervalsOnUtcDay(dayStart: number, window: PacingWindow): Array<[number, number]> {
  const dayEnd = dayStart + MS_PER_UTC_DAY;
  const zone = window.timezone;
  const initialOffset = zone ? dayjs(dayStart).tz(zone).utcOffset() : 0;
  if (!zone || dayjs(dayEnd - 1).tz(zone).utcOffset() === initialOffset) {
    const { startMin, endMin } = windowBounds(window);
    const inUtcDay = (localMinute: number) => dayStart +
      ((localMinute - initialOffset + MINUTES_PER_UTC_DAY) % MINUTES_PER_UTC_DAY) * MS_PER_MINUTE;
    const start = inUtcDay(startMin);
    const end = inUtcDay(endMin);
    return start < end ? [[start, end]] : [[dayStart, end], [start, dayEnd]];
  }

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const intervals: Array<[number, number]> = [];
  for (let at = dayStart; at < dayEnd; at += MS_PER_MINUTE) {
    const open = withinPacingWindow(window, new Date(at), (date) => {
      const [hour, minute] = formatter.format(date).split(':').map(Number);
      return hour * 60 + minute;
    });
    if (!open) continue;
    const last = intervals.at(-1);
    if (last?.[1] === at) last[1] += MS_PER_MINUTE;
    else intervals.push([at, at + MS_PER_MINUTE]);
  }
  return intervals;
}

function* continuousWriteIntervals(window: PacingWindow, floor: number, budgetMs: number) {
  const firstDay = Math.floor(floor / MS_PER_UTC_DAY) * MS_PER_UTC_DAY;
  let open: [number, number] | undefined;
  // A valid window provides at least one minute on ordinary days. The extra days cover clock changes.
  for (let offset = 0; offset <= Math.ceil(budgetMs / MS_PER_MINUTE) + 3; offset++) {
    for (const [start, end] of writeIntervalsOnUtcDay(firstDay + offset * MS_PER_UTC_DAY, window)) {
      if (end <= start) continue;
      if (open && start <= open[1]) open[1] = Math.max(open[1], end);
      else {
        if (open) yield open;
        open = [start, end];
      }
    }
  }
  if (open) yield open;
}

/** Spend preparation time only inside allowed write windows. The budget is anchored to the account floor. */
export function writeWindowPreparation(window: PacingWindow, floor: Date, budgetMs: number, now: Date, minRunwayMs = 0) {
  let remaining = budgetMs;
  let notBefore: Date | undefined;
  let windowEnd: Date | undefined;
  const floorMs = floor.getTime();
  const nowMs = now.getTime();
  for (const [start, end] of continuousWriteIntervals(window, floorMs, budgetMs)) {
    const from = Math.max(start, floorMs);
    if (end <= from) continue;
    const available = end - from;
    const deadline = from + Math.min(remaining, available);
    if (!notBefore && deadline > nowMs && deadline - Math.max(nowMs, from) >= minRunwayMs) {
      notBefore = new Date(from);
      windowEnd = new Date(end);
    }
    if (remaining <= available) {
      // If the only time left is too short for a permit, wait for expiry.
      return { notBefore: notBefore ?? (deadline > nowMs ? new Date(deadline) : floor), windowEnd, deadline };
    }
    remaining -= available;
  }
  throw new Error('Unable to resolve the write window preparation deadline');
}

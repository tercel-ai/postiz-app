import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import isoWeek from 'dayjs/plugin/isoWeek';
import utc from 'dayjs/plugin/utc';

dayjs.extend(customParseFormat);
dayjs.extend(isoWeek);
dayjs.extend(utc);

/** A calendar day with no time part, as a date picker sends it: `2026-09-18`. */
const BARE_DAY = /^\d{4}-\d{2}-\d{2}$/;

export type EngageDateWindowInput = {
  /** Rolling preset: all (default/empty) | day | today | week | month. */
  date?: string;
  /** Exact lower bound. Wins over `date` when both are given. */
  startDate?: string;
  /** Exact upper bound. Combines with `date` / `startDate`. */
  endDate?: string;
};

export type EngageDateWindow = {
  publishDate?: { gte?: Date; lt?: Date; lte?: Date };
};

/**
 * Strict UTC parse. Returns the instant plus whether the caller wrote a DAY or
 * a moment — the two mean different things for an upper bound. Null for
 * anything that is not a real date.
 */
function parseBound(
  value: string
): { at: dayjs.Dayjs; dayOnly: boolean } | null {
  // No clock component → it is a day, and it must be a well-formed one. The
  // strict flag is the point: dayjs is lenient by default and
  // `dayjs.utc('2026-02-30')` reports itself VALID, rolling forward to March
  // 2nd, so a search for a day that does not exist would quietly answer with a
  // different day's replies. `2026-9-8` is refused for the same reason it is
  // refused at the DTO — half-parsed input read as a MOMENT (midnight) rather
  // than a day would exclude that very day from an endDate.
  if (!value.includes('T')) {
    const day = dayjs.utc(value, 'YYYY-MM-DD', true);
    return BARE_DAY.test(value) && day.isValid()
      ? { at: day, dayOnly: true }
      : null;
  }
  const at = dayjs.utc(value);
  return at.isValid() ? { at, dayOnly: false } : null;
}

/**
 * The shared engage window on `Post.publishDate`, used by the /sent family
 * (list, locate, stats, counts) and /dashboard/summary so a filter, the badges
 * counting it and the stats cards above it can never disagree about which rows
 * are in scope.
 *
 * LOWER BOUND — `startDate` if given, else the `date` preset:
 *   `day`/`today` → since UTC midnight, `week` → since the ISO week start,
 *   `month` → since the 1st. `all`/empty/unknown → none (all-time).
 *   `startDate` wins because it is the more specific instruction, matching
 *   `_postPublishedAtFilter` on /opportunities.
 *
 * UPPER BOUND — `endDate`, in whichever precision it was written:
 *   a bare `YYYY-MM-DD` covers the WHOLE of that day (`lt` the next midnight),
 *   a full timestamp is an exact cutoff (`lte`, no rounding).
 *
 * The bare-date rule is what makes a one-day search the obvious thing to write:
 * `startDate=2026-09-18&endDate=2026-09-18` is the 18th. Read as a raw instant
 * it would instead be `>= 00:00 AND <= 00:00` — a window one millisecond wide
 * that returns nothing, which is the single most likely thing a date picker
 * sends. NOTE this deliberately DIVERGES from `/engage/opportunities`, whose
 * `endDate` is documented as applied as-is; that endpoint is left untouched
 * here, so a client using both must not assume identical rounding.
 *
 * TIME ZONE: every bound resolves in **UTC**, matching the presets and every
 * other date in Engage. A client east of UTC asking for "the 18th" gets 18th
 * 00:00Z–19th 00:00Z, which is not their local 18th.
 *
 * Unparseable bounds are DROPPED rather than passed on as Invalid Date (which
 * Prisma rejects at the driver with an opaque error). The DTOs validate with
 * `@IsDateString({ strict: true })`, so over HTTP this is unreachable — it
 * matters only for internal callers.
 */
export function engageDateWindow(
  dto: EngageDateWindowInput = {}
): EngageDateWindow {
  const publishDate: { gte?: Date; lt?: Date; lte?: Date } = {};

  const start = dto.startDate ? parseBound(dto.startDate) : null;
  if (start) {
    publishDate.gte = start.at.toDate();
  } else {
    const preset =
      dto.date === 'day' || dto.date === 'today'
        ? dayjs.utc().startOf('day')
        : dto.date === 'week'
        ? dayjs.utc().startOf('isoWeek')
        : dto.date === 'month'
        ? dayjs.utc().startOf('month')
        : null;
    if (preset) publishDate.gte = preset.toDate();
  }

  const end = dto.endDate ? parseBound(dto.endDate) : null;
  if (end) {
    if (end.dayOnly) {
      // Half-open [.., next midnight) rather than an `lte` end-of-day: there is
      // no last-millisecond to get wrong, whatever precision the column keeps.
      publishDate.lt = end.at.startOf('day').add(1, 'day').toDate();
    } else {
      publishDate.lte = end.at.toDate();
    }
  }

  return Object.keys(publishDate).length ? { publishDate } : {};
}

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

const OFFSET_RE = /([+-]\d{2}:?\d{2}|Z)$/;

/**
 * Parse a date string respecting client timezone rules:
 *
 *   1. Has offset (+08:00 / Z) + tz header  → local time (offset determines UTC instant)
 *   2. Has offset (+08:00 / Z), no tz       → local time (offset determines UTC instant)
 *   3. No offset + tz header                → local time in that tz
 *   4. No offset, no tz                     → UTC
 *
 * Cases 1-3 all represent "the client means this local time".
 * Case 4 means "the client means this UTC time".
 */
export function parseDate(input: string, tz?: string): dayjs.Dayjs {
  if (OFFSET_RE.test(input)) {
    // Input already carries an offset — dayjs.utc() resolves it to the correct UTC instant.
    // If tz is provided, convert so that startOf/endOf snap to the user's local day.
    return tz ? dayjs.utc(input).tz(tz) : dayjs.utc(input);
  }

  // No offset in the input string
  if (tz) {
    // Interpret as local time in the given timezone
    return dayjs.tz(input, tz);
  }

  // No offset, no tz → treat as UTC
  return dayjs.utc(input);
}

/**
 * Parse a date string to a JS Date, applying timezone rules.
 * Shortcut for `parseDate(input, tz).toDate()`.
 */
export function parseDateToUTC(input: string, tz?: string): Date {
  return parseDate(input, tz).toDate();
}

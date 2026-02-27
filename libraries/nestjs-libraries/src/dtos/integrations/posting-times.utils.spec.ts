import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import {
  normalizePostingTimes,
  resolveTimeSlotsForDate,
  serializePostingTimes,
  validateScheduleRules,
} from './posting-times.utils';
import { PostingTimesV2, ScheduleRule } from './posting-times.types';

dayjs.extend(utc);

// ── normalizePostingTimes ────────────────────────────────────────────

describe('normalizePostingTimes', () => {
  it('should convert legacy format to V2', () => {
    const raw = JSON.stringify([{ time: 120 }, { time: 400 }, { time: 700 }]);
    const result = normalizePostingTimes(raw);
    expect(result.version).toBe(2);
    expect(result.schedules).toEqual([
      { type: 'daily', time: 120 },
      { type: 'daily', time: 400 },
      { type: 'daily', time: 700 },
    ]);
  });

  it('should pass through V2 format unchanged', () => {
    const v2: PostingTimesV2 = {
      version: 2,
      schedules: [
        { type: 'daily', time: 180 },
        { type: 'weekday', time: 540 },
        { type: 'dayOfWeek', day: 1, time: 840 },
        { type: 'specificDate', date: '2026-03-01', time: 600 },
      ],
    };
    const result = normalizePostingTimes(JSON.stringify(v2));
    expect(result).toEqual(v2);
  });

  it('should return empty schedules for null input', () => {
    expect(normalizePostingTimes(null as any)).toEqual({
      version: 2,
      schedules: [],
    });
  });

  it('should return empty schedules for undefined input', () => {
    expect(normalizePostingTimes(undefined as any)).toEqual({
      version: 2,
      schedules: [],
    });
  });

  it('should return empty schedules for empty string', () => {
    expect(normalizePostingTimes('')).toEqual({
      version: 2,
      schedules: [],
    });
  });

  it('should return empty schedules for malformed JSON', () => {
    expect(normalizePostingTimes('{not valid json')).toEqual({
      version: 2,
      schedules: [],
    });
  });

  it('should return empty schedules for non-object/non-array JSON', () => {
    expect(normalizePostingTimes('"hello"')).toEqual({
      version: 2,
      schedules: [],
    });
  });

  it('should return empty schedules for empty legacy array', () => {
    const result = normalizePostingTimes('[]');
    expect(result).toEqual({ version: 2, schedules: [] });
  });

  it('should reject legacy array with non-numeric time', () => {
    // isLegacy requires typeof item.time === 'number'
    const result = normalizePostingTimes('[{"time":"abc"}]');
    // Falls through to default empty since isLegacy fails
    expect(result).toEqual({ version: 2, schedules: [] });
  });
});

// ── resolveTimeSlotsForDate ──────────────────────────────────────────

describe('resolveTimeSlotsForDate', () => {
  const config: PostingTimesV2 = {
    version: 2,
    schedules: [
      { type: 'daily', time: 100 },
      { type: 'daily', time: 200 },
      { type: 'weekday', time: 300 },
      { type: 'dayOfWeek', day: 1, time: 400 }, // Monday
      { type: 'dayOfWeek', day: 0, time: 500 }, // Sunday
      { type: 'specificDate', date: '2026-03-02', time: 600 }, // Monday
    ],
  };

  it('Monday 2026-03-02: matches daily + weekday + dayOfWeek(1) + specificDate', () => {
    const monday = dayjs.utc('2026-03-02'); // Monday
    const result = resolveTimeSlotsForDate(config, monday);
    expect(result).toContain(100); // daily
    expect(result).toContain(200); // daily
    expect(result).toContain(300); // weekday
    expect(result).toContain(400); // dayOfWeek Monday
    expect(result).toContain(600); // specificDate
    expect(result).not.toContain(500); // Sunday only
    expect(result).toEqual([100, 200, 300, 400, 600]); // sorted
  });

  it('Tuesday 2026-03-03: matches daily + weekday only', () => {
    const tuesday = dayjs.utc('2026-03-03');
    const result = resolveTimeSlotsForDate(config, tuesday);
    expect(result).toEqual([100, 200, 300]); // sorted
  });

  it('Saturday 2026-03-07: matches daily only', () => {
    const saturday = dayjs.utc('2026-03-07');
    const result = resolveTimeSlotsForDate(config, saturday);
    expect(result).toEqual([100, 200]); // sorted, no weekday/dayOfWeek(1)
  });

  it('Sunday 2026-03-08: matches daily + dayOfWeek(0)', () => {
    const sunday = dayjs.utc('2026-03-08');
    const result = resolveTimeSlotsForDate(config, sunday);
    expect(result).toEqual([100, 200, 500]); // sorted
  });

  it('deduplicates same time from multiple rules', () => {
    const dedupConfig: PostingTimesV2 = {
      version: 2,
      schedules: [
        { type: 'daily', time: 100 },
        { type: 'weekday', time: 100 },
      ],
    };
    const monday = dayjs.utc('2026-03-02');
    const result = resolveTimeSlotsForDate(dedupConfig, monday);
    expect(result).toEqual([100]); // deduplicated
  });

  it('returns empty for no matching rules', () => {
    const weekdayOnlyConfig: PostingTimesV2 = {
      version: 2,
      schedules: [{ type: 'weekday', time: 300 }],
    };
    const saturday = dayjs.utc('2026-03-07');
    const result = resolveTimeSlotsForDate(weekdayOnlyConfig, saturday);
    expect(result).toEqual([]);
  });

  it('returns sorted results', () => {
    const unsortedConfig: PostingTimesV2 = {
      version: 2,
      schedules: [
        { type: 'daily', time: 900 },
        { type: 'daily', time: 100 },
        { type: 'daily', time: 500 },
      ],
    };
    const day = dayjs.utc('2026-03-02');
    const result = resolveTimeSlotsForDate(unsortedConfig, day);
    expect(result).toEqual([100, 500, 900]);
  });
});

// ── serializePostingTimes ────────────────────────────────────────────

describe('serializePostingTimes', () => {
  it('should produce valid JSON', () => {
    const config: PostingTimesV2 = {
      version: 2,
      schedules: [{ type: 'daily', time: 120 }],
    };
    const json = serializePostingTimes(config);
    expect(JSON.parse(json)).toEqual(config);
  });
});

// ── validateScheduleRules ────────────────────────────────────────────

describe('validateScheduleRules', () => {
  it('should accept valid daily rule', () => {
    expect(validateScheduleRules([{ type: 'daily', time: 540 }])).toBeNull();
  });

  it('should accept valid weekday rule', () => {
    expect(validateScheduleRules([{ type: 'weekday', time: 0 }])).toBeNull();
  });

  it('should accept valid dayOfWeek rule', () => {
    expect(
      validateScheduleRules([{ type: 'dayOfWeek', day: 3, time: 720 }])
    ).toBeNull();
  });

  it('should accept valid specificDate rule', () => {
    expect(
      validateScheduleRules([
        { type: 'specificDate', date: '2026-03-01', time: 600 },
      ])
    ).toBeNull();
  });

  it('should accept all rule types together', () => {
    const rules: ScheduleRule[] = [
      { type: 'daily', time: 100 },
      { type: 'weekday', time: 200 },
      { type: 'dayOfWeek', day: 0, time: 300 },
      { type: 'dayOfWeek', day: 6, time: 400 },
      { type: 'specificDate', date: '2026-12-25', time: 500 },
    ];
    expect(validateScheduleRules(rules)).toBeNull();
  });

  it('should reject time = 1440 (out of range)', () => {
    expect(validateScheduleRules([{ type: 'daily', time: 1440 }])).toMatch(
      /time must be an integer between 0 and 1439/
    );
  });

  it('should reject negative time', () => {
    expect(validateScheduleRules([{ type: 'daily', time: -1 }])).toMatch(
      /time must be an integer between 0 and 1439/
    );
  });

  it('should reject NaN time', () => {
    expect(validateScheduleRules([{ type: 'daily', time: NaN }])).toMatch(
      /time must be an integer between 0 and 1439/
    );
  });

  it('should reject Infinity time', () => {
    expect(validateScheduleRules([{ type: 'daily', time: Infinity }])).toMatch(
      /time must be an integer between 0 and 1439/
    );
  });

  it('should reject fractional time', () => {
    expect(validateScheduleRules([{ type: 'daily', time: 100.5 }])).toMatch(
      /time must be an integer between 0 and 1439/
    );
  });

  it('should reject invalid type', () => {
    expect(
      validateScheduleRules([{ type: 'invalid' as any, time: 100 }])
    ).toMatch(/invalid type/);
  });

  it('should reject dayOfWeek with day = 7', () => {
    expect(
      validateScheduleRules([{ type: 'dayOfWeek', day: 7, time: 100 }])
    ).toMatch(/dayOfWeek\.day must be an integer 0~6/);
  });

  it('should reject dayOfWeek with day = -1', () => {
    expect(
      validateScheduleRules([{ type: 'dayOfWeek', day: -1, time: 100 }])
    ).toMatch(/dayOfWeek\.day must be an integer 0~6/);
  });

  it('should reject dayOfWeek with fractional day', () => {
    expect(
      validateScheduleRules([{ type: 'dayOfWeek', day: 3.5, time: 100 }])
    ).toMatch(/dayOfWeek\.day must be an integer 0~6/);
  });

  it('should reject dayOfWeek with NaN day', () => {
    expect(
      validateScheduleRules([{ type: 'dayOfWeek', day: NaN, time: 100 }])
    ).toMatch(/dayOfWeek\.day must be an integer 0~6/);
  });

  it('should reject specificDate with invalid format', () => {
    expect(
      validateScheduleRules([
        { type: 'specificDate', date: '2026/03/01', time: 100 },
      ])
    ).toMatch(/specificDate\.date must be YYYY-MM-DD/);
  });

  it('should reject specificDate with impossible calendar date', () => {
    expect(
      validateScheduleRules([
        { type: 'specificDate', date: '2026-13-45', time: 100 },
      ])
    ).toMatch(/not a valid calendar date/);
  });

  it('should reject specificDate with Feb 30', () => {
    expect(
      validateScheduleRules([
        { type: 'specificDate', date: '2026-02-30', time: 100 },
      ])
    ).toMatch(/not a valid calendar date/);
  });

  it('should accept leap day on leap year', () => {
    expect(
      validateScheduleRules([
        { type: 'specificDate', date: '2028-02-29', time: 100 },
      ])
    ).toBeNull();
  });

  it('should reject leap day on non-leap year', () => {
    expect(
      validateScheduleRules([
        { type: 'specificDate', date: '2026-02-29', time: 100 },
      ])
    ).toMatch(/not a valid calendar date/);
  });

  it('should accept empty array', () => {
    expect(validateScheduleRules([])).toBeNull();
  });

  it('should accept boundary values: time=0, time=1439', () => {
    expect(
      validateScheduleRules([
        { type: 'daily', time: 0 },
        { type: 'daily', time: 1439 },
      ])
    ).toBeNull();
  });

  it('should accept boundary day values: 0 and 6', () => {
    expect(
      validateScheduleRules([
        { type: 'dayOfWeek', day: 0, time: 100 },
        { type: 'dayOfWeek', day: 6, time: 200 },
      ])
    ).toBeNull();
  });
});

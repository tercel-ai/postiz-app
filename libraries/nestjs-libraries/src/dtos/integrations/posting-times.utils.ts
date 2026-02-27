import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import {
  PostingTimesV2,
  PostingTimesLegacy,
  ScheduleRule,
} from './posting-times.types';

dayjs.extend(customParseFormat);

function isV2(data: any): data is PostingTimesV2 {
  return data && data.version === 2 && Array.isArray(data.schedules);
}

function isLegacy(data: any): data is PostingTimesLegacy {
  return (
    Array.isArray(data) &&
    data.every(
      (item: any) =>
        item !== null && typeof item === 'object' && typeof item.time === 'number'
    )
  );
}

export function normalizePostingTimes(raw: string | null | undefined): PostingTimesV2 {
  if (!raw) {
    return { version: 2, schedules: [] };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { version: 2, schedules: [] };
  }

  if (isV2(parsed)) {
    return parsed;
  }

  if (isLegacy(parsed)) {
    return {
      version: 2,
      schedules: parsed.map((item) => ({
        type: 'daily' as const,
        time: item.time,
      })),
    };
  }

  return { version: 2, schedules: [] };
}

export function resolveTimeSlotsForDate(
  config: PostingTimesV2,
  date: dayjs.Dayjs
): number[] {
  const dayOfWeek = date.day(); // 0=Sunday ~ 6=Saturday
  const dateStr = date.format('YYYY-MM-DD');
  const times = new Set<number>();

  for (const rule of config.schedules) {
    switch (rule.type) {
      case 'daily':
        times.add(rule.time);
        break;
      case 'weekday':
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
          times.add(rule.time);
        }
        break;
      case 'dayOfWeek':
        if (dayOfWeek === rule.day) {
          times.add(rule.time);
        }
        break;
      case 'specificDate':
        if (dateStr === rule.date) {
          times.add(rule.time);
        }
        break;
    }
  }

  return Array.from(times).sort((a, b) => a - b);
}

export function serializePostingTimes(config: PostingTimesV2): string {
  return JSON.stringify(config);
}

const VALID_TYPES = new Set(['daily', 'weekday', 'dayOfWeek', 'specificDate']);
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function validateScheduleRules(schedules: ScheduleRule[]): string | null {
  for (let i = 0; i < schedules.length; i++) {
    const rule = schedules[i];

    if (!rule || !VALID_TYPES.has(rule.type)) {
      return `Schedule rule ${i}: invalid type "${(rule as any)?.type}"`;
    }

    if (
      typeof rule.time !== 'number' ||
      !Number.isInteger(rule.time) ||
      rule.time < 0 ||
      rule.time >= 1440
    ) {
      return `Schedule rule ${i}: time must be an integer between 0 and 1439`;
    }

    if (rule.type === 'dayOfWeek') {
      if (
        typeof rule.day !== 'number' ||
        !Number.isInteger(rule.day) ||
        rule.day < 0 ||
        rule.day > 6
      ) {
        return `Schedule rule ${i}: dayOfWeek.day must be an integer 0~6`;
      }
    }

    if (rule.type === 'specificDate') {
      if (typeof rule.date !== 'string' || !DATE_REGEX.test(rule.date)) {
        return `Schedule rule ${i}: specificDate.date must be YYYY-MM-DD`;
      }
      if (!dayjs(rule.date, 'YYYY-MM-DD', true).isValid()) {
        return `Schedule rule ${i}: specificDate.date is not a valid calendar date`;
      }
    }
  }

  return null;
}

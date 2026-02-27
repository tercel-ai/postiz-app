export interface DailySchedule {
  type: 'daily';
  time: number;
}

export interface WeekdaySchedule {
  type: 'weekday';
  time: number;
}

export interface DayOfWeekSchedule {
  type: 'dayOfWeek';
  day: number; // 0=Sunday ~ 6=Saturday
  time: number;
}

export interface SpecificDateSchedule {
  type: 'specificDate';
  date: string; // YYYY-MM-DD
  time: number;
}

export type ScheduleRule =
  | DailySchedule
  | WeekdaySchedule
  | DayOfWeekSchedule
  | SpecificDateSchedule;

export interface PostingTimesV2 {
  version: 2;
  schedules: ScheduleRule[];
}

export type PostingTimesLegacy = { time: number }[];

export type PostingTimesData = PostingTimesLegacy | PostingTimesV2;

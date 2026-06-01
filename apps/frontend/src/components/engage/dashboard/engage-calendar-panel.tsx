'use client';

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import dayjs from 'dayjs';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

interface PostRow {
  publishDate: string;
  state?: string;
}
interface PostsResponse {
  posts: PostRow[];
}

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

// Panel ⑥ "Calendar" — highlights days that have engage replies (published or
// scheduled). Reuses GET /posts?source=engage (no dedicated engage endpoint).
export function EngageCalendarPanel() {
  const fetch = useFetch();
  const [month, setMonth] = useState(() => dayjs().startOf('month'));

  const startDate = month.startOf('month').toISOString();
  const endDate = month.endOf('month').toISOString();

  const { data } = useSWR(
    `/posts?source=engage&display=month&startDate=${startDate}&endDate=${endDate}`,
    async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`posts?source=engage returned ${res.status}`);
      return res.json() as Promise<PostsResponse>;
    }
  );

  // Map "YYYY-MM-DD" → count of engage posts that day.
  const countByDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of data?.posts ?? []) {
      if (!p.publishDate) continue;
      const key = dayjs(p.publishDate).format('YYYY-MM-DD');
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [data]);

  // Build the day cells: leading blanks + each day of the month.
  const cells = useMemo(() => {
    const firstWeekday = month.startOf('month').day(); // 0=Sun
    const daysInMonth = month.daysInMonth();
    const out: Array<{ day: number; key: string } | null> = [];
    for (let i = 0; i < firstWeekday; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      out.push({ day: d, key: month.date(d).format('YYYY-MM-DD') });
    }
    return out;
  }, [month]);

  const today = dayjs().format('YYYY-MM-DD');

  return (
    <div className="bg-[#1a2035] rounded-xl p-5 border border-[#2d3748]">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-white">Calendar</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMonth((m) => m.subtract(1, 'month'))}
            className="text-gray-400 hover:text-white px-1"
            aria-label="Previous month"
          >
            ‹
          </button>
          <span className="text-xs text-gray-300 w-20 text-center">
            {month.format('MMM YYYY')}
          </span>
          <button
            onClick={() => setMonth((m) => m.add(1, 'month'))}
            className="text-gray-400 hover:text-white px-1"
            aria-label="Next month"
          >
            ›
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAYS.map((w) => (
          <div key={w} className="text-[10px] text-gray-500 py-1">
            {w}
          </div>
        ))}
        {cells.map((c, i) => {
          if (!c) return <div key={`b${i}`} />;
          const count = countByDay.get(c.key) ?? 0;
          const isToday = c.key === today;
          return (
            <div
              key={c.key}
              className={`text-xs py-1.5 rounded-md ${
                count > 0
                  ? 'bg-lime-500/20 text-lime-300 font-medium'
                  : 'text-gray-400'
              } ${isToday ? 'ring-1 ring-lime-400' : ''}`}
              title={count > 0 ? `${count} engage repl${count > 1 ? 'ies' : 'y'}` : undefined}
            >
              {c.day}
            </div>
          );
        })}
      </div>
    </div>
  );
}

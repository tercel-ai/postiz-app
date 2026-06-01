'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

interface SummaryResponse {
  totalTrafficScore?: number;
  xTrafficIndex?: number;
}

const X_COLOR = 'rgba(163, 230, 53, 1)'; // lime
const REDDIT_COLOR = 'rgba(251, 146, 60, 1)'; // orange

// Panel ④ "Engage traffic by platform" — total traffic index split X vs Reddit.
// Derived from /engage/dashboard/summary (reddit = total − x), so no extra endpoint.
export function EngageTrafficByPlatformPanel() {
  const fetch = useFetch();

  const { data, isLoading } = useSWR('/engage/dashboard/summary', async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`engage/dashboard/summary returned ${res.status}`);
    return res.json() as Promise<SummaryResponse>;
  });

  const split = useMemo(() => {
    const total = Math.round(data?.totalTrafficScore ?? 0);
    const x = Math.round(data?.xTrafficIndex ?? 0);
    const reddit = Math.max(0, total - x);
    return { total, x, reddit };
  }, [data]);

  if (isLoading) {
    return (
      <div className="bg-[#1a2035] rounded-xl p-5 border border-[#2d3748] animate-pulse h-64" />
    );
  }

  if (!data || split.total === 0) return null;

  // Conic-gradient ring: X first (lime), then Reddit (orange).
  const xPct = (split.x / split.total) * 100;
  const ring = `conic-gradient(${X_COLOR} 0% ${xPct}%, ${REDDIT_COLOR} ${xPct}% 100%)`;

  const Bar = ({ label, value, color }: { label: string; value: number; color: string }) => {
    const pct = Math.round((value / split.total) * 100);
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="w-16 text-gray-300 flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />
          {label}
        </span>
        <div className="flex-1 h-1.5 bg-[#2d3748] rounded-full overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
        </div>
        <span className="w-8 text-right text-white font-medium">{value}</span>
      </div>
    );
  };

  return (
    <div className="bg-[#1a2035] rounded-xl p-5 border border-[#2d3748]">
      <h3 className="text-sm font-semibold text-white mb-1">Engage traffic by platform</h3>
      <div className="text-2xl font-bold text-white mb-4">{split.total.toLocaleString()}</div>

      <div className="flex items-center gap-5">
        <div
          className="relative shrink-0 rounded-full"
          style={{ width: 96, height: 96, background: ring }}
        >
          <div className="absolute inset-[14px] rounded-full bg-[#1a2035] flex items-center justify-center">
            <span className="text-sm font-semibold text-white">{split.total}</span>
          </div>
        </div>
        <div className="flex-1 space-y-2">
          <Bar label="Reddit" value={split.reddit} color={REDDIT_COLOR} />
          <Bar label="X" value={split.x} color={X_COLOR} />
        </div>
      </div>
    </div>
  );
}

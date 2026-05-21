'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

interface EngageStats {
  weeklyCount: number;
  responseRate: number;
  totalImpressions: number;
  totalTrafficScore?: number;
  avgLikes?: number;
}

export function EngagePerformancePanel() {
  const fetch = useFetch();

  const { data: stats, isLoading } = useSWR(
    '/engage/dashboard-stats',
    async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`engage/dashboard-stats returned ${res.status}`);
      return res.json() as Promise<EngageStats>;
    }
  );

  if (isLoading) {
    return (
      <div className="bg-[#1a2035] rounded-xl p-5 border border-lime-500/30 animate-pulse h-32" />
    );
  }

  if (!stats) return null;

  return (
    <div className="bg-[#1a2035] rounded-xl p-5 border border-lime-500/30">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-xs bg-lime-500/20 text-lime-400 px-2 py-0.5 rounded font-medium">
            💬 Engage
          </span>
          <h3 className="text-sm font-semibold text-white">
            Engagement Performance
          </h3>
        </div>
        <Link
          href="/engage/sent"
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          View all →
        </Link>
      </div>

      {/* 4-cell stats */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: '本周发出', value: stats.weeklyCount },
          { label: '回复率', value: `${stats.responseRate}%` },
          { label: '总曝光', value: stats.totalImpressions?.toLocaleString() ?? '0' },
          { label: 'Traffic', value: stats.totalTrafficScore?.toLocaleString() ?? '0' },
        ].map((s) => (
          <div key={s.label} className="bg-[#111827] rounded-lg p-3 text-center">
            <p className="text-lg font-bold text-lime-400">{s.value}</p>
            <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

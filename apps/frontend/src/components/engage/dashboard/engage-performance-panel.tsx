'use client';

import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

interface EngageStats {
  repliesCount: number;
  responseRate: number;
  totalImpressions: number;
  totalTrafficScore?: number;
  avgLikes?: number;
}

interface BestReply {
  opportunityId: string;
  platform: string;
  content: string;
  likes: number;
  url: string | null;
  author: { username: string; displayName: string | null; avatarUrl: string | null };
}

interface SummaryData {
  bestReply: BestReply | null;
}

// Shared values: '' (all) | today | week | month — accepted by BOTH
// /engage/sent/stats and /engage/dashboard/summary (summary aliases today→day).
const DATE_OPTIONS: Array<{ value: '' | 'today' | 'week' | 'month'; label: string }> = [
  { value: '', label: 'All time' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
];

const PLATFORM_OPTIONS: Array<{ value: '' | 'x' | 'reddit'; label: string }> = [
  { value: '', label: 'All' },
  { value: 'x', label: 'X' },
  { value: 'reddit', label: 'Reddit' },
];

export function EngagePerformancePanel() {
  const fetch = useFetch();
  const [platform, setPlatform] = useState<'' | 'x' | 'reddit'>('');
  const [date, setDate] = useState<'' | 'today' | 'week' | 'month'>('');

  const params = new URLSearchParams({
    ...(platform && { platform }),
    ...(date && { date }),
  });
  const qs = params.toString() ? `?${params}` : '';

  // Headline cards (all-time default) from /sent/stats.
  const { data: stats, isLoading } = useSWR(`/engage/sent/stats${qs}`, async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`engage/sent/stats returned ${res.status}`);
    return res.json() as Promise<EngageStats>;
  });

  // Best reply (most likes/upvotes) from /dashboard/summary — same filters.
  const { data: summary } = useSWR(`/engage/dashboard/summary${qs}`, async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`engage/dashboard/summary returned ${res.status}`);
    return res.json() as Promise<SummaryData>;
  });

  const best = summary?.bestReply ?? null;

  if (isLoading) {
    return (
      <div className="bg-[#1a2035] rounded-xl p-5 border border-lime-500/30 animate-pulse h-40" />
    );
  }
  if (!stats) return null;

  return (
    <div className="bg-[#1a2035] rounded-xl p-5 border border-lime-500/30">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs bg-lime-500/20 text-lime-400 px-2 py-0.5 rounded font-medium">
            💬 Engage
          </span>
          <h3 className="text-sm font-semibold text-white">Engagement Performance</h3>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Best reply badge */}
          {best && (
            <a
              href={best.url ?? '#'}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 text-xs bg-[#111827] rounded-full pl-1 pr-2.5 py-1 hover:bg-[#0d1320]"
              title={best.content}
            >
              {best.author.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={best.author.avatarUrl}
                  alt={best.author.username}
                  className="w-5 h-5 rounded-full object-cover bg-[#2d3748]"
                />
              ) : (
                <span className="w-5 h-5 rounded-full bg-[#2d3748] inline-block" />
              )}
              <span className="text-gray-300">🏆 @{best.author.username}</span>
              <span className="text-lime-400 font-medium">♥ {best.likes.toLocaleString()}</span>
            </a>
          )}

          {/* Platform toggle */}
          <div className="flex rounded-md overflow-hidden border border-[#2d3748]">
            {PLATFORM_OPTIONS.map((o) => (
              <button
                key={o.value || 'all'}
                onClick={() => setPlatform(o.value)}
                className={`text-xs px-2 py-1 ${
                  platform === o.value ? 'bg-lime-500/20 text-lime-400' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>

          {/* Time selector */}
          <select
            value={date}
            onChange={(e) => setDate(e.target.value as '' | 'today' | 'week' | 'month')}
            className="text-xs bg-[#111827] text-gray-300 rounded-md px-2 py-1 border border-[#2d3748] outline-none"
          >
            {DATE_OPTIONS.map((o) => (
              <option key={o.value || 'all'} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <Link
            href="/engage/sent"
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            View all →
          </Link>
        </div>
      </div>

      {/* 4-cell stats */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: '发出回复', value: stats.repliesCount },
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

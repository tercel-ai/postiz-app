'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

interface PlatformValue {
  platform: string;
  value: number;
}

interface SummaryResponse {
  totalTrafficScore?: number;
  trafficByPlatform?: PlatformValue[];
}

// Fixed color + label per platform; anything not listed here (a future
// platform) falls back to a neutral gray + capitalized name.
const PLATFORM_STYLE: Record<string, { color: string; label: string }> = {
  x: { color: 'rgba(163, 230, 53, 1)', label: 'X' }, // lime
  reddit: { color: 'rgba(251, 146, 60, 1)', label: 'Reddit' }, // orange
  linkedin: { color: 'rgba(56, 189, 248, 1)', label: 'LinkedIn' }, // sky
  devto: { color: 'rgba(168, 85, 247, 1)', label: 'Dev.to' }, // purple
  hackernews: { color: 'rgba(248, 113, 113, 1)', label: 'Hacker News' }, // red
  medium: { color: 'rgba(74, 222, 128, 1)', label: 'Medium' }, // green
  quora: { color: 'rgba(244, 114, 182, 1)', label: 'Quora' }, // pink
};
const FALLBACK_STYLE = { color: 'rgba(148, 163, 184, 1)', label: '' }; // slate

function styleFor(platform: string) {
  const known = PLATFORM_STYLE[platform];
  if (known) return known;
  return { ...FALLBACK_STYLE, label: platform.charAt(0).toUpperCase() + platform.slice(1) };
}

// Panel ④ "Engage traffic by platform" — total traffic index split across every
// engage platform, via /engage/dashboard/summary's `trafficByPlatform`.
export function EngageTrafficByPlatformPanel() {
  const fetch = useFetch();

  const { data, isLoading } = useSWR('/engage/dashboard/summary', async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`engage/dashboard/summary returned ${res.status}`);
    return res.json() as Promise<SummaryResponse>;
  });

  const { total, slices } = useMemo(() => {
    const total = Math.round(data?.totalTrafficScore ?? 0);
    const slices = (data?.trafficByPlatform ?? [])
      .map((p) => ({ platform: p.platform, value: Math.round(p.value) }))
      .filter((p) => p.value > 0)
      .sort((a, b) => b.value - a.value);
    return { total, slices };
  }, [data]);

  if (isLoading) {
    return (
      <div className="bg-[#1a2035] rounded-xl p-5 border border-[#2d3748] animate-pulse h-64" />
    );
  }

  if (!data || total === 0 || slices.length === 0) return null;

  // Conic-gradient ring: one arc per platform with traffic, largest first.
  let cursor = 0;
  const stops = slices.map(({ platform, value }) => {
    const start = cursor;
    cursor += (value / total) * 100;
    return `${styleFor(platform).color} ${start}% ${cursor}%`;
  });
  const ring = `conic-gradient(${stops.join(', ')})`;

  const Bar = ({ platform, value }: PlatformValue) => {
    const { color, label } = styleFor(platform);
    const pct = Math.round((value / total) * 100);
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="w-24 text-gray-300 flex items-center gap-1 truncate">
          <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
          {label}
        </span>
        <div className="flex-1 h-1.5 bg-[#2d3748] rounded-full overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
        </div>
        <span className="w-10 text-right text-white font-medium">{value}</span>
      </div>
    );
  };

  return (
    <div className="bg-[#1a2035] rounded-xl p-5 border border-[#2d3748]">
      <h3 className="text-sm font-semibold text-white mb-1">Engage traffic by platform</h3>
      <div className="text-2xl font-bold text-white mb-4">{total.toLocaleString()}</div>

      <div className="flex items-center gap-5">
        <div
          className="relative shrink-0 rounded-full"
          style={{ width: 96, height: 96, background: ring }}
        >
          <div className="absolute inset-[14px] rounded-full bg-[#1a2035] flex items-center justify-center">
            <span className="text-sm font-semibold text-white">{total}</span>
          </div>
        </div>
        <div className="flex-1 space-y-2">
          {slices.map((s) => (
            <Bar key={s.platform} platform={s.platform} value={s.value} />
          ))}
        </div>
      </div>
    </div>
  );
}

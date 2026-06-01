'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

interface SourceItem {
  author: string;
  avatar: string | null;
  platform: string;
  clicks: number;
  replies: number;
}

interface TopSourcesResponse {
  totalClicks: number;
  items: SourceItem[];
}

// Panel ⑤ "Top engage sources" — engage replies grouped by original author,
// ranked by traffic index. ("Visitors" from the mockup is not tracked.)
export function TopEngageSourcesPanel() {
  const fetch = useFetch();
  // '' = all platforms; 'x' | 'reddit' scope.
  const [platform, setPlatform] = useState<'' | 'x' | 'reddit'>('');

  const query = platform ? `?platform=${platform}&limit=10` : '?limit=10';
  const { data, isLoading } = useSWR(
    `/engage/dashboard/top-sources${query}`,
    async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`engage/dashboard/top-sources returned ${res.status}`);
      return res.json() as Promise<TopSourcesResponse>;
    }
  );

  if (isLoading) {
    return (
      <div className="bg-[#1a2035] rounded-xl p-5 border border-[#2d3748] animate-pulse h-64" />
    );
  }

  const items = data?.items ?? [];
  if (!items.length) return null;

  const maxClicks = Math.max(...items.map((i) => i.clicks), 1);

  return (
    <div className="bg-[#1a2035] rounded-xl p-5 border border-[#2d3748]">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-white">Top engage sources</h3>
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value as '' | 'x' | 'reddit')}
          className="bg-[#2d3748] text-xs text-gray-300 rounded px-2 py-1 border border-[#3d4758] outline-none"
        >
          <option value="">All</option>
          <option value="x">X</option>
          <option value="reddit">Reddit</option>
        </select>
      </div>
      <div className="text-xs text-gray-400 mb-4">
        <span className="text-white font-semibold">{(data?.totalClicks ?? 0).toLocaleString()}</span>{' '}
        Clicks
      </div>

      <div className="space-y-3">
        {items.map((s) => (
          <div key={`${s.platform}|${s.author}`} className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={s.avatar || '/avatars/default.png'}
              alt={s.author}
              className="w-7 h-7 rounded-full shrink-0 bg-[#2d3748] object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
              }}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-200 truncate">@{s.author}</span>
                <span className="text-xs text-lime-400 ml-2 shrink-0">{s.clicks} clicks</span>
              </div>
              <div className="h-1.5 bg-[#2d3748] rounded-full overflow-hidden">
                <div
                  className="h-full bg-lime-500 rounded-full"
                  style={{ width: `${Math.round((s.clicks / maxClicks) * 100)}%` }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

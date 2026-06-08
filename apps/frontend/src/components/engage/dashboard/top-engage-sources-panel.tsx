'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

interface ReplyAuthor {
  handle: string;
  id?: string;
  name?: string;
  avatarUrl?: string;
}

interface ReplyMetrics {
  trafficScore: number;
  likes?: number;
  upvotes?: number;
  [key: string]: number | undefined;
}

interface TopSourceItem {
  id: string;
  platform: string;
  post: {
    id: string | null;
    content: string;
    releaseURL: string | null;
    publishDate: string | null;
    replyAuthor: ReplyAuthor | null;
    metrics: ReplyMetrics;
  };
  // Rank value: X → likes, Reddit → upvotes.
  metric: number;
}

interface TopSourcesResponse {
  items: TopSourceItem[];
  total: number;
}

// Panel ⑤ "Top engage sources" — top-performing engage replies ranked by the
// per-platform engagement metric (X by likes, Reddit by upvotes), descending.
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

  const maxMetric = Math.max(...items.map((i) => i.metric), 1);
  const metricLabel = platform === 'reddit' ? 'upvotes' : 'likes';

  return (
    <div className="bg-[#1a2035] rounded-xl p-5 border border-[#2d3748]">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-white">Top engage replies</h3>
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

      <div className="space-y-3">
        {items.map((s) => {
          const replier = s.post.replyAuthor;
          // Per-item metric word so the mixed "All" list reads correctly.
          const word = s.platform === 'reddit' ? 'upvotes' : 'likes';
          const avatar = replier?.avatarUrl || '/avatars/default.png';
          const handle = replier?.handle || 'unknown';
          const row = (
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={avatar}
                alt={handle}
                className="w-7 h-7 rounded-full shrink-0 bg-[#2d3748] object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                }}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-200 truncate">@{handle}</span>
                  <span className="text-xs text-lime-400 ml-2 shrink-0">
                    {s.metric} {platform ? metricLabel : word}
                  </span>
                </div>
                <div className="text-[11px] text-gray-400 truncate mb-1">{s.post.content}</div>
                <div className="h-1.5 bg-[#2d3748] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-lime-500 rounded-full"
                    style={{ width: `${Math.round((s.metric / maxMetric) * 100)}%` }}
                  />
                </div>
              </div>
            </div>
          );

          return s.post.releaseURL ? (
            <a
              key={s.id}
              href={s.post.releaseURL}
              target="_blank"
              rel="noreferrer"
              className="block hover:opacity-90"
            >
              {row}
            </a>
          ) : (
            <div key={s.id}>{row}</div>
          );
        })}
      </div>
    </div>
  );
}

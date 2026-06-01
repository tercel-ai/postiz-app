'use client';

import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

interface TrafficItem {
  opportunityId: string;
  platform: string;
  content: string;
  clicks: number;
  time: string | null;
  url: string | null;
}

interface TrafficResponse {
  totalClicks: number;
  items: TrafficItem[];
}

export function TrafficFromEngagePanel() {
  const fetch = useFetch();

  const { data } = useSWR('/engage/dashboard/traffics?limit=10', async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`engage/dashboard/traffics returned ${res.status}`);
    return res.json() as Promise<TrafficResponse>;
  });

  const totalClicks = data?.totalClicks ?? 0;
  const items = data?.items ?? [];

  if (!items.length) return null;

  const topReplies = items.filter((r) => r.clicks > 0).slice(0, 5);

  if (!topReplies.length) return null;

  const maxTraffic = Math.max(...topReplies.map((r) => r.clicks), 1);

  return (
    <div className="bg-[#1a2035] rounded-xl p-5 border border-[#2d3748]">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-white">
          Traffic from Engage
        </h3>
        <span className="text-xs text-lime-400">
          Total Traffic: {totalClicks.toLocaleString()}
        </span>
      </div>
      <div className="space-y-3">
        {topReplies.map((reply) => (
          <div key={reply.opportunityId}>
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-gray-300 truncate flex-1">
                {reply.content?.slice(0, 50)}…
              </p>
              <span className="text-xs text-lime-400 ml-2 shrink-0">
                {reply.clicks}
              </span>
            </div>
            <div className="h-1.5 bg-[#2d3748] rounded-full overflow-hidden">
              <div
                className="h-full bg-lime-500 rounded-full"
                style={{
                  width: `${Math.round((reply.clicks / maxTraffic) * 100)}%`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

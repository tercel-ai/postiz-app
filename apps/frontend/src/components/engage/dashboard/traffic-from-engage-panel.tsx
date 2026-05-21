'use client';

import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

interface TrafficEntry {
  id: string;
  content: string;
  trafficScore: number;
  platform: string;
}

export function TrafficFromEngagePanel() {
  const fetch = useFetch();

  const { data: stats } = useSWR('/engage/sent?limit=10', async (url) => {
    const res = await fetch(url);
    const json = await res.json();
    return (json.items ?? []) as Array<{
      id: string;
      post: {
        content: string;
        trafficScore?: number;
        integration?: { providerIdentifier: string } | null;
      };
      opportunity: { platform: string };
    }>;
  });

  if (!stats?.length) return null;

  const maxTraffic = Math.max(...stats.map((s) => s.post.trafficScore ?? 0), 1);
  const topReplies = stats
    .filter((s) => (s.post.trafficScore ?? 0) > 0)
    .sort((a, b) => (b.post.trafficScore ?? 0) - (a.post.trafficScore ?? 0))
    .slice(0, 5);

  if (!topReplies.length) return null;

  return (
    <div className="bg-[#1a2035] rounded-xl p-5 border border-[#2d3748]">
      <h3 className="text-sm font-semibold text-white mb-4">
        Traffic from Engage
      </h3>
      <div className="space-y-3">
        {topReplies.map((reply) => (
          <div key={reply.id}>
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-gray-300 truncate flex-1">
                {reply.post.content?.slice(0, 50)}…
              </p>
              <span className="text-xs text-lime-400 ml-2 shrink-0">
                {reply.post.trafficScore}
              </span>
            </div>
            <div className="h-1.5 bg-[#2d3748] rounded-full overflow-hidden">
              <div
                className="h-full bg-lime-500 rounded-full"
                style={{
                  width: `${Math.round(((reply.post.trafficScore ?? 0) / maxTraffic) * 100)}%`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

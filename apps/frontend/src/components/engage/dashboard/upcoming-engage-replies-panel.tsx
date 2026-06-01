'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import dayjs from 'dayjs';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

interface PostRow {
  id: string;
  content?: string;
  publishDate: string;
  state?: string;
  integration?: { providerIdentifier?: string } | null;
}
interface PostsResponse {
  posts: PostRow[];
}

function platformLabel(provider?: string): string {
  if (!provider) return '';
  if (provider === 'x' || provider === 'twitter') return 'X';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

// Panel ⑦ "Upcoming Replies" — engage replies scheduled in the future.
// Reuses GET /posts?source=engage over a forward window.
export function UpcomingEngageRepliesPanel() {
  const fetch = useFetch();

  const startDate = useMemo(() => dayjs().toISOString(), []);
  const endDate = useMemo(() => dayjs().add(60, 'day').toISOString(), []);

  const { data, isLoading } = useSWR(
    `/posts?source=engage&display=month&startDate=${startDate}&endDate=${endDate}`,
    async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`posts?source=engage returned ${res.status}`);
      return res.json() as Promise<PostsResponse>;
    }
  );

  // Future-dated only, soonest first.
  const upcoming = useMemo(() => {
    const now = dayjs();
    return (data?.posts ?? [])
      .filter((p) => p.publishDate && dayjs(p.publishDate).isAfter(now))
      .sort((a, b) => dayjs(a.publishDate).valueOf() - dayjs(b.publishDate).valueOf())
      .slice(0, 8);
  }, [data]);

  if (isLoading) {
    return (
      <div className="bg-[#1a2035] rounded-xl p-5 border border-[#2d3748] animate-pulse h-64" />
    );
  }

  if (!upcoming.length) return null;

  return (
    <div className="bg-[#1a2035] rounded-xl p-5 border border-[#2d3748]">
      <h3 className="text-sm font-semibold text-white mb-4">Upcoming Replies</h3>
      <div className="space-y-3">
        {upcoming.map((p) => {
          const d = dayjs(p.publishDate);
          return (
            <div key={p.id} className="flex items-start gap-3">
              <div className="text-xs text-lime-400 font-medium w-12 shrink-0 pt-0.5">
                {d.format('HH:mm')}
              </div>
              <div className="flex-1 min-w-0 border-l border-[#2d3748] pl-3">
                <div className="text-xs text-gray-400 mb-0.5">
                  {d.format('DD MMM YYYY')}
                  {p.integration?.providerIdentifier && (
                    <span className="ml-2 text-gray-500">
                      · {platformLabel(p.integration.providerIdentifier)}
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-200 truncate">
                  {p.content?.slice(0, 80) || '(no content)'}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

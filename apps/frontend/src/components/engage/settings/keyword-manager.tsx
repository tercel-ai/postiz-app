'use client';

import { useState, useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

const TYPE_COLORS: Record<string, string> = {
  CORE: 'bg-blue-500/20 text-blue-400',
  BRAND: 'bg-emerald-500/20 text-emerald-400',
  COMPETITOR: 'bg-rose-500/20 text-rose-400',
};

const TYPE_OPTIONS = ['', 'CORE', 'BRAND', 'COMPETITOR'];

const PLATFORM_ICONS: Record<string, string> = {
  x: '𝕏',
  reddit: 'r/',
};

interface Keyword {
  id: string;
  keyword: string;
  type: string;
  enabled: boolean;
  weeklyHitCount: number;
  totalHitCount: number;
}

interface PostSnippet {
  id: string;
  platform: string;
  externalPostUrl: string;
  authorUsername: string;
  postContent: string;
  postPublishedAt: string;
  metricScore: number;
  metricComments: number;
  metricLikes: number;
  score: number;
}

function KeywordPostsPanel({ keywordId }: { keywordId: string }) {
  const fetch = useFetch();
  const { data, isLoading } = useSWR(
    `/engage/keywords/${keywordId}/posts`,
    async (url) => {
      const res = await fetch(url);
      if (!res.ok) return [];
      return res.json() as Promise<PostSnippet[]>;
    }
  );

  if (isLoading) {
    return (
      <div className="py-3 px-4 text-xs text-gray-500">Loading posts…</div>
    );
  }

  const posts = data ?? [];
  if (posts.length === 0) {
    return (
      <div className="py-3 px-4 text-xs text-gray-500">
        No matching posts found yet.
      </div>
    );
  }

  return (
    <div className="divide-y divide-[#1e2536]">
      {posts.map((p) => (
        <a
          key={p.id}
          href={p.externalPostUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-start gap-3 px-4 py-2.5 hover:bg-[#1e2536] transition-colors group"
        >
          <span className="text-xs font-mono text-gray-500 pt-0.5 w-6 shrink-0">
            {PLATFORM_ICONS[p.platform] ?? p.platform}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-300 truncate group-hover:text-white transition-colors">
              {p.postContent.slice(0, 120)}
            </p>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-[11px] text-gray-600">
                @{p.authorUsername}
              </span>
              {p.platform === 'reddit' ? (
                <>
                  <span className="text-[11px] text-gray-600">
                    ↑ {p.metricScore}
                  </span>
                  <span className="text-[11px] text-gray-600">
                    💬 {p.metricComments}
                  </span>
                </>
              ) : (
                <span className="text-[11px] text-gray-600">
                  ♥ {p.metricLikes}
                </span>
              )}
              <span className="text-[11px] text-gray-600 ml-auto">
                {dayjs(p.postPublishedAt).fromNow()}
              </span>
            </div>
          </div>
        </a>
      ))}
    </div>
  );
}

export function KeywordManager() {
  const fetch = useFetch();
  const toaster = useToaster();

  const { data: config, error, mutate } = useSWR('/engage/config', async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`engage/config returned ${res.status}`);
    return res.json();
  });

  const [input, setInput] = useState('');
  const [inputType, setInputType] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const keywords: Keyword[] = config?.keywords ?? [];
  const maxHit = Math.max(...keywords.map((k) => k.weeklyHitCount), 1);

  const addKeyword = useCallback(async () => {
    const kw = input.trim();
    if (!kw) return;
    const isCompetitor = inputType === 'COMPETITOR';
    try {
      const res = await fetch('/engage/keywords', {
        method: 'POST',
        body: JSON.stringify({
          keyword: kw,
          type: inputType || undefined,
          // Competitor keywords default to disabled
          ...(isCompetitor && { enabled: false }),
        }),
      });
      if (!res.ok) {
        toaster.show('Failed to add keyword (may be duplicate)', 'warning');
        return;
      }
      setInput('');
      mutate();
    } catch {
      toaster.show('Failed to add keyword (may be duplicate)', 'warning');
    }
  }, [input, inputType, fetch, mutate, toaster]);

  const toggleKeyword = useCallback(
    async (kw: Keyword) => {
      try {
        const res = await fetch(`/engage/keywords/${kw.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !kw.enabled }),
        });
        if (!res.ok) {
          toaster.show('Failed to update keyword', 'warning');
          return;
        }
        mutate();
      } catch {
        toaster.show('Failed to update keyword', 'warning');
      }
    },
    [fetch, mutate, toaster]
  );

  const deleteKeyword = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/engage/keywords/${id}`, { method: 'DELETE' });
        if (!res.ok) {
          toaster.show('Failed to delete keyword', 'warning');
          return;
        }
        if (expandedId === id) setExpandedId(null);
        mutate();
      } catch {
        toaster.show('Failed to delete keyword', 'warning');
      }
    },
    [fetch, mutate, toaster, expandedId]
  );

  const toggleExpand = useCallback(
    (id: string) => setExpandedId((prev) => (prev === id ? null : id)),
    []
  );

  return (
    <div>
      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center justify-between">
          <p className="text-sm text-red-400">Failed to load keywords.</p>
          <button
            onClick={() => mutate()}
            className="text-xs text-blue-400 hover:text-blue-300"
          >
            Retry
          </button>
        </div>
      )}
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          className="flex-1 bg-[#1e2536] border border-[#2d3748] text-white rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-blue-500"
          placeholder="Add keyword (Enter to confirm)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addKeyword()}
        />
        <select
          value={inputType}
          onChange={(e) => setInputType(e.target.value)}
          className="bg-[#1e2536] border border-[#2d3748] text-white rounded-lg px-3 py-2 text-sm"
        >
          {TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t || '— no type —'}
            </option>
          ))}
        </select>
        <button
          onClick={addKeyword}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
        >
          Add
        </button>
      </div>

      <div className="space-y-1.5">
        {keywords.map((kw) => (
          <div
            key={kw.id}
            className="bg-[#1a2035] rounded-lg overflow-hidden"
          >
            {/* Main row */}
            <div className="flex items-center gap-3 px-4 py-3">
              <span
                className={`text-xs px-2 py-0.5 rounded font-medium shrink-0 ${
                  TYPE_COLORS[kw.type ?? ''] ?? 'bg-gray-500/20 text-gray-400'
                }`}
              >
                {kw.type || '—'}
              </span>
              <span className="text-white text-sm flex-1 truncate">
                {kw.keyword}
              </span>

              {/* Weekly hit bar + count */}
              <div className="flex items-center gap-2 w-32 shrink-0">
                <div className="flex-1 h-1.5 bg-[#2d3748] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all"
                    style={{
                      width: `${Math.round((kw.weeklyHitCount / maxHit) * 100)}%`,
                    }}
                  />
                </div>
                <span className="text-xs text-gray-500 w-14 text-right shrink-0">
                  本周 {kw.weeklyHitCount} 条
                </span>
              </div>

              {/* Expand button — only when there are hits */}
              {kw.weeklyHitCount > 0 ? (
                <button
                  onClick={() => toggleExpand(kw.id)}
                  className="text-xs text-blue-400 hover:text-blue-300 w-20 text-right shrink-0 transition-colors"
                >
                  {kw.weeklyHitCount} posts {expandedId === kw.id ? '▲' : '▼'}
                </button>
              ) : (
                <span className="w-20 shrink-0" />
              )}

              <button
                onClick={() => toggleKeyword(kw)}
                className={`text-xs font-medium w-8 shrink-0 ${
                  kw.enabled ? 'text-green-400' : 'text-gray-600'
                }`}
              >
                {kw.enabled ? 'ON' : 'OFF'}
              </button>
              <button
                onClick={() => deleteKeyword(kw.id)}
                className="text-gray-600 hover:text-red-400 text-lg leading-none shrink-0"
              >
                ×
              </button>
            </div>

            {/* Expanded posts panel */}
            {expandedId === kw.id && (
              <div className="border-t border-[#1e2536] bg-[#131929]">
                <KeywordPostsPanel keywordId={kw.id} />
              </div>
            )}
          </div>
        ))}

        {keywords.length === 0 && (
          <p className="text-center text-gray-500 text-sm py-8">
            No keywords yet. Add some above to start discovering opportunities.
          </p>
        )}
      </div>
    </div>
  );
}

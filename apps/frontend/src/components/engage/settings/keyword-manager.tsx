'use client';

import { useState, useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';

const TYPE_COLORS: Record<string, string> = {
  CORE: 'bg-blue-500/20 text-blue-400',
  BRAND: 'bg-green-500/20 text-green-400',
  COMPETITOR: 'bg-red-500/20 text-red-400',
};

const TYPE_OPTIONS = ['CORE', 'BRAND', 'COMPETITOR'];

interface Keyword {
  id: string;
  keyword: string;
  type: string;
  enabled: boolean;
  weeklyHitCount: number;
  totalHitCount: number;
}

export function KeywordManager() {
  const fetch = useFetch();
  const toaster = useToaster();

  const { data: config, mutate } = useSWR('/engage/config', async (url) => {
    const res = await fetch(url);
    return res.json();
  });

  const [input, setInput] = useState('');
  const [inputType, setInputType] = useState('CORE');

  const keywords: Keyword[] = config?.keywords ?? [];
  const maxHit = Math.max(...keywords.map((k) => k.weeklyHitCount), 1);

  const addKeyword = useCallback(async () => {
    const kw = input.trim();
    if (!kw) return;
    try {
      await fetch('/engage/keywords', {
        method: 'POST',
        body: JSON.stringify({ keyword: kw, type: inputType }),
      });
      setInput('');
      mutate();
    } catch {
      toaster.show('Failed to add keyword (may be duplicate)', 'warning');
    }
  }, [input, inputType, fetch, mutate, toaster]);

  const toggleKeyword = useCallback(
    async (kw: Keyword) => {
      try {
        await fetch(`/engage/keywords/${kw.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !kw.enabled }),
        });
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
        await fetch(`/engage/keywords/${id}`, { method: 'DELETE' });
        mutate();
      } catch {
        toaster.show('Failed to delete keyword', 'warning');
      }
    },
    [fetch, mutate, toaster]
  );

  return (
    <div>
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
              {t}
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

      <div className="space-y-2">
        {keywords.map((kw) => (
          <div
            key={kw.id}
            className="flex items-center gap-3 bg-[#1a2035] rounded-lg px-4 py-3"
          >
            <span
              className={`text-xs px-2 py-0.5 rounded font-medium ${TYPE_COLORS[kw.type] ?? TYPE_COLORS.CORE}`}
            >
              {kw.type}
            </span>
            <span className="text-white text-sm flex-1">{kw.keyword}</span>

            {/* Weekly hit progress bar */}
            <div className="w-24 flex items-center gap-2">
              <div className="flex-1 h-1.5 bg-[#2d3748] rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full"
                  style={{
                    width: `${Math.round((kw.weeklyHitCount / maxHit) * 100)}%`,
                  }}
                />
              </div>
              <span className="text-xs text-gray-500 w-6 text-right">
                {kw.weeklyHitCount}
              </span>
            </div>

            <button
              onClick={() => toggleKeyword(kw)}
              className={`text-xs font-medium w-8 ${
                kw.enabled ? 'text-green-400' : 'text-gray-600'
              }`}
            >
              {kw.enabled ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={() => deleteKeyword(kw.id)}
              className="text-gray-600 hover:text-red-400 text-lg leading-none"
            >
              ×
            </button>
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

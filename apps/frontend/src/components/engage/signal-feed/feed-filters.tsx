'use client';

import { FC } from 'react';
import clsx from 'clsx';

export interface FeedFilters {
  platform?: string;
  minScore?: number;
  intent?: string;
  status?: string;
  bookmarked?: boolean;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

interface FeedFiltersProps {
  filters: FeedFilters;
  onChange: (filters: FeedFilters) => void;
}

const PLATFORMS = [
  { label: 'All', value: '' },
  { label: 'X', value: 'x' },
  { label: 'Reddit', value: 'reddit' },
];

const SCORE_OPTIONS = [
  { label: 'All scores', value: 0 },
  { label: '≥70', value: 70 },
  { label: '≥85', value: 85 },
];

const INTENT_OPTIONS = [
  { label: 'All intents', value: '' },
  { label: 'Help seeking', value: 'help_seeking' },
  { label: 'Rant', value: 'rant' },
  { label: 'Discussion', value: 'discussion' },
  { label: 'Opinion', value: 'opinion' },
  { label: 'Comparison', value: 'comparison' },
  { label: 'Data share', value: 'data_share' },
];

const SORT_OPTIONS = [
  { label: 'Score', value: 'score' },
  { label: 'Heat', value: 'scoreHeat' },
  { label: 'Authority', value: 'scoreAuthority' },
  { label: 'Newest', value: 'createdAt' },
];

export const FeedFiltersBar: FC<FeedFiltersProps> = ({ filters, onChange }) => {
  const set = (patch: Partial<FeedFilters>) => onChange({ ...filters, ...patch });

  return (
    <div className="flex flex-wrap items-center gap-3 px-6 py-3 border-b border-[#1e2536] bg-[#0f1219]">
      {/* Platform */}
      <div className="flex gap-1">
        {PLATFORMS.map((p) => (
          <button
            key={p.value}
            onClick={() => set({ platform: p.value || undefined })}
            className={clsx(
              'px-3 py-1 text-xs rounded-full font-medium transition-colors',
              (filters.platform ?? '') === p.value
                ? 'bg-blue-600 text-white'
                : 'bg-[#1e2536] text-gray-400 hover:text-white'
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Min score */}
      <select
        className="text-xs bg-[#1e2536] border border-[#2d3748] text-gray-300 rounded-md px-2 py-1"
        value={filters.minScore ?? 0}
        onChange={(e) => set({ minScore: Number(e.target.value) || undefined })}
      >
        {SCORE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {/* Intent */}
      <select
        className="text-xs bg-[#1e2536] border border-[#2d3748] text-gray-300 rounded-md px-2 py-1"
        value={filters.intent ?? ''}
        onChange={(e) => set({ intent: e.target.value || undefined })}
      >
        {INTENT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {/* Bookmarked toggle */}
      <button
        onClick={() => set({ bookmarked: filters.bookmarked ? undefined : true })}
        className={clsx(
          'px-3 py-1 text-xs rounded-full font-medium transition-colors',
          filters.bookmarked
            ? 'bg-amber-600 text-white'
            : 'bg-[#1e2536] text-gray-400 hover:text-white'
        )}
      >
        ★ Saved
      </button>

      {/* Sort */}
      <div className="ml-auto flex items-center gap-2">
        <span className="text-xs text-gray-500">Sort by</span>
        <select
          className="text-xs bg-[#1e2536] border border-[#2d3748] text-gray-300 rounded-md px-2 py-1"
          value={filters.sortBy ?? 'score'}
          onChange={(e) => set({ sortBy: e.target.value })}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          onClick={() =>
            set({ sortOrder: filters.sortOrder === 'asc' ? 'desc' : 'asc' })
          }
          className="text-gray-400 hover:text-white text-sm"
          title="Toggle sort order"
        >
          {filters.sortOrder === 'asc' ? '↑' : '↓'}
        </button>
      </div>
    </div>
  );
};

'use client';

import { useState, useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { SetupWizard } from '../setup-wizard/setup-wizard';
import { FeedFiltersBar, FeedFilters } from './feed-filters';
import { OpportunityCard, type Opportunity } from './opportunity-card';
import { ReplyPanel } from './reply-panel';

export function SignalFeed() {
  const fetch = useFetch();

  const toaster = useToaster();

  const { data: config } = useSWR('/engage/config', async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`engage/config returned ${res.status}`);
    return res.json();
  });

  const { data: accounts } = useSWR('/engage/reply-accounts', async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`engage/reply-accounts returned ${res.status}`);
    return res.json() as Promise<
      Array<{
        id: string;
        name: string;
        picture?: string;
        engageXReplyAccount?: {
          engageEnabled: boolean;
          defaultStrategy: string;
        } | null;
      }>
    >;
  });

  const [filters, setFilters] = useState<FeedFilters>({
    sortBy: 'score',
    sortOrder: 'desc',
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const queryParams = new URLSearchParams({
    sortBy: filters.sortBy ?? 'score',
    sortOrder: filters.sortOrder ?? 'desc',
    page: String(page),
    limit: '20',
    ...(filters.platform && { platform: filters.platform }),
    ...(filters.minScore && { minScore: String(filters.minScore) }),
    ...(filters.intent && { intent: filters.intent }),
    ...(filters.bookmarked != null && { bookmarked: String(filters.bookmarked) }),
    status: 'NEW',
  });

  const {
    data,
    mutate,
  } = useSWR(`/engage/opportunities?${queryParams}`, async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`engage/opportunities returned ${res.status}`);
    return res.json() as Promise<{
      items: Opportunity[];
      total: number;
      page: number;
      limit: number;
    }>;
  });

  const handleDismiss = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/engage/opportunities/${id}/dismiss`, { method: 'PATCH' });
        if (!res.ok) {
          toaster.show('Failed to dismiss opportunity', 'warning');
          return;
        }
        mutate();
        if (selectedId === id) setSelectedId(null);
      } catch {
        toaster.show('Failed to dismiss opportunity', 'warning');
      }
    },
    [fetch, mutate, selectedId, toaster]
  );

  const handleBookmark = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/engage/opportunities/${id}/bookmark`, { method: 'PATCH' });
        if (!res.ok) {
          toaster.show('Failed to update bookmark', 'warning');
          return;
        }
        mutate();
      } catch {
        toaster.show('Failed to update bookmark', 'warning');
      }
    },
    [fetch, mutate, toaster]
  );

  const handleSent = useCallback(() => {
    mutate();
    setSelectedId(null);
  }, [mutate]);

  if (!config) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
        Loading...
      </div>
    );
  }

  if (!config.setupCompleted) {
    return <SetupWizard />;
  }

  const opportunities = data?.items ?? [];
  const total = data?.total ?? 0;
  const selectedOpp = selectedId
    ? opportunities.find((o) => o.id === selectedId)
    : null;

  return (
    <div className="flex h-full">
      {/* Feed column */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <FeedFiltersBar
          filters={filters}
          onChange={(f) => {
            setFilters(f);
            setPage(1);
          }}
        />

        {/* Stats bar */}
        {config.lastScanAt && (
          <div className="px-6 py-2 text-xs text-gray-500 border-b border-[#1e2536]">
            {total} opportunities · Last scan:{' '}
            {new Date(config.lastScanAt).toLocaleString()}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {opportunities.length === 0 ? (
            <div className="text-center py-16 text-gray-500">
              <p className="text-4xl mb-3">🔍</p>
              <p className="text-sm">No opportunities yet.</p>
              <p className="text-xs mt-1">
                The daily scan runs at 00:30 UTC. Check back tomorrow!
              </p>
            </div>
          ) : (
            opportunities.map((opp) => (
              <OpportunityCard
                key={opp.id}
                opportunity={opp}
                selected={selectedId === opp.id}
                onSelect={setSelectedId}
                onBookmark={handleBookmark}
                onDismiss={handleDismiss}
              />
            ))
          )}

          {/* Pagination */}
          {total > 20 && (
            <div className="flex justify-center gap-2 py-4">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="text-xs px-3 py-1 bg-[#1e2536] text-gray-400 rounded disabled:opacity-50"
              >
                ← Prev
              </button>
              <span className="text-xs text-gray-500 py-1">
                {page} / {Math.ceil(total / 20)}
              </span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page * 20 >= total}
                className="text-xs px-3 py-1 bg-[#1e2536] text-gray-400 rounded disabled:opacity-50"
              >
                Next →
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Reply panel */}
      {selectedOpp && (
        <ReplyPanel
          key={selectedOpp.id}
          opportunity={selectedOpp}
          replyAccounts={accounts ?? []}
          onClose={() => setSelectedId(null)}
          onSent={handleSent}
        />
      )}
    </div>
  );
}

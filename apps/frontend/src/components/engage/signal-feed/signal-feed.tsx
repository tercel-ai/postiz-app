'use client';

import { useState, useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { SetupWizard } from '../setup-wizard/setup-wizard';
import { FeedFiltersBar, FeedFilters } from './feed-filters';
import { OpportunityCard, type Opportunity } from './opportunity-card';
import { ReplyPanel } from './reply-panel';
import { useEngageVisitRefresh } from './use-engage-visit-refresh';

type ScanTiming = { lastScanAt: string | null; nextScanAt: string | null };
type ScanStatus = {
  lastScanAt: string | null;
  nextScanAt: string | null;
  keyword: ScanTiming;
  channel: ScanTiming;
  tracked: ScanTiming;
};

// Compact relative time: "in 5m" (future) / "12m ago" (past) / "—" (null).
function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  const mins = Math.max(0, Math.round(Math.abs(ms) / 60000));
  const unit =
    mins < 60
      ? `${mins}m`
      : mins < 1440
      ? `${Math.round(mins / 60)}h`
      : `${Math.round(mins / 1440)}d`;
  if (mins === 0) return ms >= 0 ? 'now' : 'just now';
  return ms >= 0 ? `in ${unit}` : `${unit} ago`;
}

export function SignalFeed() {
  const fetch = useFetch();

  const toaster = useToaster();

  const { data: config, error: configError } = useSWR('/engage/config', async (url) => {
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

  // Monitored channels + tracked accounts populate the feed's source-filter dropdowns.
  const { data: monitoredChannels } = useSWR('/engage/monitored-channels', async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`engage/monitored-channels returned ${res.status}`);
    return res.json() as Promise<
      Array<{ channelId: string; channelName: string; enabled: boolean }>
    >;
  });

  const { data: trackedAccounts } = useSWR('/engage/tracked-accounts', async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`engage/tracked-accounts returned ${res.status}`);
    return res.json() as Promise<
      Array<{ username: string; displayName?: string | null; enabled: boolean }>
    >;
  });

  const channelOptions = (monitoredChannels ?? [])
    .filter((c) => c.enabled)
    .map((c) => ({ value: c.channelId, label: c.channelName || c.channelId }));

  const authorOptions = (trackedAccounts ?? [])
    .filter((a) => a.enabled)
    .map((a) => ({ value: a.username, label: `@${a.username}` }));

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
    ...(filters.channels && { channels: filters.channels }),
    ...(filters.authors && { authors: filters.authors }),
    ...(filters.bookmarked != null && { bookmarked: String(filters.bookmarked) }),
    status: 'NEW',
  });

  const {
    data,
    error: feedError,
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

  // Page-visit trigger: on entry & tab-focus, kick this org's DUE scan/metrics
  // (the server's due gate decides what actually runs). Skips the call entirely
  // until the cached nextRefreshAt passes. Revalidate the feed after a kick so a
  // cold/first-visit feed fills in without a manual refresh.
  const { coldStart } = useEngageVisitRefresh(config?.organizationId, {
    onAccepted: () => {
      mutate();
      [3000, 8000, 15000].forEach((d) => window.setTimeout(() => mutate(), d));
    },
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

  const keywords: Array<{ id: string; keyword: string; type: string }> =
    config?.keywords?.filter((k: { enabled: boolean }) => k.enabled) ?? [];

  const [scanning, setScanning] = useState(false);
  const [showKeywordPicker, setShowKeywordPicker] = useState(false);
  const [selectedKeywordIds, setSelectedKeywordIds] = useState<Set<string>>(new Set());

  const openKeywordPicker = useCallback(() => {
    // Default: all enabled keywords selected
    setSelectedKeywordIds(new Set(keywords.map((k) => k.id)));
    setShowKeywordPicker(true);
  }, [keywords]);

  const toggleKeyword = useCallback((id: string) => {
    setSelectedKeywordIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const handleScanNow = useCallback(async () => {
    setShowKeywordPicker(false);
    setScanning(true);
    const ids = [...selectedKeywordIds];
    try {
      const res = await fetch('/engage/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ids),
      });
      if (!res.ok) {
        const msg = res.status === 429
          ? 'Too many scans — try again later.'
          : 'Failed to trigger scan. Try again later.';
        toaster.show(msg, 'warning');
        return;
      }
      toaster.show('Scan triggered — results will appear shortly.', 'success');
    } catch {
      toaster.show('Failed to trigger scan. Try again later.', 'warning');
    } finally {
      setScanning(false);
    }
  }, [fetch, selectedKeywordIds, toaster]);

  if (configError) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-sm">
        <p className="text-red-400 mb-1">Failed to load Engage configuration.</p>
        <p className="text-gray-500 text-xs">
          Check your connection and refresh the page.
        </p>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
        Loading...
      </div>
    );
  }

  if (!config.enabled) {
    return <SetupWizard />;
  }

  const opportunities = data?.items ?? [];
  const total = data?.total ?? 0;
  const scanStatus = config.scanStatus as ScanStatus | undefined;
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
          channelOptions={channelOptions}
          authorOptions={authorOptions}
        />

        {/* Stats bar */}
        <div className="px-6 py-2 text-xs text-gray-500 border-b border-[#1e2536] flex items-center justify-between">
          <span
            title={
              scanStatus
                ? [
                    `Keyword  last ${relTime(scanStatus.keyword.lastScanAt)} · next ${relTime(scanStatus.keyword.nextScanAt)}`,
                    `Channel  last ${relTime(scanStatus.channel.lastScanAt)} · next ${relTime(scanStatus.channel.nextScanAt)}`,
                    `Tracked  last ${relTime(scanStatus.tracked.lastScanAt)} · next ${relTime(scanStatus.tracked.nextScanAt)}`,
                  ].join('\n')
                : undefined
            }
          >
            {total} opportunities
            {scanStatus?.lastScanAt
              ? ` · Last scan ${relTime(scanStatus.lastScanAt)}`
              : ' · No scan yet'}
            {scanStatus?.nextScanAt ? ` · Next scan ${relTime(scanStatus.nextScanAt)}` : ''}
          </span>
          <button
            onClick={openKeywordPicker}
            disabled={scanning || keywords.length === 0}
            className="px-3 py-1 rounded bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 disabled:text-gray-600 disabled:cursor-not-allowed transition-colors"
          >
            {scanning ? 'Scanning…' : 'Scan Now'}
          </button>
        </div>

        {/* Keyword picker */}
        {showKeywordPicker && (
          <div className="mx-6 mt-2 mb-1 p-3 bg-[#1a2035] border border-[#2d3748] rounded-lg text-xs">
            <p className="text-gray-400 mb-2">Select keywords to scan:</p>
            <div className="flex flex-wrap gap-2 mb-3">
              {keywords.map((kw) => (
                <button
                  key={kw.id}
                  onClick={() => toggleKeyword(kw.id)}
                  className={`px-2 py-1 rounded border transition-colors ${
                    selectedKeywordIds.has(kw.id)
                      ? 'border-blue-500 bg-blue-500/20 text-blue-300'
                      : 'border-[#2d3748] text-gray-500'
                  }`}
                >
                  {kw.keyword}
                </button>
              ))}
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowKeywordPicker(false)}
                className="px-3 py-1 rounded text-gray-500 hover:text-gray-300 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleScanNow}
                disabled={selectedKeywordIds.size === 0}
                className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white transition-colors"
              >
                Scan {selectedKeywordIds.size} keyword{selectedKeywordIds.size !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {feedError ? (
            <div className="text-center py-16">
              <p className="text-4xl mb-3">⚠️</p>
              <p className="text-sm text-red-400">Failed to load opportunities.</p>
              <button
                onClick={() => mutate()}
                className="text-xs mt-2 text-blue-400 hover:text-blue-300"
              >
                Retry
              </button>
            </div>
          ) : opportunities.length === 0 ? (
            <div className="text-center py-16 text-gray-500">
              <p className="text-4xl mb-3">{coldStart ? '✨' : '🔍'}</p>
              <p className="text-sm">
                {coldStart ? 'Building your feed…' : 'No opportunities yet.'}
              </p>
              <p className="text-xs mt-1">
                {coldStart
                  ? 'Your first scan just started — opportunities will appear here shortly.'
                  : 'First scan is running — results appear in ~15 minutes. Ongoing scans run daily at 00:30 UTC.'}
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

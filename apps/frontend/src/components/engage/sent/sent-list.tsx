'use client';

import { useState, useCallback, useEffect } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { SentCardX } from './sent-card-x';
import { SentCardReddit } from './sent-card-reddit';
import type { GenerationHistoryEntry } from './generation-history';

interface SentReply {
  id: string;
  authorReplied: boolean;
  post: {
    id: string;
    content: string;
    state: string;
    releaseURL?: string | null;
    publishDate: string;
    impressions?: number;
    trafficScore?: number;
    analytics?: Array<{ label: string; data: Array<{ total: string }> }>;
    // Unified author of the reply: derived from the posting integration when one
    // authored it, else from the reply URL (settings.engageAuthor). The single
    // field the UI reads for "who replied" regardless of source.
    replyAuthor?: {
      handle: string;
      id?: string;
      name?: string;
      avatarUrl?: string;
    } | null;
  };
  opportunity: {
    id: string;
    platform: string;
    externalPostUrl: string;
    postContent: string;
    authorUsername: string;
    authorDisplayName?: string;
    authorFollowers?: number | null;
    authorAvatarUrl?: string | null;
    matchedKeywords?: string[];
    // Full version history of AI-generated reply drafts for this opportunity
    // (newest-first). Present when the user generated at least once.
    generationHistory?: GenerationHistoryEntry[];
  };
}

interface Stats {
  repliesCount: number;
  responseRate: number;
  totalImpressions: number;
  avgLikes: number;
}

export function SentList() {
  const fetch = useFetch();
  const toaster = useToaster();

  const [platform, setPlatform] = useState('');
  const [status, setStatus] = useState('');
  const [date, setDate] = useState('');
  const [page, setPage] = useState(1);
  const [urlSubmitId, setUrlSubmitId] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');

  // Stats use the SAME filters as the list (minus pagination), so the cards
  // reflect exactly what the list below shows. No `date` → all-time.
  const statsParams = new URLSearchParams({
    ...(platform && { platform }),
    ...(status && { status }),
    ...(date && { date }),
  });

  const { data: stats } = useSWR(
    `/engage/sent/stats?${statsParams}`,
    async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`engage/sent/stats returned ${res.status}`);
      return res.json() as Promise<Stats>;
    }
  );

  const queryParams = new URLSearchParams({
    page: String(page),
    limit: '20',
    ...(platform && { platform }),
    ...(status && { status }),
    ...(date && { date }),
  });

  const { data, mutate } = useSWR(
    `/engage/sent?${queryParams}`,
    async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`engage/sent returned ${res.status}`);
      return res.json() as Promise<{
        items: SentReply[];
        total: number;
        page: number;
        limit: number;
      }>;
    }
  );

  const submitUrl = useCallback(async () => {
    if (!urlSubmitId || !urlInput) return;
    try {
      const res = await fetch(`/engage/sent/${urlSubmitId}/reply-url`, {
        method: 'PATCH',
        body: JSON.stringify({ url: urlInput }),
      });
      if (!res.ok) {
        // Surface the server's reason on 400 so the user can tell apart an
        // invalid/not-found URL from a transient "could not verify, retry".
        let message = 'Failed to save URL — please retry';
        if (res.status === 400) {
          message = await res
            .json()
            .then((b) => b?.message || 'Invalid Reddit URL')
            .catch(() => 'Invalid Reddit URL');
        }
        toaster.show(message, 'warning');
        return;
      }
      toaster.show('URL saved', 'success');
      setUrlSubmitId(null);
      setUrlInput('');
      mutate();
    } catch {
      toaster.show('Failed to save URL — please retry', 'warning');
    }
  }, [urlSubmitId, urlInput, fetch, mutate, toaster]);

  const replies = data?.items ?? [];
  const total = data?.total ?? 0;

  const closeModal = useCallback(() => {
    setUrlSubmitId(null);
    setUrlInput('');
  }, []);

  // Document-level Escape handler — backdrop click already closes, this adds
  // keyboard parity for users who use the keyboard to interact with the modal.
  useEffect(() => {
    if (!urlSubmitId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [urlSubmitId, closeModal]);

  return (
    <div className="p-6">
      {/* Stats cells */}
      {stats && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          {[
            { label: '发出回复', value: stats.repliesCount },
            { label: '回复率', value: `${stats.responseRate}%` },
            { label: '总曝光量', value: stats.totalImpressions.toLocaleString() },
            { label: '平均获赞', value: stats.avgLikes },
          ].map((s) => (
            <div
              key={s.label}
              className="bg-[#1a2035] rounded-lg p-4 text-center"
            >
              <p className="text-2xl font-bold text-white">{s.value}</p>
              <p className="text-xs text-gray-500 mt-1">{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <select
          value={platform}
          onChange={(e) => { setPlatform(e.target.value); setPage(1); }}
          className="text-sm bg-[#1e2536] border border-[#2d3748] text-gray-300 rounded-lg px-3 py-1.5"
        >
          <option value="">All platforms</option>
          <option value="x">X</option>
          <option value="reddit">Reddit</option>
        </select>
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          className="text-sm bg-[#1e2536] border border-[#2d3748] text-gray-300 rounded-lg px-3 py-1.5"
        >
          <option value="">All statuses</option>
          <option value="published">Published</option>
          <option value="scheduled">Scheduled</option>
          <option value="manual">Manual</option>
          <option value="error">Error</option>
          {/* Combined rollups: settled = published(live) + scheduled; awaiting =
              manual link-pending + failed publishes (generated but not yet live). */}
          <option value="settled">Settled</option>
          <option value="awaiting">Awaiting review</option>
        </select>
        <select
          value={date}
          onChange={(e) => { setDate(e.target.value); setPage(1); }}
          className="text-sm bg-[#1e2536] border border-[#2d3748] text-gray-300 rounded-lg px-3 py-1.5"
        >
          <option value="">All time</option>
          <option value="today">Today</option>
          <option value="week">This week</option>
          <option value="month">This month</option>
        </select>
      </div>

      {/* URL submit modal */}
      {urlSubmitId && (() => {
        // The modal copy adapts to the platform of the reply being backfilled.
        const editing = replies.find((r) => r.id === urlSubmitId);
        const isX = (editing?.opportunity.platform ?? 'reddit') === 'x';
        return (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
          onClick={closeModal}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="reply-url-modal-title"
            className="bg-[#1a2035] rounded-xl p-6 w-[480px] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="reply-url-modal-title" className="text-white font-semibold mb-4">
              {isX ? 'Submit X Reply URL' : 'Submit Reddit Comment URL'}
            </h3>
            <input
              type="url"
              className="w-full bg-[#0f1219] border border-[#2d3748] text-white rounded-lg px-3 py-2 text-sm mb-4"
              placeholder={
                isX
                  ? 'https://x.com/.../status/...'
                  : 'https://www.reddit.com/r/.../comments/.../comment/...'
              }
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && urlInput) submitUrl();
              }}
              autoFocus
            />
            <div className="flex gap-2">
              <button
                onClick={closeModal}
                className="flex-1 py-2 text-sm text-gray-400 border border-[#2d3748] rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={submitUrl}
                className="flex-1 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg"
              >
                Save URL
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Reply list */}
      <div className="space-y-3">
        {replies.map((reply) => {
          const plt = reply.opportunity.platform ?? 'x';
          const onSubmitUrl = (id: string, existingUrl?: string) => {
            setUrlSubmitId(id);
            setUrlInput(existingUrl ?? '');
          };
          return plt === 'reddit' ? (
            <SentCardReddit
              key={reply.id}
              reply={reply}
              sentReplyId={reply.id}
              onSubmitUrl={onSubmitUrl}
            />
          ) : (
            <SentCardX
              key={reply.id}
              reply={reply}
              sentReplyId={reply.id}
              onSubmitUrl={onSubmitUrl}
            />
          );
        })}

        {replies.length === 0 && (
          <div className="text-center text-gray-500 text-sm py-16">
            <p className="text-4xl mb-3">💬</p>
            <p>No replies sent yet.</p>
          </div>
        )}
      </div>

      {/* Pagination */}
      {total > 20 && (
        <div className="flex justify-center gap-2 mt-4">
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
  );
}

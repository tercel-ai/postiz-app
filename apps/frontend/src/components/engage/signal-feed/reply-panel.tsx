'use client';

import { FC, useState, useCallback, useRef, useEffect } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import type { Opportunity } from './opportunity-card';

interface ReplyPanelProps {
  opportunity: Opportunity;
  replyAccounts: Array<{
    id: string;
    name: string;
    picture?: string;
    engageXReplyAccount?: { engageEnabled: boolean; defaultStrategy: string } | null;
  }>;
  onClose: () => void;
  onSent: () => void;
}

const STRATEGIES = [
  { value: 'EXPERT_ANSWER', label: 'Expert Answer', desc: 'Actionable, step-by-step advice' },
  { value: 'DATA_BACKED', label: 'Data Backed', desc: 'Lead with data and findings' },
  { value: 'EMPATHY_LED', label: 'Empathy Led', desc: 'Acknowledge first, then insight' },
];

const MAX_X_CHARS = 260;

export const ReplyPanel: FC<ReplyPanelProps> = ({
  opportunity,
  replyAccounts,
  onClose,
  onSent,
}) => {
  const fetch = useFetch();
  const toaster = useToaster();

  const enabledAccounts = replyAccounts.filter(
    (a) => a.engageXReplyAccount?.engageEnabled !== false
  );

  const [strategy, setStrategy] = useState('EXPERT_ANSWER');
  const [brandStrength, setBrandStrength] = useState(1);
  const [mentions, setMentions] = useState<string[]>([]);
  const [mentionInput, setMentionInput] = useState('');
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState(
    enabledAccounts[0]?.id ?? ''
  );
  const [sending, setSending] = useState(false);
  const [scheduledAt, setScheduledAt] = useState('');

  // Reddit 3-step state
  const [redditStep, setRedditStep] = useState<'draft' | 'url'>('draft');
  const [replyUrl, setReplyUrl] = useState('');
  const [copied, setCopied] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Abort any in-progress stream when the panel unmounts
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  // Sync selectedAccountId when replyAccounts arrives after mount (slow network race).
  useEffect(() => {
    if (!selectedAccountId && enabledAccounts[0]?.id) {
      setSelectedAccountId(enabledAccounts[0].id);
    }
    // enabledAccounts is recomputed every render from replyAccounts; key on its
    // first id to avoid re-running on every render once stable.
  }, [enabledAccounts[0]?.id, selectedAccountId]);

  // Modal-style a11y: bind Escape to close + manage focus on open/close.
  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [onClose]);

  const addMention = useCallback((raw: string) => {
    const tag = raw.trim().replace(/^#/, '');
    if (!tag || mentions.includes(tag) || mentions.length >= 20) return;
    setMentions((prev) => [...prev, tag]);
  }, [mentions]);

  const removeMention = useCallback((tag: string) => {
    setMentions((prev) => prev.filter((m) => m !== tag));
  }, []);

  const generateDraft = useCallback(async () => {
    if (streaming) {
      abortRef.current?.abort();
      return;
    }
    setDraft('');
    setStreaming(true);
    abortRef.current = new AbortController();

    try {
      const res = await fetch(`/engage/opportunities/${opportunity.id}/draft`, {
        method: 'POST',
        body: JSON.stringify({ strategy, brandStrength, mentions }),
        signal: abortRef.current.signal,
      });
      if (!res.ok) {
        toaster.show('Failed to generate draft', 'warning');
        return;
      }
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done_signal = false;

      while (!done_signal) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') { done_signal = true; break; }
          try {
            const parsed = JSON.parse(data) as { text?: string; error?: string };
            if (parsed.error) {
              toaster.show(`Generation error: ${parsed.error}`, 'warning');
              done_signal = true;
              break;
            }
            if (parsed.text) setDraft((prev) => prev + parsed.text);
          } catch {
            // ignore parse errors for non-JSON SSE frames
          }
        }
      }
    } catch (err: unknown) {
      const name = (err as Error)?.name;
      if (name === 'AbortError') {
        // user-initiated stop — keep partial draft visible without an error toast
        return;
      }
      // Network failure or unparseable stream — surface a concrete message
      toaster.show('Generation interrupted — check your connection', 'warning');
    } finally {
      setStreaming(false);
    }
  }, [opportunity.id, strategy, brandStrength, mentions, streaming, fetch, toaster]);

  const handleSend = useCallback(async () => {
    if (!draft || !selectedAccountId) return;
    setSending(true);
    try {
      const res = await fetch(`/engage/opportunities/${opportunity.id}/send-now`, {
        method: 'POST',
        body: JSON.stringify({
          integrationId: selectedAccountId,
          draftContent: draft,
          strategy,
          brandStrength,
        }),
      });
      if (!res.ok) {
        toaster.show('Failed to send reply', 'warning');
        return;
      }
      toaster.show('Reply sent!', 'success');
      onSent();
    } catch {
      toaster.show('Failed to send reply', 'warning');
    } finally {
      setSending(false);
    }
  }, [draft, selectedAccountId, opportunity.id, strategy, brandStrength, fetch, toaster, onSent]);

  const handleSchedule = useCallback(
    async (scheduledAt: string) => {
      if (!draft || !selectedAccountId) return;
      setSending(true);
      try {
        const res = await fetch(`/engage/opportunities/${opportunity.id}/schedule`, {
          method: 'POST',
          body: JSON.stringify({
            integrationId: selectedAccountId,
            draftContent: draft,
            strategy,
            brandStrength,
            scheduledAt,
          }),
        });
        if (!res.ok) {
          toaster.show('Failed to schedule reply', 'warning');
          return;
        }
        toaster.show('Reply scheduled!', 'success');
        onSent();
      } catch {
        toaster.show('Failed to schedule reply', 'warning');
      } finally {
        setSending(false);
      }
    },
    [draft, selectedAccountId, opportunity.id, strategy, brandStrength, fetch, toaster, onSent]
  );

  const handleConfirmReply = useCallback(
    async (url?: string) => {
      if (!draft) return;
      setSending(true);
      try {
        const res = await fetch(
          `/engage/opportunities/${opportunity.id}/manual-reply`,
          {
            method: 'POST',
            body: JSON.stringify({
              draftContent: draft,
              strategy,
              brandStrength,
              ...(url ? { replyUrl: url } : {}),
            }),
          }
        );
        if (!res.ok) {
          const message =
            res.status === 400
              ? 'Invalid Reddit URL format'
              : 'Failed to record reply — please retry';
          toaster.show(message, 'warning');
          return;
        }
        toaster.show(url ? 'Reply recorded with URL!' : 'Reply recorded!', 'success');
        onSent();
      } catch {
        toaster.show('Failed to record reply — please retry', 'warning');
      } finally {
        setSending(false);
      }
    },
    [draft, opportunity.id, strategy, brandStrength, fetch, toaster, onSent]
  );

  const isX = opportunity.platform === 'x';
  const charCount = draft.length;
  const overLimit = isX && charCount > MAX_X_CHARS;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="reply-panel-title"
      tabIndex={-1}
      className="w-[420px] flex-shrink-0 bg-[#111827] border-l border-[#1e2536] flex flex-col h-full outline-none"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e2536]">
        <h3 id="reply-panel-title" className="text-sm font-semibold text-white">
          Craft Reply
        </h3>
        <button
          onClick={onClose}
          aria-label="Close reply panel"
          className="text-gray-500 hover:text-white text-xl"
        >
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Original post preview */}
        <div className="bg-[#1e2536] rounded-lg p-3">
          <p className="text-xs text-gray-400 mb-1">
            @{opportunity.authorUsername}
          </p>
          <p className="text-sm text-gray-300 line-clamp-3">
            {opportunity.postContent}
          </p>
        </div>

        {/* Strategy selector */}
        <div>
          <p className="text-xs text-gray-400 mb-2 font-medium uppercase tracking-wide">
            Strategy
          </p>
          <div className="space-y-1">
            {STRATEGIES.map((s) => (
              <button
                key={s.value}
                onClick={() => setStrategy(s.value)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                  strategy === s.value
                    ? 'bg-blue-600/20 border border-blue-500/50 text-white'
                    : 'bg-[#1e2536] text-gray-400 hover:text-white'
                }`}
              >
                <span className="font-medium">{s.label}</span>
                <span className="text-xs text-gray-500 ml-2">{s.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Brand strength */}
        <div>
          <p className="text-xs text-gray-400 mb-2 font-medium uppercase tracking-wide">
            Brand Mention: {brandStrength}
          </p>
          <input
            type="range"
            min={0}
            max={3}
            value={brandStrength}
            onChange={(e) => setBrandStrength(Number(e.target.value))}
            className="w-full accent-blue-500"
          />
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>None</span>
            <span>Subtle</span>
            <span>Natural</span>
            <span>Direct</span>
          </div>
        </div>

        {/* Mentions */}
        <div>
          <p className="text-xs text-gray-400 mb-2 font-medium uppercase tracking-wide">
            Mentions
          </p>
          {/* Tag list */}
          {mentions.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {mentions.map((tag) => (
                <span
                  key={tag}
                  className="flex items-center gap-1 bg-blue-600/20 border border-blue-500/40 text-blue-300 text-xs rounded-full px-2 py-0.5"
                >
                  {tag}
                  <button
                    onClick={() => removeMention(tag)}
                    aria-label={`Remove ${tag}`}
                    className="text-blue-400 hover:text-white leading-none"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            type="text"
            value={mentionInput}
            onChange={(e) => setMentionInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
                e.preventDefault();
                addMention(mentionInput);
                setMentionInput('');
              } else if (e.key === 'Backspace' && !mentionInput && mentions.length > 0) {
                setMentions((prev) => prev.slice(0, -1));
              }
            }}
            onBlur={() => {
              if (mentionInput.trim()) {
                addMention(mentionInput);
                setMentionInput('');
              }
            }}
            placeholder="e.g. AI, ai agent, llm — press Enter to add"
            className="w-full bg-[#1e2536] border border-[#2d3748] text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 placeholder-gray-600"
          />
          <p className="text-xs text-gray-600 mt-1">
            Topics/entities the AI will naturally weave into the reply
          </p>
        </div>

        {/* Draft textarea */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">
              Draft
            </p>
            <button
              onClick={generateDraft}
              disabled={false}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              {streaming ? '⏹ Stop' : '✨ Generate'}
            </button>
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            className="w-full bg-[#1e2536] border border-[#2d3748] text-white rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:border-blue-500"
            placeholder="Click Generate to create a draft..."
          />
          {isX && (
            <div
              className={`text-right text-xs mt-1 ${
                overLimit ? 'text-red-400' : 'text-gray-500'
              }`}
            >
              {charCount}/{MAX_X_CHARS}
            </div>
          )}
        </div>

        {/* Account selector (X only) */}
        {isX && enabledAccounts.length > 0 && (
          <div>
            <p className="text-xs text-gray-400 mb-2 font-medium uppercase tracking-wide">
              Reply from
            </p>
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="w-full bg-[#1e2536] border border-[#2d3748] text-white rounded-lg px-3 py-2 text-sm"
            >
              {enabledAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Action bar */}
      <div className="p-4 border-t border-[#1e2536] space-y-2">
        {isX ? (
          <>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="py-2 px-3 text-sm text-gray-400 hover:text-white border border-[#2d3748] rounded-lg transition-colors"
              >
                Skip
              </button>
              <button
                onClick={handleSend}
                disabled={sending || !draft || overLimit || !selectedAccountId}
                className="flex-1 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg font-medium transition-colors"
              >
                {sending ? 'Sending...' : 'Send Reply'}
              </button>
            </div>
            {/* Schedule option */}
            <details className="text-xs text-gray-500">
              <summary className="cursor-pointer hover:text-gray-300 transition-colors">
                📅 Schedule for later
              </summary>
              <div className="flex gap-2 mt-2">
                <input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className="flex-1 bg-[#1e2536] border border-[#2d3748] text-white rounded-lg px-2 py-1 text-xs"
                  min={new Date().toISOString().slice(0, 16)}
                />
                <button
                  onClick={() => {
                    if (!scheduledAt) return;
                    // datetime-local yields a naive "YYYY-MM-DDTHH:MM" string;
                    // converting via the browser's Date pins it to the user's
                    // local TZ, then toISOString sends an unambiguous UTC moment
                    // so the backend doesn't interpret it in the server's TZ.
                    const absolute = new Date(scheduledAt);
                    if (Number.isNaN(absolute.getTime())) {
                      toaster.show('Invalid schedule time', 'warning');
                      return;
                    }
                    handleSchedule(absolute.toISOString());
                  }}
                  disabled={sending || !draft || overLimit || !selectedAccountId || !scheduledAt}
                  className="px-3 py-1 text-xs bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 text-white rounded-lg transition-colors"
                >
                  Schedule
                </button>
              </div>
            </details>
          </>
        ) : (
          // Reddit 3-step flow
          <>
            {redditStep === 'draft' && (
              <>
                <div className="flex items-center gap-2">
                  <button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(draft);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      } catch {
                        toaster.show(
                          'Copy failed — select & copy manually',
                          'warning'
                        );
                      }
                    }}
                    className={`flex-1 py-2 text-sm rounded-lg transition-colors ${
                      copied
                        ? 'bg-green-700 text-white'
                        : 'bg-[#2d3748] hover:bg-[#374151] text-white'
                    }`}
                  >
                    {copied ? '✓ Copied' : '📋 Copy Draft'}
                  </button>
                  <a
                    href={opportunity.externalPostUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 py-2 text-sm text-center bg-orange-600 hover:bg-orange-700 text-white rounded-lg transition-colors"
                  >
                    Open on Reddit ↗
                  </a>
                </div>
                <button
                  onClick={() => setRedditStep('url')}
                  disabled={!draft}
                  className="w-full py-2 text-sm bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg font-medium transition-colors"
                >
                  ✓ I Replied Manually
                </button>
              </>
            )}

            {redditStep === 'url' && (
              <div className="space-y-2">
                <p className="text-xs text-gray-400">
                  Paste your Reddit comment URL to enable metrics tracking:
                </p>
                <input
                  type="url"
                  value={replyUrl}
                  onChange={(e) => setReplyUrl(e.target.value)}
                  className="w-full bg-[#1e2536] border border-[#2d3748] text-white rounded-lg px-3 py-2 text-sm"
                  placeholder="https://www.reddit.com/r/.../comments/.../comment/..."
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => handleConfirmReply()}
                    disabled={sending}
                    className="flex-1 py-2 text-sm text-gray-400 border border-[#2d3748] rounded-lg hover:text-white disabled:opacity-50 transition-colors"
                  >
                    {sending ? 'Saving...' : 'Skip'}
                  </button>
                  <button
                    onClick={() => handleConfirmReply(replyUrl)}
                    disabled={sending || !replyUrl}
                    className="flex-1 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white rounded-lg font-medium transition-colors"
                  >
                    {sending ? 'Saving...' : 'Save URL'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

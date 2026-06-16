import { useCallback, useEffect, useRef, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';

// Lifecycle of an in-browser extension reply, from the page's point of view.
//   posting    — handed off to the extension; waiting for it to post + backfill
//   success    — confirmed posted (extension result message, or polled replyUrl)
//   processing — timed out waiting; the reply MAY have posted, so we never call
//                this a failure (re-posting would duplicate). The user is told to
//                check the Sent list.
//   failed     — the extension explicitly reported it could not post
export type ReplyPostingStatus =
  | 'idle'
  | 'posting'
  | 'success'
  | 'processing'
  | 'failed';

// The raw extension result message, when the resolution came via the fast path.
// Lets the caller preserve the "posted but link not recorded" nuance in toasts.
export interface ExtensionReplyResult {
  ok?: boolean;
  backfilled?: boolean;
  permalink?: string;
  error?: string;
}

export interface ReplyPostingResolution {
  status: 'success' | 'processing' | 'failed';
  error?: string;
  message?: ExtensionReplyResult;
}

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 20000;

/**
 * Drives a deterministic success/failure signal after handing a draft to the
 * browser extension. Two sources race:
 *   1. fast path — the extension posts an `engage-reply-result` message back;
 *   2. fallback  — poll GET /engage/sent/:id/status until `replyUrl` is set
 *      (works regardless of which posting path — Reddit bg / X executeScript —
 *      the extension used, and survives a lost result message).
 * Whichever fires first resolves the cycle; a 20s timeout settles to
 * `processing` (NOT failure) so the user is never nudged into a duplicate post.
 */
export function useReplyPosting(
  opportunityId: string,
  onResolved?: (resolution: ReplyPostingResolution) => void
) {
  const fetch = useFetch();
  const [status, setStatus] = useState<ReplyPostingStatus>('idle');

  const sentReplyIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolvedRef = useRef(true); // no active cycle until begin()
  const onResolvedRef = useRef(onResolved);
  onResolvedRef.current = onResolved;

  const clearTimers = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (timeoutTimerRef.current) {
      clearTimeout(timeoutTimerRef.current);
      timeoutTimerRef.current = null;
    }
  }, []);

  const resolve = useCallback(
    (resolution: ReplyPostingResolution) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      clearTimers();
      setStatus(resolution.status);
      onResolvedRef.current?.(resolution);
    },
    [clearTimers]
  );

  const begin = useCallback(
    (sentReplyId: string) => {
      clearTimers();
      resolvedRef.current = false;
      sentReplyIdRef.current = sentReplyId;
      setStatus('posting');

      pollTimerRef.current = setInterval(async () => {
        const id = sentReplyIdRef.current;
        if (!id) return;
        try {
          const res = await fetch(`/engage/sent/${id}/status`);
          if (!res.ok) return;
          const data = await res.json();
          // The extension backfilled the permalink → the reply is live.
          if (data?.replyUrl) resolve({ status: 'success' });
        } catch {
          // Transient network error — keep polling until the timeout settles it.
        }
      }, POLL_INTERVAL_MS);

      timeoutTimerRef.current = setTimeout(
        () => resolve({ status: 'processing' }),
        POLL_TIMEOUT_MS
      );
    },
    [clearTimers, fetch, resolve]
  );

  // Fast path: the extension reports the outcome directly.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window || e.origin !== window.location.origin) return;
      const data: any = e.data;
      if (!data || data.source !== EXTENSION_MESSAGE.resultSource) return;
      if (data.action !== EXTENSION_MESSAGE.engageReplyResult) return;
      if (data.opportunityId && data.opportunityId !== opportunityId) return;
      if (resolvedRef.current) return; // no in-flight post for this opportunity

      const result: ExtensionReplyResult = data.result ?? {};
      if (result.ok) {
        resolve({ status: 'success', message: result });
      } else {
        resolve({ status: 'failed', error: result.error, message: result });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [opportunityId, resolve]);

  // Tear down any in-flight cycle on unmount.
  useEffect(() => clearTimers, [clearTimers]);

  return { status, begin, posting: status === 'posting' };
}

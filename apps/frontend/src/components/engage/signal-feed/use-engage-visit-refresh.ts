'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

// Per-org cache of the server-provided `nextRefreshAt`. The client skips the
// trigger entirely until this time passes, so a frequent visitor's repeat
// visits cost zero round-trips (the server already decided nothing is due).
const KEY_PREFIX = 'engage:nextRefreshAt:';
const keyFor = (orgId: string) => `${KEY_PREFIX}${orgId}`;

function readNext(orgId: string): number {
  try {
    return Number(window.localStorage.getItem(keyFor(orgId)) ?? 0) || 0;
  } catch {
    return 0; // storage disabled → always eligible; the server gate still holds
  }
}

function writeNext(orgId: string, ms: number): void {
  try {
    window.localStorage.setItem(keyFor(orgId), String(ms));
  } catch {
    /* storage disabled — no client cache, server gate is the backstop */
  }
}

/**
 * Drop the cached gate so the next visit (or the live effect) re-triggers
 * immediately. Call after adding/removing a keyword / tracked account /
 * monitored channel, or on an explicit refresh — those new units are due now
 * and must not be suppressed by a stale `nextRefreshAt`. No-op on the server.
 *
 * Pass `orgId` to clear one org; omit it to clear ALL cached orgs (used by the
 * settings managers, which don't have the org id handy — a session is one
 * active org anyway, so clearing all is harmless).
 */
export function invalidateEngageRefresh(orgId?: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (orgId) {
      window.localStorage.removeItem(keyFor(orgId));
      return;
    }
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(KEY_PREFIX)) stale.push(k);
    }
    stale.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

interface Options {
  // Invoked after an *accepted* trigger so the caller can revalidate the feed
  // (the backend kicked async work, so a re-read shortly after surfaces it).
  onAccepted?: () => void;
}

/**
 * Page-visit trigger for Engage. On mount and whenever the tab regains
 * focus/visibility, it POSTs `/engage/refresh-on-visit` — but ONLY when the
 * cached `nextRefreshAt` has passed. Fire-and-forget; never blocks render.
 * Returns `coldStart` (no prior scan → empty feed) for the first-visit UI.
 */
export function useEngageVisitRefresh(
  orgId: string | null | undefined,
  opts: Options = {}
): { coldStart: boolean } {
  const fetch = useFetch();
  const [coldStart, setColdStart] = useState(false);
  const inFlight = useRef(false);
  // Keep the callback in a ref so `maybeRefresh` stays stable across renders
  // (an inline `onAccepted` would otherwise re-arm the listeners every render).
  const onAcceptedRef = useRef(opts.onAccepted);
  onAcceptedRef.current = opts.onAccepted;

  const maybeRefresh = useCallback(async () => {
    if (!orgId || typeof window === 'undefined') return;
    if (inFlight.current) return;
    if (document.visibilityState === 'hidden') return;
    if (Date.now() < readNext(orgId)) return; // server said: nothing due yet

    inFlight.current = true;
    try {
      const res = await fetch('/engage/refresh-on-visit', { method: 'POST' });
      if (!res.ok) return;
      const body = (await res.json()) as {
        status: 'accepted' | 'throttled';
        coldStart: boolean;
        nextRefreshAt: string;
      };
      const nextMs = new Date(body.nextRefreshAt).getTime();
      if (Number.isFinite(nextMs)) writeNext(orgId, nextMs);
      setColdStart(body.coldStart);
      if (body.status === 'accepted') onAcceptedRef.current?.();
    } catch {
      /* fire-and-forget: a failed trigger just means staler data, not an error */
    } finally {
      inFlight.current = false;
    }
  }, [orgId, fetch]);

  useEffect(() => {
    maybeRefresh();
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') maybeRefresh();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [maybeRefresh]);

  return { coldStart };
}

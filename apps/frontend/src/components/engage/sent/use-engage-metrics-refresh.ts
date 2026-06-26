'use client';

import { useEffect, useRef } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

/**
 * Event-driven metrics refresh for /engage/sent. Whenever the set of visible
 * PUBLISHED posts changes (sort / filter / page), it POSTs the exact post ids on
 * screen to `/engage/sent/metrics/refresh`. The server gates each by the per-plan
 * metrics interval and fire-and-forgets the X/Reddit fetch for the due ones, so
 * this is what keeps "what the user is looking at" fresh under the "no views → no
 * update" model — nothing refreshes unless a page is actually shown.
 *
 * Surfacing the result is the tricky part: the fire-and-forget X/Reddit fetch
 * runs serially server-side and can land anywhere from <1s to well past 10s
 * later, and the freshly written Post values aren't visible until the next list
 * read. We therefore POLL: once the server reports `accepted` ids (a real fetch
 * was kicked), we re-`mutate()` the list on an interval and stop as soon as the
 * visible posts' metrics actually change (`metricsSignature` differs from the
 * snapshot captured at trigger time), or after a bounded number of attempts.
 * This replaces the old two-shot 4s/12s re-read, which silently missed any fetch
 * slower than 12s. We deliberately do NOT poll `GET /sent/:id/status` — that
 * endpoint carries only { id, state, replyUrl } for the extension reply-URL
 * backfill and returns no metrics.
 *
 * We never block render and never re-fire the POST for the same id set (a stable
 * id signature guards repeats); only a new page / filter / sort re-triggers.
 */
const POLL_MAX_ATTEMPTS = 8; // ~28s worst case before giving up
const POLL_INTERVAL_MS = 3_500;
const POLL_INITIAL_DELAY_MS = 3_000;

export function useEngageMetricsRefresh(
  postIds: string[],
  // A snapshot of the visible posts' metric values (id:impressions:traffic …).
  // Used purely to detect when a server-side fetch has surfaced — when this
  // string differs from the one captured at trigger time, the poll stops early.
  metricsSignature: string,
  mutate: () => void
): void {
  const fetch = useFetch();
  const lastIdSignature = useRef<string>('');
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;
  // Always-current metrics snapshot so the poll loop can compare the latest
  // re-read against the baseline it captured when the fetch was kicked.
  const metricsSigRef = useRef(metricsSignature);
  metricsSigRef.current = metricsSignature;

  // Stable, order-independent signature so re-renders with the same posts don't
  // re-POST, but a new page / filter / sort (different ids) does.
  const idSignature = [...postIds].sort().join(',');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!idSignature) return; // nothing PUBLISHED on screen
    if (idSignature === lastIdSignature.current) return;
    lastIdSignature.current = idSignature;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      try {
        const res = await fetch('/engage/sent/metrics/refresh', {
          method: 'POST',
          body: JSON.stringify({ postIds: idSignature.split(',') }),
        });
        if (cancelled || !res.ok) return;
        const body = (await res.json()) as {
          accepted: string[];
          throttled: string[];
          nextRefreshAt: string;
        };
        // Nothing was kicked (all throttled / out of window) → values are already
        // as fresh as the per-plan interval allows; no point polling.
        if (!body.accepted?.length) return;

        // Poll the list until the visible metrics change, or attempts run out.
        const baseline = metricsSigRef.current;
        let attempts = 0;
        const step = () => {
          if (cancelled || attempts >= POLL_MAX_ATTEMPTS) return;
          attempts += 1;
          mutateRef.current();
          timer = setTimeout(() => {
            if (cancelled) return;
            // The re-read surfaced new metrics → done.
            if (metricsSigRef.current !== baseline) return;
            step();
          }, POLL_INTERVAL_MS);
        };
        // Give the server's fetch a head start before the first re-read.
        timer = setTimeout(step, POLL_INITIAL_DELAY_MS);
      } catch {
        /* fire-and-forget: a failed trigger just means staler metrics */
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [idSignature, fetch]);
}

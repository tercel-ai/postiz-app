'use client';

import { useEffect, useRef } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

/**
 * Event-driven metrics refresh for /engage/sent. Whenever the list of visible
 * PUBLISHED posts changes (sort / filter / page / tab focus), it POSTs the exact
 * post ids on screen to `/engage/sent/metrics/refresh`. The server gates each by
 * the per-plan metrics interval and fire-and-forgets the X/Reddit fetch for the
 * due ones, so this is what keeps "what the user is looking at" fresh under the
 * "no views → no update" model — nothing refreshes unless a page is actually
 * shown.
 *
 * When the server reports `accepted` ids (a real fetch was kicked), the freshly
 * written Post values aren't visible until the next list read, so we re-`mutate`
 * a couple of times after a short delay to surface them. We never block render
 * and never re-fire for the same id set (a stable signature guards repeats).
 */
export function useEngageMetricsRefresh(
  postIds: string[],
  mutate: () => void
): void {
  const fetch = useFetch();
  const lastSignature = useRef<string>('');
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;

  // Stable, order-independent signature so re-renders with the same posts don't
  // re-trigger, but a new page / filter / sort (different ids) does.
  const signature = [...postIds].sort().join(',');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!signature) return; // nothing PUBLISHED on screen
    if (signature === lastSignature.current) return;
    lastSignature.current = signature;

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    (async () => {
      try {
        const res = await fetch('/engage/sent/metrics/refresh', {
          method: 'POST',
          body: JSON.stringify({ postIds: signature.split(',') }),
        });
        if (!res.ok) return;
        const body = (await res.json()) as {
          accepted: string[];
          throttled: string[];
          nextRefreshAt: string;
        };
        // A fetch was kicked server-side; re-read shortly after so the newly
        // written impressions/traffic surface. Two passes cover a slow API.
        if (!cancelled && body.accepted?.length) {
          timers.push(setTimeout(() => mutateRef.current(), 4_000));
          timers.push(setTimeout(() => mutateRef.current(), 12_000));
        }
      } catch {
        /* fire-and-forget: a failed trigger just means staler metrics */
      }
    })();

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [signature, fetch]);
}

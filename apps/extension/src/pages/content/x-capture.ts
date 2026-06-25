// Document-start MAIN-world interceptor for X "read" GraphQL requests.
//
// Registered as a content script with world:'MAIN' + run_at:'document_start' on
// x.com (see vite.config.base.ts), so it installs BEFORE X's own scripts run.
// It patches window.fetch + XMLHttpRequest to capture the JSON response of
// specific GraphQL operations (SearchTimeline, TweetResultByRestId) and stash the
// latest one per operation on window.__aiseeXCaptured.
//
// The extension (background) navigates a tab and then reads window.__aiseeXCaptured
// via chrome.scripting.executeScript({ world: 'MAIN' }). Because the request is
// fired and signed by X's OWN web app, it carries native fingerprints
// (x-client-transaction-id, Referer, sec-fetch, TLS) that a background fetch can't
// reproduce — the same reason the in-tab poster is reliable.
//
// Passive + read-only: it only observes responses; it never alters requests or page
// behaviour. The patch lives only in the page's local JS — X's servers cannot see
// it — so it is harmless on the user's normal x.com browsing.

// Operations whose responses we capture. Matched as a substring of the request URL.
const AISEE_CAPTURED_OPS = [
  'SearchTimeline',
  'TweetDetail',
  'TweetResultByRestId',
  'UserByScreenName',
  'UserTweets',
];

interface AiseeCapturedEntry {
  op: string;
  at: number;
  data: unknown;
}

export function installXReadInterceptor(): void {
  const w = window as unknown as {
    __aiseeXCaptured?: Record<string, AiseeCapturedEntry>;
    __aiseeXCaptureInstalled?: boolean;
    fetch: typeof fetch;
  };
  if (w.__aiseeXCaptureInstalled) return;
  w.__aiseeXCaptureInstalled = true;
  w.__aiseeXCaptured = w.__aiseeXCaptured || {};

  // Substring match. Assumes no captured op name is a substring of another
  // (true for the current set); revisit if a new op overlaps an existing one.
  const opFromUrl = (url: string): string | null => {
    for (const op of AISEE_CAPTURED_OPS) {
      if (url.indexOf(op) !== -1) return op;
    }
    return null;
  };

  const stash = (op: string, data: unknown): void => {
    try {
      w.__aiseeXCaptured![op] = { op, at: Date.now(), data };
    } catch {
      /* ignore */
    }
  };

  // ── patch fetch ──────────────────────────────────────────────────────────
  const origFetch = w.fetch;
  if (typeof origFetch === 'function') {
    w.fetch = function (this: unknown, ...args: unknown[]) {
      return (origFetch as (...a: unknown[]) => Promise<Response>)
        .apply(this, args)
        .then((res: Response) => {
          try {
            const first = args[0] as string | { url?: string } | undefined;
            const url =
              typeof first === 'string' ? first : first?.url;
            const op = typeof url === 'string' ? opFromUrl(url) : null;
            if (op) {
              res
                .clone()
                .json()
                .then((j) => stash(op, j))
                .catch(() => {});
            }
          } catch {
            /* ignore */
          }
          return res;
        });
    } as typeof fetch;
  }

  // ── patch XHR ────────────────────────────────────────────────────────────
  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: any, ...a: any[]) {
    this.__aiseeUrl = a[1];
    return OrigOpen.apply(this, a as any);
  };
  XMLHttpRequest.prototype.send = function (this: any, ...a: any[]) {
    this.addEventListener('load', function (this: any) {
      try {
        const op =
          typeof this.__aiseeUrl === 'string'
            ? opFromUrl(this.__aiseeUrl)
            : null;
        if (op) stash(op, JSON.parse(this.responseText));
      } catch {
        /* ignore */
      }
    });
    return OrigSend.apply(this, a as any);
  };
}

// Self-install when injected as a content script.
installXReadInterceptor();

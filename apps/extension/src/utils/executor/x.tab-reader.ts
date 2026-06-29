// Reads X data the SAME way the in-tab poster writes it: open a real (background)
// x.com tab and let X's OWN web app fire the GraphQL request, then read the
// response that the document-start MAIN-world interceptor (x-capture.ts) stashed
// on window.__aiseeXCaptured. Because X's page fires the request, it carries the
// native x-client-transaction-id / Referer / sec-fetch a background fetch cannot.
//
// Two usage shapes:
//   - openXReadTab(): one tab reused for a whole scan run (navigate per keyword,
//     close once at the end) — avoids tab churn for serial keyword search.
//   - readXOnce(url, op): open → capture → close, for one-off reads (metrics),
//     mirroring the poster's per-action tab lifecycle.

const TAB_LOAD_TIMEOUT_MS = 15_000;
const CAPTURE_POLL_MS = 250;
const CAPTURE_TIMEOUT_MS = 8_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Resolve once the tab finishes its top-level load (or times out). */
function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    const listener = (
      updatedTabId: number,
      info: chrome.tabs.TabChangeInfo
    ) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** Best-effort close of a background read tab (nothing to show the user). */
async function closeTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    console.warn('[aisee][x-read] closeTab failed', e);
  }
}

/**
 * Read the captured response for `op` from the tab's MAIN world, but only if it
 * was captured at/after `sinceMs` (so we never return a stale capture from a
 * previous navigation). Returns the response JSON or null.
 */
async function readCaptured(
  tabId: number,
  op: string,
  sinceMs: number
): Promise<unknown | null> {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (operation: string, since: number) => {
        const cap = (window as unknown as {
          __aiseeXCaptured?: Record<string, { at: number; data: unknown }>;
        }).__aiseeXCaptured;
        const entry = cap && cap[operation];
        return entry && entry.at >= since ? entry.data : null;
      },
      args: [op, sinceMs],
    });
    return res?.result ?? null;
  } catch (e) {
    console.warn('[aisee][x-read] readCaptured failed', e);
    return null;
  }
}

/**
 * Navigate `tabId` to `url`, wait for load, then poll for X's own captured
 * response to `op`. Returns the response JSON, or null on timeout / failure.
 */
async function navigateAndCapture(
  tabId: number,
  url: string,
  op: string
): Promise<unknown | null> {
  const since = Date.now();
  // NOTE: waitForTabComplete may resolve on a stale 'complete'; the capture poll
  // below (bounded by CAPTURE_TIMEOUT_MS) is what actually waits for X's request,
  // so an early/late tab-complete affects only latency, not correctness.
  try {
    await chrome.tabs.update(tabId, { url });
  } catch (e) {
    console.warn('[aisee][x-read] navigate failed', e);
    return null;
  }
  await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const data = await readCaptured(tabId, op, since);
    if (data != null) return data;
    await sleep(CAPTURE_POLL_MS);
  }
  return null;
}

export interface XReadTab {
  /** Navigate to `url` and return X's own captured response for `op` (or null). */
  navigateAndCapture(url: string, op: string): Promise<unknown | null>;
  /**
   * Navigate to `url` and wait for the tab to finish loading, WITHOUT polling
   * for a capture. Use this for "warm-up" hops (e.g. visiting a profile page
   * to seed the tab's navigation history before a real capture step).
   */
  navigate(url: string): Promise<void>;
  /** Close the underlying background tab. */
  close(): Promise<void>;
}

/**
 * Open ONE reusable background tab for a scan run. Caller navigates it per keyword
 * (serial) and calls close() once at the end. Returns null if the tab can't open.
 */
export async function openXReadTab(): Promise<XReadTab | null> {
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    tabId = tab.id ?? undefined;
  } catch (e) {
    console.warn('[aisee][x-read] tabs.create failed', e);
    return null;
  }
  if (tabId == null) return null;
  const id = tabId;

  async function navigateOnly(url: string): Promise<void> {
    try {
      await chrome.tabs.update(id, { url });
    } catch (e) {
      console.warn('[aisee][x-read] navigate failed', e);
      return;
    }
    await waitForTabComplete(id, TAB_LOAD_TIMEOUT_MS);
  }

  return {
    navigateAndCapture: (url: string, op: string) =>
      navigateAndCapture(id, url, op),
    navigate: navigateOnly,
    close: () => closeTab(id),
  };
}

/**
 * Two-step read that mimics organic browsing:
 *   1. Navigate to `profileUrl` (full page load) — seeds the tab's history
 *      and HTTP Referer for the subsequent search request.
 *   2. Navigate to `searchUrl` via chrome.tabs.update (NOT executeScript).
 *      Using chrome.tabs.update ensures the tab is in 'loading' state when
 *      the promise resolves, so waitForTabComplete never misses the 'complete'
 *      event (race-free). Chrome sets Referer = profileUrl automatically for
 *      same-origin navigations triggered this way.
 *   3. After the search page loads, override document.visibilityState before
 *      dispatching visibility events — X reads the property via its getter,
 *      not just listens to the event, so patching the getter is required to
 *      unblock deferred SearchTimeline requests in background tabs.
 */
export async function readViaProfile(
  profileUrl: string,
  searchUrl: string,
  op: string,
  opts: { keepOpen?: boolean } = {}
): Promise<unknown | null> {
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    tabId = tab.id ?? undefined;
  } catch (e) {
    console.warn('[aisee][x-read] readViaProfile: tabs.create failed', e);
    return null;
  }
  if (tabId == null) return null;
  const id = tabId;

  try {
    // ── Step 1: visit the account's profile page ─────────────────────────
    try {
      await chrome.tabs.update(id, { url: profileUrl });
    } catch (e) {
      console.warn('[aisee][x-read] profile nav failed', e);
      return null;
    }
    await waitForTabComplete(id, TAB_LOAD_TIMEOUT_MS);

    // ── Step 2: navigate to search URL ───────────────────────────────────
    // chrome.tabs.update guarantees the tab enters 'loading' before the
    // promise resolves → waitForTabComplete attaches its listener before the
    // tab reaches 'complete', avoiding the race where a fast-loading cached
    // page fires 'complete' before the listener is registered.
    const since = Date.now();
    try {
      await chrome.tabs.update(id, { url: searchUrl });
    } catch (e) {
      console.warn('[aisee][x-read] search nav failed', e);
      return null;
    }
    await waitForTabComplete(id, TAB_LOAD_TIMEOUT_MS);

    // ── Step 3: override visibility + nudge deferred requests ────────────
    // X reads document.visibilityState via its getter (not just via events),
    // so redefining the getter to always return 'visible' is required before
    // dispatching visibilitychange — otherwise the dispatch is a no-op.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: id },
        world: 'MAIN',
        func: () => {
          try {
            Object.defineProperty(document, 'visibilityState', {
              get: () => 'visible',
              configurable: true,
            });
            Object.defineProperty(document, 'hidden', {
              get: () => false,
              configurable: true,
            });
          } catch (_) {}
          document.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event('focus'));
        },
      });
    } catch (_) {
      // Non-fatal; poll still runs.
    }

    // ── Step 4: poll for the captured GraphQL response ────────────────────
    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const data = await readCaptured(id, op, since);
      if (data != null) return data;
      await sleep(CAPTURE_POLL_MS);
    }
    console.warn('[aisee][x-read] readViaProfile: capture timed out for', op);
    return null;
  } finally {
    if (!opts.keepOpen) await closeTab(id);
  }
}

/**
 * One-off read: open a background tab, navigate to `url`, capture `op`, close.
 * Mirrors the poster's per-action tab lifecycle (used by metrics).
 */
export async function readXOnce(
  url: string,
  op: string
): Promise<unknown | null> {
  const session = await openXReadTab();
  if (!session) return null;
  try {
    return await session.navigateAndCapture(url, op);
  } finally {
    await session.close();
  }
}

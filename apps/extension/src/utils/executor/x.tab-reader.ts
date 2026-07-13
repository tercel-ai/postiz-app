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

/**
 * Scroll an already-loaded X page to trigger the next timeline request, then
 * poll for a fresh captured response to `op`. Returns null when no new response
 * appears within the normal capture timeout.
 */
async function scrollAndCapture(
  tabId: number,
  op: string
): Promise<unknown | null> {
  const since = Date.now();
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        window.scrollBy({
          top: Math.max(window.innerHeight * 1.5, 900),
          left: 0,
          behavior: 'smooth',
        });
        window.dispatchEvent(new WheelEvent('wheel', { deltaY: 900 }));
      },
    });
  } catch (e) {
    console.warn('[aisee][x-read] scroll failed', e);
    return null;
  }
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
  /** Scroll the current X page and return the next captured response for `op`. */
  scrollAndCapture(op: string): Promise<unknown | null>;
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
    scrollAndCapture: (op: string) => scrollAndCapture(id, op),
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
// How long to linger on the search page after capturing the response, in ms.
// A real user takes ~1-3 s to glance at results before closing/navigating.
// Closing immediately after capture looks bot-like in session-duration signals.
const POST_CAPTURE_LINGER_MIN_MS = 1_500;
const POST_CAPTURE_LINGER_JITTER_MS = 1_500; // uniform [1500, 3000) ms

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
      if (data != null) {
        // Linger on the page before closing — a real user takes a moment to
        // scan the results before navigating away. Instant-close is a
        // recognisable bot signal in session-duration heuristics.
        if (!opts.keepOpen) {
          const linger =
            POST_CAPTURE_LINGER_MIN_MS +
            Math.floor(Math.random() * POST_CAPTURE_LINGER_JITTER_MS);
          await sleep(linger);
        }
        return data;
      }
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

// ── Shared warm read tab (reused across by-id reads to avoid tab churn) ──────
//
// Opening a fresh background tab per read is wasteful when the user refreshes
// several replies in a row. We keep ONE background tab warm and navigate it per
// read — X's own JS still fires the GraphQL, so the real fingerprint
// (x-client-transaction-id / Referer / sec-fetch) is preserved exactly as a
// one-off read. It opens lazily on the first read and auto-closes after an idle
// gap. MV3 service workers can be killed before the idle timer fires, so we also
// record the tab id in chrome.storage.session and reap any orphan on the next
// worker start (reapOrphanXReadTab, called from the background entry point).

const SHARED_TAB_IDLE_MS = 45_000;
const SHARED_TAB_STORAGE_KEY = 'aisee_x_read_tab_id';

let sharedTabId: number | null = null;
let sharedIdleTimer: ReturnType<typeof setTimeout> | null = null;
// Serialise reads: one tab can only capture one op at a time, so concurrent
// callers queue on this chain instead of clobbering each other's navigation.
let sharedChain: Promise<unknown> = Promise.resolve();
let removalListenerAttached = false;

async function rememberSharedTab(id: number | null): Promise<void> {
  try {
    if (id == null) await chrome.storage.session.remove(SHARED_TAB_STORAGE_KEY);
    else await chrome.storage.session.set({ [SHARED_TAB_STORAGE_KEY]: id });
  } catch {
    // storage.session unavailable → orphan reaping degrades, reads still work.
  }
}

function attachRemovalListener(): void {
  if (removalListenerAttached) return;
  removalListenerAttached = true;
  try {
    chrome.tabs.onRemoved.addListener((closedId) => {
      if (closedId !== sharedTabId) return;
      // The user (or the browser) closed our warm tab → drop the singleton so
      // the next read lazily opens a fresh one.
      sharedTabId = null;
      if (sharedIdleTimer) {
        clearTimeout(sharedIdleTimer);
        sharedIdleTimer = null;
      }
      void rememberSharedTab(null);
    });
  } catch {
    // onRemoved unavailable in this context — non-fatal.
  }
}

async function tabExists(id: number): Promise<boolean> {
  try {
    await chrome.tabs.get(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Close a read tab orphaned by a previous (terminated) service worker. Call once
 * on worker startup: the idle-close timer lives in the worker, so if the worker
 * is killed mid-idle the tab would otherwise linger forever.
 */
export async function reapOrphanXReadTab(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(SHARED_TAB_STORAGE_KEY);
    const id = stored?.[SHARED_TAB_STORAGE_KEY];
    if (typeof id !== 'number') return;
    // Don't kill a tab this (already-running) worker is actively reusing.
    if (id !== sharedTabId) await closeTab(id);
    await rememberSharedTab(null);
  } catch {
    // Nothing stored / storage unavailable — nothing to reap.
  }
}

function scheduleSharedIdleClose(): void {
  if (sharedIdleTimer) clearTimeout(sharedIdleTimer);
  sharedIdleTimer = setTimeout(() => {
    sharedIdleTimer = null;
    const id = sharedTabId;
    sharedTabId = null;
    void rememberSharedTab(null);
    if (id != null) void closeTab(id);
  }, SHARED_TAB_IDLE_MS);
}

async function ensureSharedTab(): Promise<number | null> {
  attachRemovalListener();
  if (sharedTabId != null && (await tabExists(sharedTabId))) return sharedTabId;
  sharedTabId = null;
  try {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    sharedTabId = tab.id ?? null;
  } catch (e) {
    console.warn('[aisee][x-read] shared tabs.create failed', e);
    return null;
  }
  await rememberSharedTab(sharedTabId);
  return sharedTabId;
}

/**
 * By-id read on the shared warm tab — reused across calls so refreshing several
 * replies in a row doesn't open/close a tab each time. Serialised; degrades to a
 * one-off tab if the shared tab can't be created; reschedules the idle-close
 * after every read so the tab disappears once the user stops refreshing.
 */
export async function readXShared(
  url: string,
  op: string
): Promise<unknown | null> {
  const run = sharedChain.then(async () => {
    const id = await ensureSharedTab();
    if (id == null) return readXOnce(url, op);
    try {
      return await navigateAndCapture(id, url, op);
    } finally {
      scheduleSharedIdleClose();
    }
  });
  // Keep the chain alive even if this read rejects, so a failure doesn't wedge
  // every queued read behind it.
  sharedChain = run.catch(() => undefined);
  return run;
}

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
  return {
    navigateAndCapture: (url: string, op: string) =>
      navigateAndCapture(id, url, op),
    close: () => closeTab(id),
  };
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

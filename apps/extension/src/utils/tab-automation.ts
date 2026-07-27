// Shared background-tab automation primitives for the "drive the platform's own
// web app in a real tab" write/read paths (Medium, Quora, Hacker News posters +
// metrics). This is the same approach the X and LinkedIn executors take: open a
// tab with the user's OWN session, let the platform render, then fill/scrape via
// chrome.scripting.executeScript. It exists so the newer platforms don't each
// re-implement the tab lifecycle (open → wait-for-load → inject → close/focus)
// that x.poster / linkedin.tab-reader hand-rolled.
//
// executeScript (not a content script) is used deliberately: several of these
// sites serve a strict CSP that blocks crxjs's dynamic-import content-script
// loader, so a normal content script never runs. executeScript injects into the
// page directly and is not subject to the page's script-src CSP.

const DEFAULT_TAB_LOAD_TIMEOUT_MS = 20_000;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Resolve once the tab finishes its top-level load (or the timeout fires). */
export function waitForTabComplete(
  tabId: number,
  timeoutMs: number = DEFAULT_TAB_LOAD_TIMEOUT_MS
): Promise<void> {
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

/** Best-effort: bring a possibly-background tab to the foreground. */
export async function focusTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch (e) {
    console.warn('[aisee][tab] focusTab failed', e);
  }
}

/** Best-effort: close a tab once we're done with it. */
export async function closeTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    console.warn('[aisee][tab] closeTab failed', e);
  }
}

/** Current URL of a tab (post-redirect), or null if it can't be read. */
export async function getTabUrl(tabId: number): Promise<string | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url ?? null;
  } catch (e) {
    console.warn('[aisee][tab] getTabUrl failed', e);
    return null;
  }
}

/**
 * Run a self-contained function inside the page (ISOLATED world by default) and
 * return its result, or null on injection failure. The function is serialized
 * by executeScript, so it MUST NOT reference any outer-scope variable — pass
 * everything it needs through `args`. An async injected function is awaited by
 * executeScript, so the return type is unwrapped with `Awaited<>`.
 */
export async function runInPage<T, A extends unknown[] = []>(
  tabId: number,
  func: (...args: A) => T,
  args?: A,
  opts: { world?: 'MAIN' | 'ISOLATED' } = {}
): Promise<Awaited<T> | null> {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: opts.world,
      func,
      ...(args ? { args } : {}),
    } as chrome.scripting.ScriptInjection<A, T>);
    return (res?.result as Awaited<T>) ?? null;
  } catch (e) {
    console.warn('[aisee][tab] executeScript failed', e);
    return null;
  }
}

export interface OpenTabHandle {
  tabId: number;
}

/**
 * Open a tab at `url` (background by default), wait for it to finish loading,
 * then settle briefly so client-rendered SPAs (Medium/Quora) have hydrated
 * before the first inject. Returns the tab handle, or null if the tab could not
 * be created. The caller owns closing/focusing the tab.
 */
export async function openTab(
  url: string,
  opts: {
    active?: boolean;
    loadTimeoutMs?: number;
    settleMs?: number;
  } = {}
): Promise<OpenTabHandle | null> {
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url, active: opts.active ?? false });
    tabId = tab.id ?? undefined;
  } catch (e) {
    console.warn('[aisee][tab] tabs.create failed', e);
    return null;
  }
  if (tabId == null) return null;
  await waitForTabComplete(tabId, opts.loadTimeoutMs ?? DEFAULT_TAB_LOAD_TIMEOUT_MS);
  if (opts.settleMs) await sleep(opts.settleMs);
  return { tabId };
}

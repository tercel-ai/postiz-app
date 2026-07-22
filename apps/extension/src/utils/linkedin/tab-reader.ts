// Read LinkedIn the same way the poster writes it: open a real (background)
// linkedin.com tab and let LinkedIn's OWN web app render the page, then scrape
// the rendered DOM via chrome.scripting.executeScript. LinkedIn has no stable
// public API and aggressively flags automation, so — like the X reader — we
// drive a real tab with the user's session instead of replaying Voyager calls
// from the worker.
//
// linkedin.com host permission is already granted via the LinkedinProvider entry
// in provider.list.ts (vite.config.base.ts derives host_permissions from it).

import {
  detectLinkedinAuthWall,
  extractLinkedinPosts,
  extractLinkedinPostMetrics,
  ScrapedPostsPayload,
  ScrapedPostMetrics,
} from './page-scripts';

const TAB_LOAD_TIMEOUT_MS = 20_000;
// LinkedIn hydrates the feed client-side after load; give it a beat before the
// first scrape so cards are present.
const RENDER_SETTLE_MS = 2_500;

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

async function closeTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    console.warn('[aisee][linkedin] closeTab failed', e);
  }
}

async function runInPage<T>(tabId: number, func: () => T): Promise<T | null> {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func });
    return (res?.result as T) ?? null;
  } catch (e) {
    console.warn('[aisee][linkedin] executeScript failed', e);
    return null;
  }
}

async function scrollPage(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
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
    console.warn('[aisee][linkedin] scroll failed', e);
  }
}

export interface LinkedinReadResult {
  /** Merged, de-duplicated post rows scraped across all pages. */
  payload: ScrapedPostsPayload | null;
  /** True when the page was a login / auth-wall (user not signed in). */
  authWall: boolean;
  /** True when the tab could not be opened at all. */
  tabError: boolean;
}

/**
 * Open a background linkedin.com tab at `url`, scrape posts, optionally scroll
 * for `maxPages` extra loads, then close. De-dupes rows by urn/url across pages.
 * `pageDelayMs` spaces the scroll-driven loads (human-like); the caller owns the
 * hourly budget gate (LinkedIn scan is OFF by default — see flags.ts).
 */
export async function readLinkedinPosts(
  url: string,
  opts: { maxPages?: number; pageDelayMs?: number } = {}
): Promise<LinkedinReadResult> {
  const maxPages = Math.max(1, Math.floor(opts.maxPages || 1));
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id ?? undefined;
  } catch (e) {
    console.warn('[aisee][linkedin] tabs.create failed', e);
    return { payload: null, authWall: false, tabError: true };
  }
  if (tabId == null) return { payload: null, authWall: false, tabError: true };
  const id = tabId;

  try {
    await waitForTabComplete(id, TAB_LOAD_TIMEOUT_MS);
    await sleep(RENDER_SETTLE_MS);

    if (await runInPage(id, detectLinkedinAuthWall)) {
      return { payload: null, authWall: true, tabError: false };
    }

    const merged = new Map<string, ScrapedPostsPayload['rows'][number]>();
    let lastPayload: ScrapedPostsPayload | null = null;
    for (let page = 0; page < maxPages; page++) {
      if (page > 0) {
        await scrollPage(id);
        await sleep(Math.max(600, opts.pageDelayMs || 900));
      }
      const payload = await runInPage(id, extractLinkedinPosts);
      if (!payload) break;
      lastPayload = payload;
      for (const row of payload.rows) {
        const key = row.urn || row.url || `${row.author}::${row.raw_text.slice(0, 80)}`;
        if (!merged.has(key)) merged.set(key, row);
      }
      // A page that added nothing new means we've hit the end of what LinkedIn
      // will lazily render — stop paginating.
      if (page > 0 && payload.rows.length === 0) break;
    }

    if (!lastPayload) return { payload: null, authWall: false, tabError: false };
    return {
      payload: {
        rows: Array.from(merged.values()),
        url: lastPayload.url,
        title: lastPayload.title,
      },
      authWall: false,
      tabError: false,
    };
  } finally {
    await closeTab(id);
  }
}

/**
 * Open a background tab at a single post URL, scrape its engagement counters,
 * close. Returns null on auth-wall / not-found / tab error.
 */
export async function readLinkedinPostMetrics(
  url: string
): Promise<ScrapedPostMetrics | null> {
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id ?? undefined;
  } catch (e) {
    console.warn('[aisee][linkedin] metrics tabs.create failed', e);
    return null;
  }
  if (tabId == null) return null;
  const id = tabId;
  try {
    await waitForTabComplete(id, TAB_LOAD_TIMEOUT_MS);
    await sleep(RENDER_SETTLE_MS);
    if (await runInPage(id, detectLinkedinAuthWall)) return null;
    const metrics = await runInPage(id, extractLinkedinPostMetrics);
    return metrics?.found ? metrics : null;
  } finally {
    await closeTab(id);
  }
}

// In-browser Hacker News publishing. HN has NO write API, so the extension
// drives news.ycombinator.com in a real tab with the user's OWN session and
// submits through HN's own server-rendered forms (the fnid/fnop hidden tokens
// are filled and signed by HN itself — we only populate the visible fields and
// click HN's own submit button). This mirrors the X/LinkedIn tab pattern; HN's
// forms are plain server-rendered HTML, so the selectors are far more stable
// than an SPA's.
//
//   story   → /submit  (title + text; HN redirects away on success, then we
//                        resolve the new item id from /submitted?id=<user>)
//   comment → /item?id=<id>  (the top-level comment box; follow-up thread
//                        segments comment on the STORY, staying anchored to it)

import { ReplyResult } from '@gitroom/extension/utils/reply.types';
import {
  closeTab,
  focusTab,
  getTabUrl,
  openTab,
  runInPage,
  sleep,
  waitForTabComplete,
} from '@gitroom/extension/utils/tab-automation';

const HN_BASE = 'https://news.ycombinator.com';
const RENDER_SETTLE_MS = 800;

export interface HackernewsStoryInput {
  title: string;
  /** Text body of the submission (segment[0].text). */
  text: string;
}

export interface HackernewsCommentInput {
  /** URL of the item to comment on (news.ycombinator.com/item?id=<id>). */
  url: string;
  text: string;
}

/** Parse the numeric item id out of an HN item URL. */
export function parseHackernewsId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(String(url || '').trim());
  } catch {
    return null;
  }
  if (!/(^|\.)ycombinator\.com$/i.test(u.hostname)) return null;
  const id = u.searchParams.get('id');
  return id && /^\d+$/.test(id) ? id : null;
}

// ── In-page injected functions (self-contained — no outer-scope refs) ─────────

/** True when the page is HN's login form (user not signed in). */
function hnDetectLogin(): boolean {
  return !!document.querySelector('input[name="acct"]');
}

/** Read the logged-in username from HN's top bar (`user?id=<name>` link). */
function hnReadUsername(): string | null {
  const link = document.querySelector<HTMLAnchorElement>(
    'span.pagetop a[href^="user?id="]'
  );
  const href = link?.getAttribute('href') || '';
  const m = href.match(/user\?id=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Fill HN's /submit form (title + text) and click HN's own submit button. */
function hnFillSubmit(
  title: string,
  text: string
): 'submitted' | 'no_form' | 'login' {
  if (document.querySelector('input[name="acct"]')) return 'login';
  const titleInput = document.querySelector<HTMLInputElement>(
    'input[name="title"]'
  );
  const textArea = document.querySelector<HTMLTextAreaElement>(
    'textarea[name="text"]'
  );
  const submit =
    document.querySelector<HTMLInputElement>('input[type="submit"]') ??
    document.querySelector<HTMLInputElement>('button[type="submit"]');
  if (!titleInput || !submit) return 'no_form';

  titleInput.value = title;
  titleInput.dispatchEvent(new Event('input', { bubbles: true }));
  if (textArea) {
    textArea.value = text;
    textArea.dispatchEvent(new Event('input', { bubbles: true }));
  }
  submit.click();
  return 'submitted';
}

/** Fill the top-level comment box on an item page and submit. */
function hnFillComment(text: string): 'submitted' | 'no_form' | 'login' {
  if (document.querySelector('input[name="acct"]')) return 'login';
  const textArea = document.querySelector<HTMLTextAreaElement>(
    'textarea[name="text"]'
  );
  if (!textArea) return 'no_form';
  const form = textArea.closest('form');
  const submit =
    form?.querySelector<HTMLInputElement>('input[type="submit"]') ??
    form?.querySelector<HTMLButtonElement>('button[type="submit"]') ??
    document.querySelector<HTMLInputElement>('input[type="submit"]');
  if (!submit) return 'no_form';

  textArea.value = text;
  textArea.dispatchEvent(new Event('input', { bubbles: true }));
  submit.click();
  return 'submitted';
}

/**
 * On /submitted?id=<user>, find the id of the row whose title matches the just-
 * posted title (fall back to the newest row). HN rows are `.athing` with a
 * `.titleline > a` headline and the row id === the item id.
 */
function hnFindSubmittedId(title: string): string | null {
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>('tr.athing[id]')
  );
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const target = norm(title);
  for (const row of rows) {
    const link =
      row.querySelector('.titleline > a') ||
      row.querySelector('a.storylink') ||
      row.querySelector('.title a');
    const t = norm(link?.textContent || '');
    if (t && t === target) return row.id;
  }
  // Newest submission is the first row — a reasonable fallback if the title was
  // trimmed/edited by HN and no exact match was found.
  return rows[0]?.id ?? null;
}

// ── Orchestration ─────────────────────────────────────────────────────────────

/**
 * Resolve the freshly-submitted story's item id by opening the user's
 * /submitted page and matching the title. Best-effort — a null id just means
 * the post is live but its permalink couldn't be confirmed (the queue treats a
 * missing permalink on the last segment as OK).
 */
async function resolveSubmittedPermalink(
  tabId: number,
  username: string,
  title: string
): Promise<{ permalink?: string; postId?: string }> {
  try {
    await chrome.tabs.update(tabId, {
      url: `${HN_BASE}/submitted?id=${encodeURIComponent(username)}`,
    });
    await waitForTabComplete(tabId);
    await sleep(RENDER_SETTLE_MS);
    const id = await runInPage(tabId, hnFindSubmittedId, [title]);
    if (id) {
      return { permalink: `${HN_BASE}/item?id=${id}`, postId: id };
    }
  } catch (e) {
    console.warn('[aisee][hn] resolveSubmittedPermalink failed', e);
  }
  return {};
}

/** Submit a new Hacker News story (segment 0). */
export async function submitHackernewsStory(
  input: HackernewsStoryInput
): Promise<ReplyResult> {
  const title = (input.title || '').trim();
  const text = (input.text || '').trim();
  if (!title) return { ok: false, error: 'Hacker News story needs a title' };

  const handle = await openTab(`${HN_BASE}/submit`, {
    settleMs: RENDER_SETTLE_MS,
  });
  if (!handle) return { ok: false, error: 'Failed to open Hacker News tab' };
  const { tabId } = handle;

  try {
    if (await runInPage(tabId, hnDetectLogin)) {
      await focusTab(tabId);
      return {
        ok: false,
        error: 'Not signed in to Hacker News — log in, then retry.',
      };
    }

    const username = await runInPage(tabId, hnReadUsername);
    const result = await runInPage(tabId, hnFillSubmit, [title, text]);
    if (result !== 'submitted') {
      await focusTab(tabId);
      return {
        ok: false,
        error:
          result === 'login'
            ? 'Not signed in to Hacker News — log in, then retry.'
            : 'Could not find the Hacker News submit form (HN markup may have changed). Submit manually.',
      };
    }

    // HN redirects away from /submit on success. Wait for the navigation, then
    // confirm we actually left /submit (still on /submit ⇒ validation error).
    await waitForTabComplete(tabId);
    await sleep(RENDER_SETTLE_MS);
    const landedUrl = (await getTabUrl(tabId)) || '';
    if (/\/submit(\b|$|\?)/.test(landedUrl)) {
      await focusTab(tabId);
      return {
        ok: false,
        error:
          'Hacker News rejected the submission (rate limit or validation). Check the opened tab.',
      };
    }

    const { permalink, postId }: { permalink?: string; postId?: string } =
      username
        ? await resolveSubmittedPermalink(tabId, username, title)
        : {};

    await closeTab(tabId);
    return {
      ok: true,
      message: 'Submitted to Hacker News.',
      permalink,
      postId,
      author: username ? { handle: username } : undefined,
    };
  } catch (e: any) {
    console.error('[aisee][hn] submit failed', e);
    await focusTab(tabId);
    return { ok: false, error: `Hacker News injection failed: ${e?.message || e}` };
  }
}

/**
 * Post a top-level comment on a Hacker News item (follow-up thread segments).
 * Returns the STORY permalink so the queue keeps the whole thread anchored on
 * the same submission (flat top-level comments — HN comment permalinks aren't
 * reliably recoverable from the post-submit redirect).
 */
export async function postHackernewsComment(
  input: HackernewsCommentInput
): Promise<ReplyResult> {
  const text = (input.text || '').trim();
  if (!text) return { ok: false, error: 'Comment text is empty' };
  const id = parseHackernewsId(input.url);
  if (!id) {
    return { ok: false, error: 'Could not parse a Hacker News item id from the URL' };
  }
  const itemUrl = `${HN_BASE}/item?id=${id}`;

  const handle = await openTab(itemUrl, { settleMs: RENDER_SETTLE_MS });
  if (!handle) return { ok: false, error: 'Failed to open Hacker News tab' };
  const { tabId } = handle;

  try {
    const result = await runInPage(tabId, hnFillComment, [text]);
    if (result !== 'submitted') {
      await focusTab(tabId);
      return {
        ok: false,
        error:
          result === 'login'
            ? 'Not signed in to Hacker News — log in, then retry.'
            : 'Could not find the Hacker News comment box (HN markup may have changed). Comment manually.',
      };
    }
    await waitForTabComplete(tabId);
    await sleep(RENDER_SETTLE_MS);
    await closeTab(tabId);
    // Anchor follow-ups to the story item so the whole thread stays on it.
    return { ok: true, message: 'Commented on Hacker News.', permalink: itemUrl, postId: id };
  } catch (e: any) {
    console.error('[aisee][hn] comment failed', e);
    await focusTab(tabId);
    return { ok: false, error: `Hacker News injection failed: ${e?.message || e}` };
  }
}

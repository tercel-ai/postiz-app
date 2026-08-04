// In-browser Hacker News publishing. HN has NO write API, so the extension
// drives news.ycombinator.com in a real tab with the user's OWN session and
// submits through HN's own server-rendered forms (the fnid/fnop hidden tokens
// are filled and signed by HN itself — we only populate the visible fields and
// click HN's own submit button). This mirrors the X/LinkedIn tab pattern; HN's
// forms are plain server-rendered HTML, so the selectors are far more stable
// than an SPA's.
//
//   story   → /submit  (title + text; HN redirects to /newest on success, then
//                        we resolve the new item id right on that landing page
//                        by title+byline, falling back to /submitted?id=<user>)
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

/**
 * Read the logged-in username from HN's top bar (`user?id=<name>` link).
 * NOTE: /submit renders a stripped-down header (a single `span.pagetop`
 * containing only "Submit") with NO user link, so this only works on regular
 * pages — e.g. the /newest page HN lands on after a successful submission.
 */
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
 * Detect HN's post-submit error interstitials. Leaving /submit is NOT proof of
 * success: the form POSTs to /r with a one-time fnid token, and an expired
 * fnid ("Unknown or expired link.") or rate limit ("You're submitting too
 * fast.") lands on an error page that is also outside /submit.
 */
function hnReadPageError(): string | null {
  const text = (document.body?.innerText || '').slice(0, 2000);
  const m = text.match(
    /Unknown or expired link|submitting too fast|Please slow down|Validation required|you can't submit/i
  );
  return m ? m[0] : null;
}

/**
 * On /submitted?id=<user>, find the id of the row whose title matches the
 * just-posted title. HN rows are `.athing` with a `.titleline > a` headline
 * and the row id === the item id, newest first. When no title matches (HN
 * truncates >80-char titles and sometimes rewrites them), fall back to the
 * newest row ONLY if it was submitted within the last few minutes — an old
 * first row means the story never actually landed, and returning it would
 * backfill a stale URL and mask the failure. `rows` lets the caller tell
 * "page inspected, story absent" (a real failure) from "page didn't render".
 */
function hnScanSubmittedPage(title: string): {
  id: string | null;
  rows: number;
} {
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
    if (t && t === target) return { id: row.id, rows: rows.length };
  }
  const first = rows[0];
  // `.age` title attr is "<ISO local> <UTC epoch seconds>".
  const ageAttr =
    first?.nextElementSibling?.querySelector('.age')?.getAttribute('title') ||
    '';
  const epochSec = Number(ageAttr.split(' ')[1] || '');
  if (first && epochSec && Date.now() - epochSec * 1000 < 10 * 60 * 1000) {
    return { id: first.id, rows: rows.length };
  }
  return { id: null, rows: rows.length };
}

/**
 * On the post-submit landing page (HN 302s to /newest), find the row that is
 * the just-submitted story: headline matches the submitted title AND (when the
 * username is known) the byline `a.hnuser` matches the logged-in user. Strict
 * on purpose — a wrong id here would backfill someone ELSE's story URL, which
 * is worse than no URL at all, so there is no first-row fallback.
 */
function hnFindOnLanding(title: string, username: string | null): string | null {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const target = norm(title);
  if (!target) return null;
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>('tr.athing[id]')
  );
  for (const row of rows) {
    const link =
      row.querySelector('.titleline > a') ||
      row.querySelector('a.storylink') ||
      row.querySelector('.title a');
    if (norm(link?.textContent || '') !== target) continue;
    const by =
      row.nextElementSibling?.querySelector('a.hnuser')?.textContent || '';
    if (username && by !== username) continue;
    return row.id;
  }
  return null;
}

// ── Orchestration ─────────────────────────────────────────────────────────────

/**
 * Resolve the freshly-submitted story's item id by opening the user's
 * /submitted page and matching the title. `checked` reports whether the page
 * was actually inspected: checked with no id means the story is ABSENT from
 * the user's own submitted list — a story that really posted is always its
 * newest row, so the caller must treat that as a failed submission, not a
 * merely-unconfirmed permalink.
 */
async function resolveSubmittedPermalink(
  tabId: number,
  username: string,
  title: string
): Promise<{ permalink?: string; postId?: string; checked: boolean }> {
  try {
    await chrome.tabs.update(tabId, {
      url: `${HN_BASE}/submitted?id=${encodeURIComponent(username)}`,
    });
    await waitForTabComplete(tabId);
    await sleep(RENDER_SETTLE_MS);
    const scan = await runInPage(tabId, hnScanSubmittedPage, [title]);
    if (!scan) return { checked: false };
    if (scan.id) {
      return {
        permalink: `${HN_BASE}/item?id=${scan.id}`,
        postId: scan.id,
        checked: true,
      };
    }
    return { checked: true };
  } catch (e) {
    console.warn('[aisee][hn] resolveSubmittedPermalink failed', e);
  }
  return { checked: false };
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

    // Leaving /submit is necessary but NOT sufficient: expired-fnid and
    // rate-limit interstitials also live outside /submit. Check the landing
    // page for HN's known error strings before trusting the redirect.
    const pageError = await runInPage(tabId, hnReadPageError);
    if (pageError) {
      await focusTab(tabId);
      return {
        ok: false,
        error: `Hacker News rejected the submission ("${pageError}"). Check the opened tab.`,
      };
    }

    // The /submit page's stripped header has no user link, so the username can
    // only be read HERE, on the landing page (normally /newest) — reading it
    // before submitting always returned null and silently skipped the whole
    // permalink resolution (the releaseURL-backfill bug).
    const username = await runInPage(tabId, hnReadUsername);

    // Cheapest resolution first: the fresh story is already on the landing
    // /newest page — match it by title + byline right there.
    let permalink: string | undefined;
    let postId: string | undefined;
    const landingId = await runInPage(tabId, hnFindOnLanding, [
      title,
      username,
    ]);
    if (landingId) {
      permalink = `${HN_BASE}/item?id=${landingId}`;
      postId = landingId;
    } else if (username) {
      // Fall back to the user's own /submitted page (newest row first).
      const resolved = await resolveSubmittedPermalink(tabId, username, title);
      permalink = resolved.permalink;
      postId = resolved.postId;
    }

    // HN success REQUIRES a resolved permalink: a story that really posted is
    // always the newest row of the user's own /submitted page, so "couldn't
    // find it" (or couldn't even read the username to look) means the send is
    // unverified. Reporting ok here is exactly what produced PUBLISHED posts
    // with no releaseURL that never appeared on the site — fail instead
    // (queue retry is manual-only, so there is no duplicate-post risk).
    if (!permalink) {
      await focusTab(tabId);
      return {
        ok: false,
        error: `Hacker News submission could not be verified — it does not appear in your submitted list (landed on ${landedUrl}${
          username ? '' : ', username unreadable'
        }). Check the opened tab and retry.`,
      };
    }

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

// Browser-assisted Reddit self-post submission (captcha fallback for
// submitRedditPost). The direct /api/submit path returns BAD_CAPTCHA for
// accounts/subreddits Reddit gates behind a captcha — which the API can't
// solve. This module instead drives Reddit's OWN submit page in a real tab, the
// same tab+executeScript pattern as x.poster / linkedin.poster:
//
//   - open old.reddit.com/r/<sub>/submit prefilled (server-rendered form is far
//     more scriptable than shreddit's shadow DOM),
//   - fill title + selftext,
//   - if the form shows a captcha (Reddit only renders it when required), DON'T
//     auto-submit — surface the tab so the user solves it and clicks Post
//     (returned as `pending`, mirroring X's manual-finish contract),
//   - otherwise click Reddit's own submit button and confirm success by the
//     redirect to the new post's /comments/ permalink.
//
// old.reddit.com is covered by the `https://*.reddit.com/*` host permission, so
// executeScript is allowed with no manifest change.

import { ReplyResult } from '@gitroom/extension/utils/reply.types';
import type { RedditSubmitInput } from '@gitroom/extension/utils/reddit.poster';

const OLD_REDDIT_BASE = 'https://old.reddit.com';
const WWW_REDDIT_BASE = 'https://www.reddit.com';
const TAB_LOAD_TIMEOUT_MS = 20_000;
const TAB_CLOSE_GRACE_MS = 1_500;
// Give Reddit's JS a beat to render the (script-injected) reCAPTCHA widget
// before we decide whether a captcha is required.
const CAPTCHA_SETTLE_MS = 1_000;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Normalize a subreddit to its bare name (no `r/`, no slashes). */
function normalizeSubreddit(subreddit: string): string {
  return subreddit
    .trim()
    .replace(/^\/?(r\/)?/i, '')
    .replace(/\/$/, '');
}

/**
 * Build the prefilled old-reddit self-post submit URL. `selftext=true` selects
 * the text tab; `title` + `text` prefill the fields (belt-and-suspenders — the
 * in-page fill also sets them in case Reddit ignores the params). Exported for
 * tests.
 */
export function buildRedditSubmitUrl(
  subreddit: string,
  title: string,
  text: string
): string {
  const sr = normalizeSubreddit(subreddit);
  const params = new URLSearchParams({ selftext: 'true' });
  if (title) params.set('title', title);
  if (text) params.set('text', text);
  return `${OLD_REDDIT_BASE}/r/${sr}/submit?${params.toString()}`;
}

/**
 * If a landed URL is a submitted-post permalink (…/r/<sub>/comments/<id>/…),
 * return the canonical www permalink + t3_ fullname; otherwise null (still on
 * the submit form / an error page). Exported for tests.
 */
export function redditPermalinkFromSubmittedUrl(
  url: string
): { permalink: string; postId?: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/\.reddit\.com$/i.test(parsed.hostname)) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const ci = parts.indexOf('comments');
  if (ci === -1) return null;
  const id = parts[ci + 1];
  if (!id || !/^[a-z0-9]+$/i.test(id)) return null;
  return {
    permalink: `${WWW_REDDIT_BASE}${parsed.pathname}`,
    postId: `t3_${id}`,
  };
}

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

async function focusTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch (e) {
    console.warn('[aisee][reddit] focusTab failed', e);
  }
}

async function closeTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    console.warn('[aisee][reddit] closeTab failed', e);
  }
}

/**
 * Runs INSIDE the old.reddit submit page (serialized by executeScript — must be
 * fully self-contained, no outer-scope references). Fills the title + selftext
 * and reports whether Reddit is showing a captcha. Returns 'no_form' if the
 * expected fields are absent (DOM changed).
 */
function fillRedditSubmitInPage(
  title: string,
  text: string
): { status: 'filled' | 'no_form'; captcha: boolean } {
  const setValue = (el: Element | null, value: string): boolean => {
    if (!el) return false;
    const input = el as HTMLInputElement | HTMLTextAreaElement;
    const proto =
      input.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const isVisible = (el: Element | null): boolean =>
    !!el && (el as HTMLElement).offsetParent !== null;

  const titleEl = document.querySelector(
    'textarea[name="title"], #title-field textarea, input[name="title"]'
  );
  const bodyEl = document.querySelector(
    'textarea[name="text"], #text-field textarea'
  );
  if (!setValue(titleEl, title)) return { status: 'no_form', captcha: false };
  if (text) setValue(bodyEl, text);

  // Reddit server-renders `.captcha` / a `.g-recaptcha[data-sitekey]` container
  // only when the account/subreddit requires one — its presence (and visibility)
  // is the "needs manual" signal.
  const captchaEl = document.querySelector(
    '.captcha, .g-recaptcha[data-sitekey]'
  );
  return { status: 'filled', captcha: isVisible(captchaEl) };
}

/** Click Reddit's own submit button. Returns 'clicked' | 'no_button'. */
function clickRedditSubmitInPage(): 'clicked' | 'no_button' {
  const form = document.querySelector('#newlink') || document;
  const btn = form.querySelector(
    'button[type="submit"], button.btn[type="submit"], button[name="submit"], .save-button button'
  ) as HTMLButtonElement | null;
  if (!btn) return 'no_button';
  btn.click();
  return 'clicked';
}

/**
 * After the submit click, read where the page landed: the redirect URL, any
 * visible form error, and whether a captcha is now being demanded (Reddit can
 * reload the form with a captcha instead of erroring inline).
 */
function readRedditLandingInPage(): {
  url: string;
  error: string;
  captcha: boolean;
} {
  const isVisible = (el: Element | null): boolean =>
    !!el && (el as HTMLElement).offsetParent !== null;
  const errEl = Array.from(
    document.querySelectorAll('.error, .status .error, .c-form-control-feedback')
  ).find((el) => isVisible(el) && (el.textContent || '').trim());
  const captchaEl = document.querySelector(
    '.captcha, .g-recaptcha[data-sitekey]'
  );
  return {
    url: location.href,
    error: errEl ? (errEl.textContent || '').trim() : '',
    captcha: isVisible(captchaEl),
  };
}

/**
 * Submit a NEW self post by driving Reddit's own submit page. `input.text` is
 * the final selftext (image assets already uploaded + inlined by the caller).
 */
export async function submitRedditPostViaTab(
  input: RedditSubmitInput
): Promise<ReplyResult> {
  const subreddit = normalizeSubreddit(input.subreddit || '');
  const title = (input.title || '').trim();
  const text = (input.text || '').trim();
  if (!subreddit) return { ok: false, error: 'Subreddit is missing' };
  if (!title) return { ok: false, error: 'Post title is empty' };

  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({
      url: buildRedditSubmitUrl(subreddit, title, text),
      active: false,
    });
    tabId = tab.id ?? undefined;
  } catch (e: any) {
    return {
      ok: false,
      error: `Failed to open the Reddit submit tab: ${e?.message || e}`,
    };
  }
  if (tabId == null) return { ok: false, error: 'Failed to open Reddit tab' };

  const manual = (message: string): ReplyResult => {
    if (tabId != null) void focusTab(tabId);
    return { ok: true, pending: true, message };
  };

  try {
    await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
    await wait(CAPTCHA_SETTLE_MS);

    const [filled] = await chrome.scripting.executeScript({
      target: { tabId },
      func: fillRedditSubmitInPage,
      args: [title, text],
    });
    const fill = filled?.result;
    if (!fill || fill.status === 'no_form') {
      return manual(
        'Opened the Reddit submit page but could not find the form — review and post it manually in the opened tab.'
      );
    }
    if (fill.captcha) {
      return manual(
        'Reddit requires a captcha for this post. Solve it and click Post in the opened tab.'
      );
    }

    const [clicked] = await chrome.scripting.executeScript({
      target: { tabId },
      func: clickRedditSubmitInPage,
    });
    if (clicked?.result === 'no_button') {
      return manual(
        'Filled the Reddit post but could not find the submit button — click Post in the opened tab.'
      );
    }

    // Success on old reddit is a redirect to the new post's /comments/ page.
    await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
    const [landed] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readRedditLandingInPage,
    });
    const outcome = landed?.result;

    const permalink = outcome
      ? redditPermalinkFromSubmittedUrl(outcome.url)
      : null;
    if (permalink) {
      await wait(TAB_CLOSE_GRACE_MS);
      await closeTab(tabId);
      return {
        ok: true,
        permalink: permalink.permalink,
        postId: permalink.postId,
        message: 'Post submitted to Reddit.',
      };
    }

    // Still on the form: a captcha appeared post-click → manual; a plain error →
    // fail with its text; anything else → we can't confirm, hand it to the user.
    if (outcome?.captcha) {
      return manual(
        'Reddit is asking for a captcha. Solve it and click Post in the opened tab.'
      );
    }
    if (outcome?.error) {
      void focusTab(tabId);
      return { ok: false, error: `Reddit rejected the post: ${outcome.error}` };
    }
    return manual(
      'Submitted on Reddit but the result could not be confirmed — check the opened tab.'
    );
  } catch (e: any) {
    if (tabId != null) void focusTab(tabId);
    return { ok: false, error: `Reddit submit via tab failed: ${e?.message || e}` };
  }
}

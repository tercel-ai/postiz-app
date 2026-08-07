// Browser-assisted Reddit self-post submission (fallback for submitRedditPost).
// The direct /api/submit path can't satisfy two classes of subreddit gate on its
// own: a captcha (BAD_CAPTCHA), and a posting RULE that needs a choice from the
// subreddit's own option set — a required post flair
// (SUBMIT_VALIDATION_FLAIR_REQUIRED) or a required title tag
// (POST_GUIDANCE_VALIDATION_FAILED). This module instead drives Reddit's OWN
// submit page in a real tab, where the flair picker, the rule text and the
// captcha all render natively, using the same tab+executeScript pattern as
// x.poster / linkedin.poster:
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
// How long to keep watching the surfaced tab for the user to solve the captcha
// and click Reddit's own Post. Kept under the page bridge's 5-min idle window so
// a slow-but-successful manual post still lands as a progress push. The user
// closing the tab ends the wait early.
const MANUAL_SUBMIT_TIMEOUT_MS = 4 * 60 * 1000;

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

/**
 * True when a submit-form error is one the user can FIX right there in the open
 * form — a missing post flair or a missing required title tag. Those get the tab
 * surfaced and watched (the flair picker and rule text are right on the page)
 * instead of an immediate failure. A hard rejection (banned, subreddit gone,
 * rate limited) is NOT fixable in the form and must still fail fast rather than
 * park an unattended tab for minutes. Exported for tests.
 */
export function isRedditFixableFormError(error: string): boolean {
  return /flair|required tag|post guidance/i.test(error);
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
 * After the submit tab has been surfaced for a manual captcha solve, watch it
 * until the user clicks Reddit's own Post — success is the tab navigating to the
 * new post's /comments/ permalink. Resolves 'closed' if the user closes the tab
 * first, 'timeout' after the window elapses. This is what turns a manual finish
 * into a confirmed publish instead of a stuck 'failed'.
 */
function waitForManualRedditSubmit(
  tabId: number,
  timeoutMs: number
): Promise<
  | { done: 'submitted'; permalink: string; postId?: string }
  | { done: 'closed' }
  | { done: 'timeout' }
> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      r:
        | { done: 'submitted'; permalink: string; postId?: string }
        | { done: 'closed' }
        | { done: 'timeout' }
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ done: 'timeout' }), timeoutMs);
    const onUpdated = (
      updatedTabId: number,
      info: chrome.tabs.TabChangeInfo
    ) => {
      if (updatedTabId !== tabId || !info.url) return;
      const pl = redditPermalinkFromSubmittedUrl(info.url);
      if (pl)
        finish({ done: 'submitted', permalink: pl.permalink, postId: pl.postId });
    };
    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) finish({ done: 'closed' });
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
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

/**
 * Runs INSIDE the old.reddit submit page (serialized by executeScript — must be
 * fully self-contained, no outer-scope references). Applies the post flair whose
 * visible text matches `label`.
 *
 * The options only exist HERE: `.flairselector` is empty until the select button
 * is clicked, which AJAX-loads the subreddit's real flairs (verified on
 * r/MachineLearning — the container ships as an empty
 * `div.flairselector.drop-choices`). That is precisely why the label travels as
 * text rather than a flair id: this is the first point in the pipeline that can
 * see what the ids even are.
 *
 * Applies ONLY on exactly one case-insensitive whole-text match. Zero matches or
 * an ambiguous several both return 'no_match' and change nothing — a generated
 * label is a guess, and silently filing a post under the nearest-looking flair
 * on a live public subreddit is worse than leaving the picker to the user, who
 * is being shown this tab anyway.
 */
async function selectRedditFlairInPage(
  label: string
): Promise<{ status: 'applied' | 'skipped' | 'no_selector' | 'no_options' | 'no_match'; matched?: string; available?: string[] }> {
  const norm = (s: string | null | undefined): string =>
    (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const want = norm(label);
  if (!want) return { status: 'skipped' };

  const trigger = document.querySelector(
    'button.flairselect-btn'
  ) as HTMLButtonElement | null;
  if (!trigger) return { status: 'no_selector' };

  const pane = () => document.querySelector('.flairselector');
  if (!pane()?.children.length) {
    trigger.click();
    for (let i = 0; i < 40 && !pane()?.children.length; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const box = pane();
  if (!box || !box.children.length) return { status: 'no_options' };

  const applyBtn = Array.from(
    box.querySelectorAll('button, input[type="submit"]')
  ).find((b) =>
    /^apply$/i.test(((b as HTMLInputElement).value || b.textContent || '').trim())
  ) as HTMLElement | undefined;

  // ONE selector tier at a time: `li` and the `span.flair` inside it carry the
  // same text, so mixing tiers would make a correct label look ambiguous.
  // Reddit binds the option click on the row, so rows are tried first.
  let optionEls = Array.from(box.querySelectorAll('li'));
  if (!optionEls.length) optionEls = Array.from(box.querySelectorAll('a'));
  if (!optionEls.length) optionEls = Array.from(box.querySelectorAll('span.flair'));

  const options = optionEls
    .filter((el) => el !== applyBtn && !el.contains(applyBtn as Node))
    .map((el) => ({ el, text: norm(el.textContent) }))
    .filter((o) => o.text);

  const matches = options.filter((o) => o.text === want);
  if (matches.length !== 1) {
    return {
      status: 'no_match',
      available: Array.from(new Set(options.map((o) => o.text))).slice(0, 20),
    };
  }
  (matches[0].el as HTMLElement).click();
  if (applyBtn) applyBtn.click();
  return { status: 'applied', matched: matches[0].text };
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

  const success = async (pl: {
    permalink: string;
    postId?: string;
  }): Promise<ReplyResult> => {
    if (tabId != null) {
      await wait(TAB_CLOSE_GRACE_MS);
      await closeTab(tabId);
    }
    return {
      ok: true,
      permalink: pl.permalink,
      postId: pl.postId,
      message: 'Post submitted to Reddit.',
    };
  };

  // Surface the tab and keep watching it: if the user solves the captcha and
  // clicks Reddit's own Post, the tab navigates to the /comments/ permalink and
  // we return a confirmed publish. Only a closed tab / timeout falls back to
  // pending (which the queue records as an unfinished task).
  const waitManual = async (message: string): Promise<ReplyResult> => {
    if (tabId == null) return { ok: true, pending: true, message };
    await focusTab(tabId);
    const outcome = await waitForManualRedditSubmit(
      tabId,
      MANUAL_SUBMIT_TIMEOUT_MS
    );
    if (outcome.done === 'submitted') {
      return success({ permalink: outcome.permalink, postId: outcome.postId });
    }
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
      return waitManual(
        'Opened the Reddit submit page but could not find the form — review and post it manually in the opened tab.'
      );
    }
    // Apply the generated flair BEFORE the captcha check: even when the post
    // ends up needing a manual finish, having the flair already selected is one
    // less thing for the user to get right.
    if (input.flairLabel) {
      try {
        const [flaired] = await chrome.scripting.executeScript({
          target: { tabId },
          func: selectRedditFlairInPage,
          args: [input.flairLabel],
        });
        console.log('[aisee][reddit] flair selection', {
          subreddit,
          wanted: input.flairLabel,
          ...(flaired?.result || {}),
        });
      } catch (e) {
        // Never fatal: an unflaired submit is rejected by Reddit and routed to
        // the manual path below, which is the same place a failed match lands.
        console.warn('[aisee][reddit] flair selection threw', e);
      }
    }

    if (fill.captcha) {
      return waitManual(
        'Reddit requires a captcha for this post. Solve it and click Post in the opened tab.'
      );
    }

    const [clicked] = await chrome.scripting.executeScript({
      target: { tabId },
      func: clickRedditSubmitInPage,
    });
    if (clicked?.result === 'no_button') {
      return waitManual(
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
      return success(permalink);
    }

    // Still on the form: a captcha appeared post-click → wait for the manual
    // solve; a plain error → fail with its text; anything else → we can't
    // confirm, so hand it to the user and keep watching.
    if (outcome?.captcha) {
      return waitManual(
        'Reddit is asking for a captcha. Solve it and click Post in the opened tab.'
      );
    }
    if (outcome?.error) {
      // A missing flair / title tag is fixable in the very form that is open:
      // surface it and keep watching, so the user's Post click still lands as a
      // confirmed publish rather than an error the queue has to retry blind.
      if (isRedditFixableFormError(outcome.error)) {
        return waitManual(
          `Reddit needs one more thing for r/${subreddit}: ${outcome.error} ` +
            'Set it in the opened tab and click Post.'
        );
      }
      void focusTab(tabId);
      return { ok: false, error: `Reddit rejected the post: ${outcome.error}` };
    }
    return waitManual(
      'Submitted on Reddit but the result could not be confirmed — check the opened tab.'
    );
  } catch (e: any) {
    if (tabId != null) void focusTab(tabId);
    return { ok: false, error: `Reddit submit via tab failed: ${e?.message || e}` };
  }
}

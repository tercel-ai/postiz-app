// Browser-assisted Reddit self-post submission (fallback for submitRedditPost).
// The direct /api/submit path can't satisfy two classes of subreddit gate on its
// own: a captcha (BAD_CAPTCHA), and a posting RULE that needs a choice from the
// subreddit's own option set — a required post flair
// (SUBMIT_VALIDATION_FLAIR_REQUIRED) or a required title tag
// (POST_GUIDANCE_VALIDATION_FAILED). This module hands off to Reddit's OWN
// submit page in a real tab, where the flair picker, the rule text and the
// captcha all render natively — using www.reddit.com (shreddit), NOT
// old.reddit.com.
//
//   - open www.reddit.com/r/<sub>/submit/ prefilled via URL (title/text),
//   - best-effort pre-select the generated flair label, VERIFIED to have
//     actually committed (not just clicked — see selectRedditFlairInPage),
//   - attempt a fully unattended publish ONLY when nothing is left unconfirmed
//     (no flair was proposed, or the one proposed was confirmed) — Reddit's
//     own Post button additionally self-guards, reporting 'disabled' rather
//     than doing anything when a captcha, a karma/age gate, or any other rule
//     this module doesn't know about is still unmet,
//   - verify an attempted auto-click actually worked within a short window —
//     anything slower falls through to the same full manual hand-off an
//     unconfirmed flair or a disabled button gets, never a silent guess at
//     success,
//   - confirm success — and RECOVER THE PERMALINK, which the backend needs as
//     releaseURL — by polling the signed-in user's own submissions for a
//     matching title, with the tab's URL only as a fast path. shreddit does
//     NOT reliably land on the new post: verified on r/football, where a
//     successful submit navigated to the SUBREDDIT FEED (/r/football/) and
//     opened a "Repost" modal, never exposing the permalink in the URL at all.
//     Watching only for a /comments/ redirect (which is what old.reddit did)
//     would therefore report a live post as failed — and a failed post is
//     retried, which double-posts.
//
// www.reddit.com is covered by the `https://*.reddit.com/*` host permission,
// so executeScript is allowed with no manifest change.
//
// Migrated off old.reddit.com (2026-08): its server-rendered form was easier to
// script but silently rejects posting-rule violations with no on-page signal,
// which is exactly the failure this module exists to catch. shreddit's Shadow
// DOM is harder to drive — verified empirically: (1) URL params fill title/text
// but do NOT prime whatever internal state the flair "Add" button reads before
// enabling Post, so this module still leaves that button to the user; (2) the
// flair radio's internal state only updates on a full pointer/mouse event
// sequence, not a bare `.click()` — see `realClick` below.

import { ReplyResult } from '@gitroom/extension/utils/reply.types';
import type { RedditSubmitInput } from '@gitroom/extension/utils/reddit.poster';

const WWW_REDDIT_BASE = 'https://www.reddit.com';
const TAB_LOAD_TIMEOUT_MS = 20_000;
const TAB_CLOSE_GRACE_MS = 1_500;
// How long to keep watching the surfaced tab for the user to review and click
// Reddit's own Post. Kept under the page bridge's 5-min idle window so a
// slow-but-successful manual post still lands as a progress push. The user
// closing the tab ends the wait early.
const MANUAL_SUBMIT_TIMEOUT_MS = 4 * 60 * 1000;
// How long to wait for a redirect after an AUTO Post click before treating it
// as unconfirmed and falling back to the full manual hand-off. A real success
// redirects within a couple of seconds; this is generous headroom, not an
// estimate of normal latency — its job is to bound how long a click that
// silently did nothing (captcha appeared, hidden rule, slow mod hold) delays
// surfacing the tab to a human.
const AUTO_SUBMIT_CONFIRM_MS = 15_000;
// How often to re-check the user's own submissions while waiting for a publish
// to confirm. Hits Reddit with the user's own session on their own listing, so
// it is cheap — but the manual window is minutes long, so don't spin.
const PUBLISH_POLL_INTERVAL_MS = 3_000;
// Only submissions newer than (start of this attempt - this slack) can be
// "the post we just made". Absorbs clock skew between this machine and
// Reddit's created_utc without reaching so far back that an unrelated older
// post with the same title could be mistaken for ours.
const SUBMISSION_LOOKBACK_SLACK_S = 60;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Normalize a subreddit to its bare name (no `r/`, no slashes). */
function normalizeSubreddit(subreddit: string): string {
  return subreddit
    .trim()
    .replace(/^\/?(r\/)?/i, '')
    .replace(/\/$/, '');
}

/**
 * Build the prefilled reddit.com self-post submit URL. `type=TEXT` selects the
 * text post kind; `title` + `text` prefill the fields — verified to hydrate
 * correctly (including the Lexical body editor) on a hard navigation straight
 * to this URL, no "+Create" soft-nav required. Exported for tests.
 */
export function buildRedditSubmitUrl(
  subreddit: string,
  title: string,
  text: string
): string {
  const sr = normalizeSubreddit(subreddit);
  const params = new URLSearchParams({ type: 'TEXT' });
  if (title) params.set('title', title);
  if (text) params.set('text', text);
  return `${WWW_REDDIT_BASE}/r/${sr}/submit/?${params.toString()}`;
}

/**
 * If a landed URL is a submitted-post permalink (…/r/<sub>/comments/<id>/…),
 * return the canonical www permalink + t3_ fullname; otherwise null (still on
 * the submit form / an error page). Format is identical between old.reddit and
 * shreddit, so this needs no UI-version branch. Exported for tests.
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

/** Collapse whitespace + case so a Reddit-echoed title compares equal. */
function normalizeTitle(s: string | null | undefined): string {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Bare username of the Reddit account signed in to THIS browser, or '' when
 * signed out / unreachable. Read straight from the worker with the browser's
 * own cookies — the same mechanism reddit.poster uses. Deliberately does NOT
 * import reddit.poster's cached getRedditSession: that module imports this one,
 * so a value import would close a runtime cycle.
 */
async function fetchRedditUsername(): Promise<string> {
  try {
    const res = await fetch(`${WWW_REDDIT_BASE}/api/me.json`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    const json = await res.json().catch(() => ({}));
    return json?.data?.name || '';
  } catch {
    return '';
  }
}

/**
 * Find a just-published post by title among the signed-in user's own
 * submissions. THIS is how the permalink is recovered — shreddit frequently
 * never puts it in the tab's URL (see this file's header), and the backend
 * needs it as releaseURL.
 *
 * `sinceEpochS` guards against matching an older post that happens to share
 * the title: only submissions at least that new can be the one we just made.
 * Never throws — a transport failure is indistinguishable from "not yet
 * visible", and both mean "keep waiting". Exported for tests.
 */
export async function findSubmittedPostByTitle(
  username: string,
  title: string,
  sinceEpochS: number
): Promise<{ permalink: string; postId?: string } | null> {
  if (!username) return null;
  try {
    const res = await fetch(
      `${WWW_REDDIT_BASE}/user/${encodeURIComponent(username)}/submitted.json?limit=10&sort=new`,
      { credentials: 'include', headers: { Accept: 'application/json' } }
    );
    const json = await res.json().catch(() => null);
    const children = json?.data?.children;
    if (!Array.isArray(children)) return null;
    const want = normalizeTitle(title);
    for (const child of children) {
      const d = child?.data;
      if (!d || typeof d.created_utc !== 'number' || d.created_utc < sinceEpochS) continue;
      if (normalizeTitle(d.title) !== want) continue;
      if (typeof d.permalink !== 'string' || !d.permalink) continue;
      return {
        permalink: `${WWW_REDDIT_BASE}${d.permalink}`,
        postId: typeof d.name === 'string' ? d.name : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

type PublishOutcome =
  | { done: 'submitted'; permalink: string; postId?: string }
  | { done: 'closed' }
  | { done: 'timeout' };

interface ConfirmationWatch {
  result: Promise<PublishOutcome>;
  /** Stop watching and release the tab listeners (nothing was clicked). */
  cancel: () => void;
}

/**
 * Watch for this post going live, by BOTH routes at once:
 *   - the tab navigating to a /comments/ permalink (fast path; what old.reddit
 *     always did and shreddit sometimes does), and
 *   - polling the user's own submissions for the title (the reliable route —
 *     it works even when shreddit lands on the subreddit feed instead, and is
 *     the only one that can recover the permalink in that case).
 *
 * Returned as a handle rather than a bare promise so the caller can ARM it
 * BEFORE clicking Post: a redirect landing in the gap between the click
 * returning and a listener attaching would otherwise be missed. `cancel()`
 * detaches everything when the click never happened.
 *
 * A closed tab is not immediately failure — the poll runs once more first,
 * because the user may well have posted and then closed the tab.
 */
function watchForPublishConfirmation(opts: {
  tabId: number;
  username: string;
  title: string;
  sinceEpochS: number;
  timeoutMs: number;
}): ConfirmationWatch {
  const { tabId, username, title, sinceEpochS, timeoutMs } = opts;
  let settled = false;
  let closed = false;
  let finish!: (r: PublishOutcome) => void;

  const result = new Promise<PublishOutcome>((resolve) => {
    const onUpdated = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId || !info.url) return;
      const pl = redditPermalinkFromSubmittedUrl(info.url);
      if (pl) finish({ done: 'submitted', permalink: pl.permalink, postId: pl.postId });
    };
    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) closed = true;
    };
    finish = (r: PublishOutcome) => {
      if (settled) return;
      settled = true;
      try {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
      } catch {
        /* no tabs API (tests) — nothing to detach */
      }
      resolve(r);
    };
    try {
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
    } catch {
      /* no tabs API (tests) — polling below still confirms */
    }

    const deadline = Date.now() + timeoutMs;
    void (async () => {
      for (;;) {
        const found = await findSubmittedPostByTitle(username, title, sinceEpochS);
        if (settled) return;
        if (found) return finish({ done: 'submitted', ...found });
        // Checked AFTER the poll on purpose: a tab closed by a user who had
        // already posted must still resolve as submitted.
        if (closed) return finish({ done: 'closed' });
        if (Date.now() >= deadline) return finish({ done: 'timeout' });
        await wait(PUBLISH_POLL_INTERVAL_MS);
        if (settled) return;
      }
    })();
  });

  return { result, cancel: () => finish({ done: 'timeout' }) };
}

/**
 * Runs INSIDE the reddit.com submit page (serialized by executeScript — must be
 * fully self-contained, no outer-scope references). Applies the post flair
 * whose visible text matches `label`.
 *
 * shreddit renders the flair picker as a stack of custom elements behind
 * Shadow DOM, verified empirically (r/MachineLearning, r/football):
 *   - trigger button id="reddit-post-flair-button" opens the modal,
 *   - the compact list shows only a few options — a #view-all-flairs-button
 *     reveals the rest (Discussion, on both subs tested, is NOT in the compact
 *     list),
 *   - options are <faceplate-radio-input id="post-flair-radio-input-N">,
 *   - id="post-flair-modal-apply-button" ("Add") is what is SUPPOSED to copy
 *     the modal's scratch `selectedFlairId` into the real `flairId` the rest
 *     of the page reads — confirmed this copy can silently fail even with a
 *     fully genuine trusted click (reproduced 3x in a row on an account that
 *     turned out to be blocked from the subreddit entirely; never isolated
 *     whether it can fail for an eligible account too). `applied` below means
 *     that copy was OBSERVED to succeed, not merely attempted.
 *
 * A bare `element.click()` only dispatches a 'click' event — these controls
 * visually/internally react to the fuller pointer/mouse sequence a real click
 * produces, not the lone event, so `realClick` dispatches the whole sequence.
 *
 * Applies ONLY on exactly one case-insensitive whole-text match. Zero matches
 * or several both return 'no_match' and change nothing — a generated label is
 * a guess, and silently filing a post under the nearest-looking flair on a
 * live public subreddit is worse than leaving the picker to the user, who is
 * being shown this tab anyway.
 */
export async function selectRedditFlairInPage(label: string): Promise<{
  status: 'applied' | 'skipped' | 'no_selector' | 'no_options' | 'no_match' | 'not_confirmed';
  matched?: string;
  available?: string[];
}> {
  const norm = (s: string | null | undefined): string =>
    (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const want = norm(label);
  if (!want) return { status: 'skipped' };

  const findDeep = (
    node: any,
    match: (el: Element) => boolean,
    depth: number
  ): Element | null => {
    if (!node || depth > 30) return null;
    for (const el of Array.from(node.children || []) as Element[]) {
      if (match(el)) return el;
      const found =
        findDeep(el, match, depth + 1) ||
        ((el as any).shadowRoot ? findDeep((el as any).shadowRoot, match, depth + 1) : null);
      if (found) return found;
    }
    return null;
  };
  const findAllDeep = (
    node: any,
    match: (el: Element) => boolean,
    depth: number,
    acc: Element[]
  ): Element[] => {
    if (!node || depth > 30) return acc;
    for (const el of Array.from(node.children || []) as Element[]) {
      if (match(el)) acc.push(el);
      findAllDeep(el, match, depth + 1, acc);
      if ((el as any).shadowRoot) findAllDeep((el as any).shadowRoot, match, depth + 1, acc);
    }
    return acc;
  };
  const realClick = (el: Element): void => {
    const common = { bubbles: true, cancelable: true, composed: true };
    try {
      el.dispatchEvent(
        new PointerEvent('pointerdown', { ...common, pointerId: 1, isPrimary: true, button: 0 })
      );
    } catch {
      /* PointerEvent unsupported in this context — mouse events below still fire */
    }
    el.dispatchEvent(new MouseEvent('mousedown', { ...common, button: 0 }));
    try {
      el.dispatchEvent(
        new PointerEvent('pointerup', { ...common, pointerId: 1, isPrimary: true, button: 0 })
      );
    } catch {
      /* see above */
    }
    el.dispatchEvent(new MouseEvent('mouseup', { ...common, button: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...common, button: 0 }));
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const isVisible = (el: Element): boolean => (el as HTMLElement).getClientRects().length > 0;
  const textOf = (el: Element): string => norm(el.textContent);

  const trigger = findDeep(document.body, (el) => el.id === 'reddit-post-flair-button', 0);
  if (!trigger) return { status: 'no_selector' };
  realClick(trigger);

  let radios: Element[] = [];
  for (let i = 0; i < 20; i++) {
    radios = findAllDeep(
      document.body,
      (el) => el.tagName?.toLowerCase() === 'faceplate-radio-input' && /^post-flair-radio-input-/.test(el.id || ''),
      0,
      []
    );
    if (radios.length) break;
    await sleep(150);
  }
  if (!radios.length) return { status: 'no_options' };

  let match = radios.find((r) => textOf(r) === want && isVisible(r));
  if (!match) {
    // The compact view only shows a handful of flairs — expand to the full
    // list before giving up (verified: Discussion sat outside the compact
    // list on both subreddits tested).
    //
    // Re-checks the ALREADY-CAPTURED `radios`, which relies on expanding
    // toggling visibility on the same elements rather than re-rendering new
    // ones — verified on the real page (post-flair-radio-input-3 was already
    // in the DOM, zero-sized, before expanding, and kept its id after). If
    // Reddit ever switches to re-rendering, this silently stops matching, so
    // the no_match branch below stays the safe default rather than a guess.
    const viewAll = findDeep(document.body, (el) => el.id === 'view-all-flairs-button', 0);
    if (viewAll) {
      realClick(viewAll);
      for (let i = 0; i < 20 && !match; i++) {
        await sleep(150);
        match = radios.find((r) => textOf(r) === want && isVisible(r));
      }
    }
  }
  if (!match) {
    return {
      status: 'no_match',
      available: Array.from(new Set(radios.map(textOf))).filter(Boolean).slice(0, 20),
    };
  }

  realClick(match);
  await sleep(150);

  const addBtn = findDeep(document.body, (el) => el.id === 'post-flair-modal-apply-button', 0);
  if (!addBtn) return { status: 'no_selector', matched: textOf(match) };
  realClick(addBtn);
  await sleep(200);

  // Verify the selection actually COMMITTED rather than trusting the click —
  // see the doc comment above on why `flairId` (not `selectedFlairId`, which
  // is already set the moment an option is clicked) is the real signal.
  const modal = findDeep(document.body, (el) => el.tagName?.toLowerCase() === 'r-post-flairs-modal', 0) as any;
  if (modal && modal.flairId) {
    return { status: 'applied', matched: textOf(match) };
  }
  return { status: 'not_confirmed', matched: textOf(match) };
}

/**
 * Runs INSIDE the reddit.com submit page (serialized by executeScript — must
 * be fully self-contained, no outer-scope references, including no sharing
 * with selectRedditFlairInPage's copy of the same helpers). Clicks Reddit's
 * own Post button (id="inner-post-submit-button").
 *
 * Returns 'disabled' WITHOUT clicking when the button reports disabled —
 * clicking a disabled button is a no-op on shreddit either way, but reporting
 * it explicitly lets the caller skip straight to the manual hand-off instead
 * of wasting the confirm-window wait on a click that could never have done
 * anything. A captcha, an unmet karma/age gate, or any other rule this module
 * doesn't otherwise know about all surface here the same way: Reddit disables
 * its own button until they're satisfied, so this needs no separate captcha
 * detection of its own — it just respects the same disabled state a human
 * would see.
 */
export function clickRedditPostInPage(): {
  status: 'clicked' | 'disabled' | 'no_selector';
} {
  const findDeep = (
    node: any,
    match: (el: Element) => boolean,
    depth: number
  ): Element | null => {
    if (!node || depth > 30) return null;
    for (const el of Array.from(node.children || []) as Element[]) {
      if (match(el)) return el;
      const found =
        findDeep(el, match, depth + 1) ||
        ((el as any).shadowRoot ? findDeep((el as any).shadowRoot, match, depth + 1) : null);
      if (found) return found;
    }
    return null;
  };
  const realClick = (el: Element): void => {
    const common = { bubbles: true, cancelable: true, composed: true };
    try {
      el.dispatchEvent(
        new PointerEvent('pointerdown', { ...common, pointerId: 1, isPrimary: true, button: 0 })
      );
    } catch {
      /* PointerEvent unsupported in this context — mouse events below still fire */
    }
    el.dispatchEvent(new MouseEvent('mousedown', { ...common, button: 0 }));
    try {
      el.dispatchEvent(
        new PointerEvent('pointerup', { ...common, pointerId: 1, isPrimary: true, button: 0 })
      );
    } catch {
      /* see above */
    }
    el.dispatchEvent(new MouseEvent('mouseup', { ...common, button: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...common, button: 0 }));
  };

  const btn = findDeep(document.body, (el) => el.id === 'inner-post-submit-button', 0) as
    | (HTMLButtonElement & { disabled: boolean })
    | null;
  if (!btn) return { status: 'no_selector' };
  if (btn.disabled) return { status: 'disabled' };
  realClick(btn);
  return { status: 'clicked' };
}

/**
 * Open reddit.com's submit page prefilled for this post, best-effort
 * pre-select the flair, then attempt a fully unattended publish — but ONLY
 * when nothing is left unconfirmed:
 *   - no flair was proposed, or the one proposed was OBSERVED to commit
 *     (selectRedditFlairInPage's `applied`, not merely attempted), AND
 *   - Reddit's own Post button reports enabled (its own guard against a
 *     captcha, an unmet karma/age gate, or any other rule this module
 *     doesn't otherwise know about — never bypassed, never worked around).
 * An attempted click is then VERIFIED against the user's own submissions
 * within a short window, not trusted on its own. Any of these not holding —
 * unconfirmed flair, disabled button, or a click that didn't show up in time —
 * falls through to the same full manual hand-off, never a silent guess at
 * success.
 *
 * Both paths resolve through the same watcher, so a MANUAL finish recovers the
 * permalink exactly as an automatic one does — the manual path is not a
 * second-class citizen here, and it has to be: shreddit often leaves the
 * permalink out of the URL entirely (see this file's header).
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
  const openTabId = tabId;

  const finishFromOutcome = async (
    outcome: PublishOutcome,
    fallbackMessage: string
  ): Promise<ReplyResult> => {
    if (outcome.done === 'submitted') {
      await wait(TAB_CLOSE_GRACE_MS);
      await closeTab(openTabId);
      return {
        ok: true,
        permalink: outcome.permalink,
        postId: outcome.postId,
        message: 'Post submitted to Reddit.',
      };
    }
    return { ok: true, pending: true, message: fallbackMessage };
  };

  // Everything the confirmation watcher needs, captured BEFORE anything can
  // publish: `sinceEpochS` is what stops an older post with the same title
  // from being mistaken for this one.
  const username = await fetchRedditUsername();
  const sinceEpochS =
    Math.floor(Date.now() / 1000) - SUBMISSION_LOOKBACK_SLACK_S;
  const watchOpts = { tabId, username, title, sinceEpochS };
  if (!username) {
    console.warn(
      '[aisee][reddit] no signed-in Reddit user — publish confirmation falls back to the tab URL alone'
    );
  }

  try {
    await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);

    // Best-effort flair pre-selection. Never blocks or fails the hand-off — the
    // user may end up seeing this tab regardless, and Reddit's own picker
    // (with its full option list and rule text) is right there if this can't
    // confirm a match on its own.
    let flairNote = '';
    let flairConfirmed = !input.flairLabel; // nothing to confirm when none was proposed
    if (input.flairLabel) {
      try {
        const [flaired] = await chrome.scripting.executeScript({
          target: { tabId },
          func: selectRedditFlairInPage,
          args: [input.flairLabel],
        });
        const result = flaired?.result;
        console.log('[aisee][reddit] flair selection', {
          subreddit,
          wanted: input.flairLabel,
          ...(result || {}),
        });
        if (result?.status === 'applied') {
          flairNote = ` (flair "${result.matched}" pre-selected)`;
          flairConfirmed = true;
        }
      } catch (e) {
        console.warn('[aisee][reddit] flair selection threw', e);
      }
    }

    if (flairConfirmed) {
      // Armed BEFORE the click so a fast redirect can't land in the gap
      // between executeScript returning and a listener attaching.
      const watch = watchForPublishConfirmation({
        ...watchOpts,
        timeoutMs: AUTO_SUBMIT_CONFIRM_MS,
      });
      let clickResult: { status: string } | undefined;
      try {
        const [clicked] = await chrome.scripting.executeScript({
          target: { tabId },
          func: clickRedditPostInPage,
        });
        clickResult = clicked?.result;
        console.log('[aisee][reddit] auto post-click', {
          subreddit,
          ...(clickResult || {}),
        });
      } catch (e) {
        console.warn('[aisee][reddit] auto post-click threw', e);
      }

      if (clickResult?.status === 'clicked') {
        const quick = await watch.result;
        if (quick.done !== 'timeout') {
          return finishFromOutcome(
            quick,
            `Reddit submit tab for r/${subreddit} was closed before publishing could be confirmed.`
          );
        }
        // Clicked but nothing showed up within the confirm window — something
        // this module can't see (a captcha that appeared post-click, a hidden
        // rule, a slow mod hold) needs a human. Fall through to the full
        // manual wait rather than call it a failure or keep waiting silently.
      } else {
        // Nothing was clicked (disabled button, missing button, or the script
        // threw) — release the listeners rather than leave them attached.
        watch.cancel();
      }
    }

    await focusTab(tabId);
    const outcome = await watchForPublishConfirmation({
      ...watchOpts,
      timeoutMs: MANUAL_SUBMIT_TIMEOUT_MS,
    }).result;
    return finishFromOutcome(
      outcome,
      `Opened the Reddit submit page for r/${subreddit}${flairNote} — review and click Post in the opened tab.`
    );
  } catch (e: any) {
    if (tabId != null) void focusTab(tabId);
    return { ok: false, error: `Reddit submit via tab failed: ${e?.message || e}` };
  }
}

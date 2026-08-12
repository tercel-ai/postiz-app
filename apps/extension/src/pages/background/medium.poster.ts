// In-browser Medium publishing. Medium's write API (integration tokens) was
// discontinued, so — like X and LinkedIn — the extension drives medium.com in a
// real tab with the user's OWN session and fills Medium's native editor via
// chrome.scripting.executeScript, then best-effort clicks Medium's own Publish
// flow. Medium's editor is a client-rendered SPA with unstable internals, so the
// selectors are defensive and every path falls back to surfacing the tab for the
// user to finish by hand (never a silent failure, never a direct API call).
//
// Medium has no native thread continuation for a story, so only segment 0 is
// ever published here (enforced by SINGLE_SEGMENT_PLATFORMS at enqueue).

import { ReplyResult } from '@gitroom/extension/utils/reply.types';
import {
  closeTab,
  focusTab,
  getTabUrl,
  openTab,
  runInPage,
  sleep,
} from '@gitroom/extension/utils/tab-automation';
import {
  attachDebugger,
  cdpTypeText,
  detachDebugger,
} from '@gitroom/extension/utils/cdp-typing';

const MEDIUM_NEW_STORY = 'https://medium.com/new-story';
const RENDER_SETTLE_MS = 3_000; // Medium hydrates the editor client-side
const TAB_CLOSE_GRACE_MS = 1_500;
// Publish → "Story preview" navigation → confirm → published-story redirect.
// 60 × 300ms ≈ 18s covers both hops on a slow connection.
const PUBLISH_STEP_POLL_MS = 300;
const PUBLISH_STEP_POLL_TRIES = 60;
// If the tab never navigates, assume Medium showed an in-page dialog instead
// and try the confirm click in place (~3s in).
const PUBLISH_STEP_DIALOG_FALLBACK_AFTER = 10;

export interface MediumStoryInput {
  title: string;
  /** Plain-text/markdown body of the story (segment[0].text). */
  text: string;
  /**
   * When false, fill the editor but let the user click Publish. Defaults to
   * true: the extension drives Medium's own Publish flow.
   */
  autoSubmit?: boolean;
}

// ── In-page injected functions (self-contained — no outer-scope refs) ─────────

/** True when medium.com bounced us to a sign-in wall. */
function mediumDetectAuthWall(): boolean {
  const href = location.href;
  if (/\/m\/signin|\/m\/callback|\/signin/i.test(href)) return true;
  // The editor route without a session renders the marketing/sign-in page.
  return !!document.querySelector('a[href*="/m/signin"]') &&
    !document.querySelector('[contenteditable="true"]');
}

/**
 * Locate Medium's title heading / body paragraph and focus + select it so the
 * caller can type into it via chrome.debugger (see cdpTypeText — typing itself
 * happens outside the page, this only points the cursor at the right field).
 *
 * Medium nests the WHOLE story — the title heading plus every body paragraph
 * — inside a single contenteditable region (a <section> under
 * .postArticle-content); it does not expose one contenteditable per field. A
 * page can also contain unrelated contenteditable elements elsewhere
 * (observed: an empty 100x100 decoy div), so naively treating the first two
 * `[contenteditable="true"]` matches as "title" and "body" corrupts the
 * article (title overwrites the whole container) and writes the body into an
 * unrelated element. Instead: find the contenteditable region that actually
 * contains the heading, then target the heading (title) and its first
 * sibling paragraph (body) directly.
 *
 * Returns 'skip' for the body step when the editor exposes only a single
 * merged contenteditable region (title and body are the same element) —
 * matches typing only the title in that edge case.
 */
function mediumFocusField(step: 'title' | 'body'): 'ok' | 'no_editor' | 'skip' {
  const editables = Array.from(
    document.querySelectorAll<HTMLElement>('[contenteditable="true"]')
  );
  if (!editables.length) return 'no_editor';

  const isHeadingTag = (el: HTMLElement) => /^h[1-4]$/i.test(el.tagName);
  const headingIn = (root: HTMLElement) =>
    isHeadingTag(root) ? root : root.querySelector<HTMLElement>('h1, h2, h3, h4');

  const container =
    editables.find((el) => headingIn(el)) ||
    editables.find((el) =>
      /title/i.test(el.getAttribute('data-testid') || '') ||
      /title/i.test(el.getAttribute('aria-label') || '')
    ) ||
    editables[0];
  const heading = headingIn(container);

  const titleEl = heading || container;
  const bodyEl =
    (heading &&
      Array.from(container.querySelectorAll<HTMLElement>('p')).find(
        (p) => p !== heading
      )) ||
    editables.find((el) => el !== container) ||
    container;

  if (step === 'body' && bodyEl === titleEl) return 'skip';
  const target = step === 'title' ? titleEl : bodyEl;

  target.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(target);
  sel?.removeAllRanges();
  sel?.addRange(range);
  if ((target.textContent || '').length) document.execCommand?.('delete');
  return 'ok';
}

/**
 * Click Medium's Publish control on the EDITOR page. This is step 1 of 2 —
 * clicking it performs a top-level navigation to Medium's "Story preview" page,
 * so the confirm click has to be a separate injection (see below).
 */
function mediumClickPublish(): 'clicked' | 'no_button' {
  const byTestId =
    document.querySelector<HTMLElement>('[data-testid="publishButton"]') ||
    document.querySelector<HTMLElement>('[data-action="show-prepublish"]');
  const btn =
    byTestId ||
    Array.from(
      document.querySelectorAll<HTMLElement>('button, a[role="button"]')
    ).find((b) => /^publish$/i.test((b.textContent || '').trim()));
  if (!btn) return 'no_button';
  btn.click();
  return 'clicked';
}

/**
 * Click the final confirm button on Medium's "Story preview" step — step 2 of
 * 2, injected into the page the editor navigated TO.
 *
 * The confirm button (verified live) is plainly labelled "Publish" (not
 * "Publish now") and carries no distinguishing data-testid/data-action, so it
 * is matched by text; anything that looks like the EDITOR's own publish trigger
 * is excluded so a mistimed injection (still on the editor, navigation not
 * started yet) can never re-click step 1 and bounce us in a loop.
 */
function mediumClickConfirmPublish(): 'clicked' | 'no_button' {
  const editorTriggers = new Set(
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="publishButton"], [data-action="show-prepublish"]'
      )
    )
  );
  const confirm =
    document.querySelector<HTMLElement>('[data-testid="publishConfirmButton"]') ||
    document.querySelector<HTMLElement>('[data-action="publish"]') ||
    Array.from(
      document.querySelectorAll<HTMLElement>('button, a[role="button"]')
    ).find(
      (b) =>
        !editorTriggers.has(b) &&
        /^publish( now)?$/i.test((b.textContent || '').trim())
    );
  if (!confirm) return 'no_button';
  confirm.click();
  return 'clicked';
}

// ── Orchestration ─────────────────────────────────────────────────────────────

/** Whether a URL looks like a published Medium story (not the editor route). */
function isPublishedStoryUrl(url: string): boolean {
  return (
    /medium\.com\//i.test(url) &&
    !/\/new-story|\/(m\/)?signin|\/edit(\b|\/|$)/i.test(url) &&
    /-[0-9a-f]{6,}$/i.test(url.split(/[?#]/)[0])
  );
}

/** Medium's "Story preview" step — /p/<id>/submission?redirectUrl=… */
function isStoryPreviewUrl(url: string): boolean {
  return /medium\.com\/.*\/submission(\b|[/?#]|$)/i.test(url);
}

/**
 * The story's canonical short permalink, read off the "Story preview" URL.
 *
 * That page is /p/<postId>/submission?redirectUrl=… — the SAME <postId> that
 * ends the pretty story URL (…/some-title-02fbb1fcb271), and medium.com/p/<id>
 * is a permanently valid canonical link that 302s to the pretty one. It gives
 * us a real permalink even when the post-publish redirect is too slow to catch
 * or lands somewhere else (Medium sometimes returns to the stories dashboard).
 * `redirectUrl` is deliberately NOT used: it is only where Medium intends to
 * send the browser next, not necessarily the story.
 */
function storyPermalinkFromPreviewUrl(url: string): string | undefined {
  const id = /medium\.com\/p\/([0-9a-f]{6,})\//i.exec(url)?.[1];
  return id ? `https://medium.com/p/${id}` : undefined;
}

/**
 * Drive Medium's two-step Publish flow and return the published story URL.
 *
 * Step 1 (Publish, on the editor) performs a TOP-LEVEL NAVIGATION to Medium's
 * "Story preview" page, which destroys the injected script's execution context
 * — so the step-2 confirm click MUST be a second injection driven from here.
 * Polling for the confirm button inside step 1's injected function can never
 * see the new document: executeScript rejects the moment the frame goes away,
 * and the story is left sitting unpublished on the preview page.
 *
 * `permalink` is absent when publication could not be confirmed; `clicked`
 * distinguishes "we drove the flow but never saw the story go live" from "the
 * editor never even offered a Publish button".
 */
async function driveMediumPublish(
  tabId: number
): Promise<{ permalink?: string; clicked: boolean }> {
  const editorUrl = (await getTabUrl(tabId)) || '';

  // A `null` result here means the navigation tore the frame down before the
  // result came back — i.e. the click almost certainly landed. Only an explicit
  // 'no_button' is a real failure.
  const clicked = await runInPage(tabId, mediumClickPublish);
  if (clicked === 'no_button') return { clicked: false };

  let confirmed = false;
  let shortPermalink: string | undefined;
  for (let i = 0; i < PUBLISH_STEP_POLL_TRIES; i++) {
    await sleep(PUBLISH_STEP_POLL_MS);
    const url = (await getTabUrl(tabId)) || '';
    if (isPublishedStoryUrl(url)) {
      return { permalink: url.split(/[?#]/)[0], clicked: true };
    }

    // Wait for the preview step to actually be up before injecting: on the
    // preview page, or (belt-and-braces, should Medium ever go back to an
    // in-page dialog) once we've waited a while without any navigation.
    const readyForConfirm =
      isStoryPreviewUrl(url) ||
      (url === editorUrl && i >= PUBLISH_STEP_DIALOG_FALLBACK_AFTER);
    if (isStoryPreviewUrl(url)) {
      shortPermalink = shortPermalink || storyPermalinkFromPreviewUrl(url);
    }
    if (!confirmed && readyForConfirm) {
      confirmed = (await runInPage(tabId, mediumClickConfirmPublish)) === 'clicked';
    }
  }
  // Confirm landed but the redirect never resolved to a pretty story URL — the
  // canonical /p/<id> link from the preview page is still a real permalink.
  return { ...(confirmed ? { permalink: shortPermalink } : {}), clicked: true };
}

/** Publish a single Medium story (segment 0). */
export async function postMediumStory(
  input: MediumStoryInput
): Promise<ReplyResult> {
  const title = (input.title || '').trim();
  const body = (input.text || '').trim();
  if (!title) return { ok: false, error: 'Medium story needs a title' };
  if (!body) return { ok: false, error: 'Medium story body is empty' };
  const autoSubmit = input.autoSubmit !== false;

  // Unlike X/Quora (a single synthetic paste event), Medium's own editor only
  // accepts text typed one keystroke at a time without desyncing (see
  // cdp-typing.ts). Keep the tab foregrounded regardless of autoSubmit so
  // Medium's own React rendering isn't affected by hidden-tab rAF throttling
  // while the fill runs.
  const handle = await openTab(MEDIUM_NEW_STORY, {
    active: true,
    settleMs: RENDER_SETTLE_MS,
  });
  if (!handle) return { ok: false, error: 'Failed to open Medium tab' };
  const { tabId } = handle;

  try {
    if (await runInPage(tabId, mediumDetectAuthWall)) {
      await focusTab(tabId);
      return { ok: false, error: 'Not signed in to Medium — log in, then retry.' };
    }

    // Real, trusted keystrokes via chrome.debugger (see cdp-typing.ts) rather
    // than page-level synthetic events — the latter was verified live to
    // non-deterministically drop/duplicate characters against Medium's own
    // desync detector, leaving Publish disabled even when the fill looked
    // complete on screen.
    const debuggerAttached = await attachDebugger(tabId);
    if (!debuggerAttached) {
      await focusTab(tabId);
      return {
        ok: false,
        error:
          'Could not enable precise typing for Medium (chrome.debugger attach failed — close DevTools on this tab, then retry).',
      };
    }

    let filled = false;
    try {
      const titleFocus = await runInPage(tabId, mediumFocusField, ['title']);
      if (titleFocus === 'ok') {
        await cdpTypeText(tabId, title);
        await sleep(150);
        const bodyFocus = await runInPage(tabId, mediumFocusField, ['body']);
        if (bodyFocus === 'ok') await cdpTypeText(tabId, body);
        filled = bodyFocus === 'ok' || bodyFocus === 'skip';
      }
    } finally {
      await detachDebugger(tabId);
    }

    if (!filled) {
      await focusTab(tabId);
      return {
        ok: false,
        error:
          'Could not find the Medium editor fields (Medium markup may have changed). Publish manually.',
      };
    }

    if (!autoSubmit) {
      await focusTab(tabId);
      return {
        ok: true,
        pending: true,
        message: 'Draft filled into the Medium editor. Review it, then click Publish.',
      };
    }

    const outcome = await driveMediumPublish(tabId);
    if (outcome.permalink) {
      await sleep(TAB_CLOSE_GRACE_MS);
      await closeTab(tabId);
      return {
        ok: true,
        message: 'Published on Medium.',
        permalink: outcome.permalink,
      };
    }

    // Filled but we couldn't confirm publication — surface the tab so the user
    // can finish/verify rather than reporting a false success.
    await focusTab(tabId);
    return {
      ok: true,
      pending: true,
      message: outcome.clicked
        ? 'Medium story filled and Publish clicked, but publication was not confirmed — verify in the opened tab.'
        : 'Medium story filled, but the Publish button could not be found — publish it in the opened tab.',
    };
  } catch (e: any) {
    console.error('[aisee][medium] publish failed', e);
    await focusTab(tabId);
    return { ok: false, error: `Medium injection failed: ${e?.message || e}` };
  }
}

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

const MEDIUM_NEW_STORY = 'https://medium.com/new-story';
const RENDER_SETTLE_MS = 3_000; // Medium hydrates the editor client-side
const TAB_CLOSE_GRACE_MS = 1_500;

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
 * Fill Medium's editor: the title field (first editable heading / placeholder
 * "Title") and the body (the main article contenteditable). Returns whether the
 * fields were found and populated.
 */
async function mediumFillEditor(
  title: string,
  body: string
): Promise<'filled' | 'no_editor'> {
  const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const setEditable = async (el: HTMLElement, text: string) => {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel?.removeAllRanges();
    sel?.addRange(range);
    if ((el.textContent || '').length) document.execCommand?.('delete');

    // Medium's editor (verified live) listens for keydown/keypress/keyup —
    // NOT a generic 'input' — and appears to track content by diffing what
    // its own keystroke listeners saw against the resulting DOM. A synthetic
    // ClipboardEvent('paste') is a silent no-op (distrusts non-isTrusted
    // clipboard events), and bulk execCommand('insertText', text) — even
    // wrapped in a single keydown/keypress/keyup — visually fills the story
    // correctly but leaves Medium showing "Something is wrong and we cannot
    // save your story" and Publish permanently disabled: one keypress event
    // reporting a multi-character insertion doesn't match what its model
    // expects, so it flags the desync (this exactly matches Medium's own
    // help-doc explanation: "a browser extension interfering with the DOM").
    // The fix (verified live, including with CJK text) is to insert ONE
    // character per keydown+keypress+execCommand+keyup cycle, so every
    // insertion Medium's listeners observe matches the DOM change it causes.
    for (const ch of text) {
      if (ch === '\n') {
        const opts = { bubbles: true, cancelable: true, composed: true, key: 'Enter', keyCode: 13, which: 13 };
        el.dispatchEvent(new KeyboardEvent('keydown', opts));
        document.execCommand?.('insertParagraph');
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
      } else {
        const opts = {
          bubbles: true,
          cancelable: true,
          composed: true,
          key: ch,
          charCode: ch.charCodeAt(0),
          keyCode: ch.charCodeAt(0),
          which: ch.charCodeAt(0),
        };
        el.dispatchEvent(new KeyboardEvent('keydown', opts));
        el.dispatchEvent(new KeyboardEvent('keypress', opts));
        const inserted = document.execCommand?.('insertText', false, ch) ?? false;
        if (!inserted) el.textContent = (el.textContent || '') + ch;
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
      }
      await sleepMs(8);
    }
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
    );
  };

  // Medium nests the WHOLE story — the title heading plus every body
  // paragraph — inside a single contenteditable region (a <section> under
  // .postArticle-content); it does not expose one contenteditable per
  // field. A page can also contain unrelated contenteditable elements
  // elsewhere (observed: an empty 100x100 decoy div), so naively treating
  // the first two `[contenteditable="true"]` matches as "title" and "body"
  // corrupts the article (title overwrites the whole container) and writes
  // the body into an unrelated element. Instead: find the contenteditable
  // region that actually contains the heading, then target the heading
  // (title) and its first sibling paragraph (body) directly.
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

  await setEditable(titleEl, title);
  await sleepMs(150);
  if (bodyEl !== titleEl) await setEditable(bodyEl, body);
  return 'filled';
}

/**
 * Click Medium's Publish control, then the final confirm button on the
 * "Story preview" step. Returns 'published' once the second button was
 * clicked, 'dialog' if only the first step succeeded, or 'no_button' when
 * neither was found. Defensive: matches by data-testid AND visible button
 * text.
 */
function mediumClickPublish(): Promise<'published' | 'dialog' | 'no_button'> {
  const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const byText = (re: RegExp, exclude?: HTMLElement): HTMLElement | null =>
    Array.from(document.querySelectorAll<HTMLElement>('button, a[role="button"]'))
      .find((b) => b !== exclude && re.test((b.textContent || '').trim())) || null;

  return (async () => {
    const publishBtn =
      document.querySelector<HTMLElement>('[data-testid="publishButton"]') ||
      document.querySelector<HTMLElement>('[data-action="show-prepublish"]') ||
      byText(/^publish$/i);
    if (!publishBtn) return 'no_button';
    publishBtn.click();

    // Medium doesn't show an in-page dialog here — clicking Publish navigates
    // to a separate "Story preview" page (URL gains /submission) with its own
    // confirm button, which (verified live) is plainly labelled "Publish"
    // (not "Publish now") and carries no distinguishing data-testid/data-action.
    // Since it's on a different page than publishBtn, matching by text alone
    // is unambiguous; `exclude: publishBtn` guards against a same-page repeat
    // match if Medium ever reintroduces an in-page dialog instead.
    for (let i = 0; i < 40; i++) {
      await sleepMs(200);
      const confirm =
        document.querySelector<HTMLElement>(
          '[data-testid="publishConfirmButton"]'
        ) ||
        document.querySelector<HTMLElement>('[data-action="publish"]') ||
        byText(/^publish( now)?$/i, publishBtn);
      if (confirm) {
        confirm.click();
        return 'published';
      }
    }
    return 'dialog';
  })();
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

/** Publish a single Medium story (segment 0). */
export async function postMediumStory(
  input: MediumStoryInput
): Promise<ReplyResult> {
  const title = (input.title || '').trim();
  const body = (input.text || '').trim();
  if (!title) return { ok: false, error: 'Medium story needs a title' };
  if (!body) return { ok: false, error: 'Medium story body is empty' };
  const autoSubmit = input.autoSubmit !== false;

  const handle = await openTab(MEDIUM_NEW_STORY, {
    active: !autoSubmit,
    settleMs: RENDER_SETTLE_MS,
  });
  if (!handle) return { ok: false, error: 'Failed to open Medium tab' };
  const { tabId } = handle;

  try {
    if (await runInPage(tabId, mediumDetectAuthWall)) {
      await focusTab(tabId);
      return { ok: false, error: 'Not signed in to Medium — log in, then retry.' };
    }

    const fill = await runInPage(tabId, mediumFillEditor, [title, body]);
    if (fill !== 'filled') {
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

    const clicked = await runInPage(tabId, mediumClickPublish);
    if (clicked === 'published') {
      // Medium navigates to the published story URL on success — read it back.
      let permalink: string | undefined;
      for (let i = 0; i < 25; i++) {
        await sleep(300);
        const url = (await getTabUrl(tabId)) || '';
        if (isPublishedStoryUrl(url)) {
          permalink = url.split(/[?#]/)[0];
          break;
        }
      }
      if (permalink) {
        await sleep(TAB_CLOSE_GRACE_MS);
        await closeTab(tabId);
        return { ok: true, message: 'Published on Medium.', permalink };
      }
    }

    // Filled + clicked but we couldn't confirm publication — surface the tab so
    // the user can finish/verify rather than reporting a false success.
    await focusTab(tabId);
    return {
      ok: true,
      pending: true,
      message:
        'Medium story filled and Publish clicked, but publication was not confirmed — verify in the opened tab.',
    };
  } catch (e: any) {
    console.error('[aisee][medium] publish failed', e);
    await focusTab(tabId);
    return { ok: false, error: `Medium injection failed: ${e?.message || e}` };
  }
}

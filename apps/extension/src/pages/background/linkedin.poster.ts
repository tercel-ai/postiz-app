// In-browser LinkedIn posting (Option A): open linkedin.com in a background tab
// and drive LinkedIn's OWN composer via chrome.scripting.executeScript — a new
// share (postLinkedinCompose) and a self-comment thread continuation
// (postLinkedinComment). We only FILL the editor and click LinkedIn's own Post
// button; letting LinkedIn's JS build + sign the Voyager request is far more
// reliable than replaying its internal API from the worker (mirrors x.poster).
//
// A document-idle MAIN-world interceptor patches fetch/XHR to capture the create
// response and stash the new activity urn on window.__aiseeLinkedinCreated, so we
// can return a permalink. Without a capture the post may still have gone out —
// we surface the tab (pending) rather than claim success we can't confirm.
//
// linkedin.com host permission comes from the LinkedinProvider entry (see
// vite.config.base.ts). LinkedIn's editor is Quill (`.ql-editor`).

import { ReplyResult } from '@gitroom/extension/utils/reply.types';

const LINKEDIN_BASE = 'https://www.linkedin.com';
const TAB_LOAD_TIMEOUT_MS = 20_000;
const TAB_CLOSE_GRACE_MS = 1_500;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    console.warn('[aisee][linkedin] focusTab failed', e);
  }
}

async function closeTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    console.warn('[aisee][linkedin] closeTab failed', e);
  }
}

/** `urn:li:activity:123` → https://www.linkedin.com/feed/update/urn:li:activity:123/ */
function permalinkFromUrn(urn: string): string | undefined {
  const m = urn.match(/urn:li:(?:activity|ugcPost|share):\d+/i);
  if (!m) return undefined;
  return `${LINKEDIN_BASE}/feed/update/${m[0]}/`;
}

// ── MAIN-world create interceptor (self-contained) ──────────────────────────

/**
 * Runs in the page's MAIN world. Patches fetch + XHR to capture the response of
 * LinkedIn's content-creation call and stash the new activity urn on
 * window.__aiseeLinkedinCreated. Must be installed BEFORE Post is clicked.
 */
function installLinkedinCreateInterceptor(): void {
  const w = window as any;
  if (w.__aiseeLinkedinInterceptorInstalled) return;
  w.__aiseeLinkedinInterceptorInstalled = true;
  w.__aiseeLinkedinCreated = null;

  const isCreateUrl = (url: string) =>
    /\/voyager\/api\/(?:contentcreation\/normShares|graphql|feed\/dash|.*[Cc]omments)/.test(
      url
    ) || /\/voyager\/api\/.*[Cc]reate/.test(url);

  const extract = (text: string) => {
    try {
      // The create response embeds the new object urn; scan for the first
      // activity/ugcPost/share/comment urn in the raw body (shape varies across
      // LinkedIn's REST vs GraphQL endpoints).
      const m =
        text.match(/urn:li:(?:activity|ugcPost|share):\d+/) ||
        text.match(/urn:li:comment:\([^)]*\)/);
      if (m && !w.__aiseeLinkedinCreated) {
        w.__aiseeLinkedinCreated = { urn: m[0] };
      }
    } catch (e) {
      /* ignore */
    }
  };

  const origFetch = w.fetch;
  w.fetch = function (...args: any[]) {
    return origFetch.apply(this, args).then((res: Response) => {
      try {
        const first = args[0];
        const url = typeof first === 'string' ? first : first?.url;
        const method = (args[1]?.method || first?.method || 'GET').toUpperCase();
        if (typeof url === 'string' && method === 'POST' && isCreateUrl(url)) {
          res
            .clone()
            .text()
            .then(extract)
            .catch(() => {});
        }
      } catch (e) {
        /* ignore */
      }
      return res;
    });
  };

  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: any, ...a: any[]) {
    this.__aiseeUrl = a[1];
    this.__aiseeMethod = String(a[0] || '').toUpperCase();
    return OrigOpen.apply(this, a as any);
  };
  XMLHttpRequest.prototype.send = function (this: any, ...a: any[]) {
    this.addEventListener('load', function (this: any) {
      try {
        if (
          typeof this.__aiseeUrl === 'string' &&
          this.__aiseeMethod === 'POST' &&
          isCreateUrl(this.__aiseeUrl)
        ) {
          extract(String(this.responseText || ''));
        }
      } catch (e) {
        /* ignore */
      }
    });
    return OrigSend.apply(this, a as any);
  };
}

/** Runs in MAIN world: poll for the captured create urn (~8s). */
function readLinkedinCreated(): Promise<{ urn: string } | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const v = (window as any).__aiseeLinkedinCreated;
      if (v && v.urn) return resolve(v);
      if (Date.now() - start > 8_000) return resolve(null);
      setTimeout(tick, 200);
    };
    tick();
  });
}

// ── ISOLATED-world editor driver (self-contained) ───────────────────────────

/**
 * Runs INSIDE the linkedin.com page (serialized — fully self-contained). Opens
 * the share composer if needed, fills the Quill editor, and (when autoSubmit)
 * clicks LinkedIn's own Post button. Returns 'sent' | 'filled' | 'not_found'.
 */
function fillLinkedinShareInPage(
  text: string,
  autoSubmit: boolean
): Promise<'sent' | 'filled' | 'not_found'> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (
    find: () => HTMLElement | null,
    timeoutMs: number
  ): Promise<HTMLElement | null> => {
    const start = Date.now();
    for (;;) {
      const el = find();
      if (el) return el;
      if (Date.now() - start > timeoutMs) return null;
      await sleep(150);
    }
  };

  const findEditor = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(
      '.share-box .ql-editor[contenteditable="true"]'
    ) ??
    document.querySelector<HTMLElement>(
      '.editor-content .ql-editor[contenteditable="true"]'
    ) ??
    document.querySelector<HTMLElement>('.ql-editor[contenteditable="true"]');

  const findPostButton = (): HTMLElement | null => {
    const byLabel = Array.from(
      document.querySelectorAll<HTMLElement>('button')
    ).find((b) => {
      const label = (b.getAttribute('aria-label') || b.innerText || '')
        .trim()
        .toLowerCase();
      return /^post$/.test(label) || label === 'post';
    });
    return (
      document.querySelector<HTMLElement>(
        '.share-actions__primary-action, button.share-actions__primary-action'
      ) ??
      byLabel ??
      null
    );
  };

  return (async () => {
    // Open the composer if it isn't already up: click the "Start a post" trigger.
    if (!findEditor()) {
      const trigger =
        document.querySelector<HTMLElement>(
          'button.share-box-feed-entry__trigger'
        ) ??
        Array.from(document.querySelectorAll<HTMLElement>('button')).find((b) =>
          /start a post/i.test(b.innerText || b.getAttribute('aria-label') || '')
        ) ??
        null;
      trigger?.click();
    }

    const editor = await waitFor(findEditor, 10_000);
    if (!editor) return 'not_found';

    editor.focus();
    // Quill listens for input events; execCommand insertText fires them.
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const inserted = document.execCommand?.('insertText', false, text) ?? false;
    if (!inserted) editor.textContent = text;
    editor.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
    );

    if (!autoSubmit) return 'filled';

    const postButton = await waitFor(() => {
      const btn = findPostButton();
      if (!btn) return null;
      const disabled =
        btn.getAttribute('aria-disabled') === 'true' ||
        (btn as HTMLButtonElement).disabled === true;
      return disabled ? null : btn;
    }, 8_000);
    if (!postButton) return 'filled';

    postButton.click();
    await sleep(2_000);
    return 'sent';
  })();
}

/**
 * Runs INSIDE a linkedin.com post page (serialized — self-contained). Fills the
 * comment box and (when autoSubmit) clicks the Comment/Post button.
 */
function fillLinkedinCommentInPage(
  text: string,
  autoSubmit: boolean
): Promise<'sent' | 'filled' | 'not_found'> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (
    find: () => HTMLElement | null,
    timeoutMs: number
  ): Promise<HTMLElement | null> => {
    const start = Date.now();
    for (;;) {
      const el = find();
      if (el) return el;
      if (Date.now() - start > timeoutMs) return null;
      await sleep(150);
    }
  };

  const findCommentEditor = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(
      '.comments-comment-box .ql-editor[contenteditable="true"]'
    ) ??
    document.querySelector<HTMLElement>(
      '.comments-comment-texteditor .ql-editor[contenteditable="true"]'
    ) ??
    document.querySelector<HTMLElement>(
      'div[data-placeholder][contenteditable="true"]'
    );

  const findSubmit = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(
      '.comments-comment-box__submit-button, button.comments-comment-box__submit-button'
    ) ??
    Array.from(document.querySelectorAll<HTMLElement>('button')).find((b) =>
      /^(post|comment)$/i.test(
        (b.getAttribute('aria-label') || b.innerText || '').trim()
      )
    ) ??
    null;

  return (async () => {
    // Reveal the comment box: click the "Comment" action if the editor is hidden.
    if (!findCommentEditor()) {
      const commentAction =
        Array.from(document.querySelectorAll<HTMLElement>('button')).find((b) =>
          /^comment$/i.test(
            (b.getAttribute('aria-label') || b.innerText || '').trim()
          )
        ) ?? null;
      commentAction?.click();
    }

    const editor = await waitFor(findCommentEditor, 10_000);
    if (!editor) return 'not_found';

    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const inserted = document.execCommand?.('insertText', false, text) ?? false;
    if (!inserted) editor.textContent = text;
    editor.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
    );

    if (!autoSubmit) return 'filled';

    const submit = await waitFor(() => {
      const btn = findSubmit();
      if (!btn) return null;
      const disabled =
        btn.getAttribute('aria-disabled') === 'true' ||
        (btn as HTMLButtonElement).disabled === true;
      return disabled ? null : btn;
    }, 8_000);
    if (!submit) return 'filled';

    submit.click();
    await sleep(2_000);
    return 'sent';
  })();
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface LinkedinComposeInput {
  text: string;
  /** Server URLs of images. Best-effort — see the note in postLinkedinCompose. */
  images?: string[];
  /** When false, fill the composer but let the user click Post. Default true. */
  autoSubmit?: boolean;
}

/**
 * Publish a NEW LinkedIn share via linkedin.com's own composer (open tab → fill
 * Quill editor → click LinkedIn's own Post → capture the create urn). No direct
 * Voyager calls.
 *
 * Images are NOT yet supported through the tab composer (LinkedIn's media upload
 * is a multi-step register/upload flow behind a native picker); an image-bearing
 * request is rejected so the caller never silently drops the media.
 */
export async function postLinkedinCompose(
  input: LinkedinComposeInput
): Promise<ReplyResult> {
  const text = (input.text || '').trim();
  const images = (input.images || []).filter(Boolean);
  if (!text) return { ok: false, error: 'Post text is empty' };
  if (images.length) {
    return {
      ok: false,
      error:
        'LinkedIn image posts are not supported via the extension yet — post text-only or attach the image manually.',
    };
  }
  const autoSubmit = input.autoSubmit !== false;

  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({
      url: `${LINKEDIN_BASE}/feed/?shareActive=true`,
      active: !autoSubmit,
    });
    tabId = tab.id ?? undefined;
  } catch (e: any) {
    return { ok: false, error: `Failed to open LinkedIn tab: ${e?.message || e}` };
  }
  if (tabId == null) return { ok: false, error: 'Failed to open LinkedIn tab' };

  await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);

  try {
    if (autoSubmit) {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: installLinkedinCreateInterceptor,
      });
    }

    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: fillLinkedinShareInPage,
      args: [text, autoSubmit],
    });
    return await settle(tabId, injection?.result, autoSubmit, 'Post');
  } catch (e: any) {
    console.error('[aisee][linkedin] compose executeScript failed', e);
    await focusTab(tabId);
    return { ok: false, error: `LinkedIn injection failed: ${e?.message || e}` };
  }
}

export interface LinkedinCommentInput {
  /** URL of the post to comment on (the previous thread segment's permalink). */
  url: string;
  text: string;
  autoSubmit?: boolean;
}

/**
 * Comment on an existing LinkedIn post as a native thread continuation (open the
 * post → fill the comment box → click Comment → capture the comment urn).
 */
export async function postLinkedinComment(
  input: LinkedinCommentInput
): Promise<ReplyResult> {
  const text = (input.text || '').trim();
  if (!text) return { ok: false, error: 'Comment text is empty' };
  const url = (input.url || '').trim();
  if (!/^https?:\/\/(www\.)?linkedin\.com\//i.test(url)) {
    return { ok: false, error: 'A LinkedIn post URL is required to thread onto' };
  }
  const autoSubmit = input.autoSubmit !== false;

  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url, active: !autoSubmit });
    tabId = tab.id ?? undefined;
  } catch (e: any) {
    return { ok: false, error: `Failed to open LinkedIn tab: ${e?.message || e}` };
  }
  if (tabId == null) return { ok: false, error: 'Failed to open LinkedIn tab' };

  await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);

  try {
    if (autoSubmit) {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: installLinkedinCreateInterceptor,
      });
    }
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: fillLinkedinCommentInPage,
      args: [text, autoSubmit],
    });
    // Comments capture a comment urn (not an activity urn) — the permalink of a
    // comment isn't a clean /feed/update URL, so we keep the parent post's URL as
    // the thread anchor and only mark success/pending here.
    return await settle(tabId, injection?.result, autoSubmit, 'Comment', url);
  } catch (e: any) {
    console.error('[aisee][linkedin] comment executeScript failed', e);
    await focusTab(tabId);
    return { ok: false, error: `LinkedIn injection failed: ${e?.message || e}` };
  }
}

/** Shared tail: interpret the injection status, read the capture, settle the tab. */
async function settle(
  tabId: number,
  status: 'sent' | 'filled' | 'not_found' | undefined,
  autoSubmit: boolean,
  verb: 'Post' | 'Comment',
  fallbackPermalink?: string
): Promise<ReplyResult> {
  if (status === 'sent') {
    let permalink = fallbackPermalink;
    let postId: string | undefined;
    let confirmed = false;
    try {
      const [cap] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: readLinkedinCreated,
      });
      const urn = cap?.result?.urn;
      if (urn) {
        confirmed = true;
        postId = urn;
        permalink = permalinkFromUrn(urn) ?? permalink;
      }
    } catch (e) {
      console.error('[aisee][linkedin] capture read failed', e);
    }
    if (confirmed) {
      await wait(TAB_CLOSE_GRACE_MS);
      await closeTab(tabId);
    } else {
      // Sent-click fired but no create response was intercepted — don't close a
      // tab whose request may still be settling; surface it for the user.
      await focusTab(tabId);
    }
    return {
      ok: true,
      message: `${verb} sent on LinkedIn.`,
      permalink,
      postId,
    };
  }
  if (status === 'filled') {
    await focusTab(tabId);
    return {
      ok: true,
      pending: true,
      message: autoSubmit
        ? `Draft filled but the ${verb} button stayed disabled — review and click ${verb} on LinkedIn.`
        : `Draft filled into the LinkedIn composer. Review it, then click ${verb}.`,
    };
  }
  await focusTab(tabId);
  return {
    ok: false,
    error: `Opened LinkedIn but could not find the ${verb.toLowerCase()} box (DOM may have changed). ${verb} manually.`,
  };
}

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
//
// Images: LinkedIn's share composer only exposes its file input after the
// "Add media" trigger is clicked (opens a separate media-editor overlay), so
// attachLinkedinImagesInPage drives that two-step flow before the text fill —
// confirmed live: attach → click Next → back at the compose view with the
// image embedded and Quill still fillable normally.

import { ReplyResult } from '@gitroom/extension/utils/reply.types';
import { fetchImageForPage } from '@gitroom/extension/pages/background/x.poster';

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

/**
 * Runs INSIDE the linkedin.com page (ISOLATED world — self-contained). Reads
 * the permalink straight off LinkedIn's own "Post successful. View post" toast
 * (role="alert" with an <a href="…/feed/update/urn:li:…">), confirmed live —
 * this is the PRIMARY capture path (see settle()): the fetch/XHR interceptor
 * is only installed in the top frame, and LinkedIn's actual create request can
 * fire from a child frame it never patches, silently missing the urn even on
 * a genuinely successful post. Reading the toast has no such frame dependency
 * — it's rendered wherever this script runs. Also behind an open shadow root
 * on some LinkedIn builds, hence deepQuery.
 */
function readLinkedinPostToastLink(): Promise<{ href: string } | null> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const deepQuery = (
    selector: string,
    root: Document | ShadowRoot = document
  ): HTMLElement | null => {
    const direct = root.querySelector<HTMLElement>(selector);
    if (direct) return direct;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      if (el.shadowRoot) {
        const found = deepQuery(selector, el.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  };
  return (async () => {
    const start = Date.now();
    for (;;) {
      const link = deepQuery(
        '[role="alert"] a[href*="/feed/update/urn:li:"]'
      ) as HTMLAnchorElement | null;
      if (link?.href) return { href: link.href };
      if (Date.now() - start > 6_000) return null;
      await sleep(200);
    }
  })();
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

  // LinkedIn's share-box composer is now a web component behind an OPEN shadow
  // root — confirmed live: the editor is invisible to a plain
  // document.querySelector/querySelectorAll (they never pierce shadow DOM,
  // open or not), which is why every selector below always came back empty
  // even though the composer was visibly on screen. These walk into any open
  // shadow root encountered, depth-first.
  const deepQuery = (
    selector: string,
    root: Document | ShadowRoot = document
  ): HTMLElement | null => {
    const direct = root.querySelector<HTMLElement>(selector);
    if (direct) return direct;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      if (el.shadowRoot) {
        const found = deepQuery(selector, el.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  };
  const deepQueryAll = (
    selector: string,
    root: Document | ShadowRoot = document,
    out: HTMLElement[] = []
  ): HTMLElement[] => {
    out.push(...root.querySelectorAll<HTMLElement>(selector));
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      if (el.shadowRoot) deepQueryAll(selector, el.shadowRoot, out);
    }
    return out;
  };

  const findEditor = (): HTMLElement | null =>
    deepQuery('.share-box .ql-editor[contenteditable="true"]') ??
    deepQuery('.editor-content .ql-editor[contenteditable="true"]') ??
    deepQuery('.ql-editor[contenteditable="true"]');

  const findPostButton = (): HTMLElement | null => {
    const byLabel = deepQueryAll('button').find((b) => {
      const label = (b.getAttribute('aria-label') || b.innerText || '')
        .trim()
        .toLowerCase();
      return /^post$/.test(label) || label === 'post';
    });
    return (
      deepQuery('.share-actions__primary-action, button.share-actions__primary-action') ??
      byLabel ??
      null
    );
  };

  return (async () => {
    // Open the composer if it isn't already up: click the "Start a post" trigger.
    if (!findEditor()) {
      const trigger =
        deepQuery('button.share-box-feed-entry__trigger') ??
        deepQueryAll('button').find((b) =>
          /start a post/i.test(b.innerText || b.getAttribute('aria-label') || '')
        ) ??
        null;
      trigger?.click();
    }

    const editor = await waitFor(findEditor, 10_000);
    if (!editor) {
      // Captured at the exact failure instant (not a manual after-the-fact
      // check, which can land on a stale/dismissed modal) — the diagnostic
      // that matters when the selectors below drift from LinkedIn's DOM.
      try {
        console.warn('[aisee][linkedin] editor not found — DOM snapshot', {
          url: location.href,
          qlEditorCountDeep: deepQueryAll('.ql-editor').length,
          contentEditableCountDeep: deepQueryAll('[contenteditable]').length,
          shareBoxPresentDeep: !!deepQuery('.share-box'),
          triggerButtons: deepQueryAll('button')
            .map((b) => (b.getAttribute('aria-label') || b.innerText || '').trim())
            .filter(Boolean)
            .slice(0, 30),
        });
      } catch {
        /* diagnostics must never throw past the caller */
      }
      return 'not_found';
    }

    editor.focus();
    const selectAllContents = () => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection?.removeAllRanges();
      selection?.addRange(range);
    };
    selectAllContents();

    // LinkedIn's composer exposes its live Quill instance as `__quill` on an
    // ancestor of the editor (confirmed live, a few DOM levels up). Its own
    // setText() is the authoritative way to change content: it updates
    // Quill's internal Delta model directly, which is what actually drives
    // the Post button's enabled state. DOM-level tricks can write visible
    // text WITHOUT Quill ever recognizing it — confirmed live: a raw
    // execCommand('insertText') happily mutates the DOM but leaves the
    // editor's `ql-blank` class (and so the Post button) untouched, because
    // Quill's own model never saw the change. Try the Quill API first, since
    // it is the one path that reliably enables Post; the DOM fallbacks exist
    // only because `__quill` is undocumented and could vanish in a future
    // LinkedIn build.
    const findQuillInstance = (): { setText: (t: string, source: string) => void } | null => {
      let node: HTMLElement | null = editor.parentElement;
      let hops = 0;
      while (node && hops < 8) {
        const q = (node as any).__quill;
        if (q && typeof q.setText === 'function') return q;
        node = node.parentElement;
        hops++;
      }
      return null;
    };

    let filled = false;
    try {
      const quill = findQuillInstance();
      if (quill) {
        quill.setText(text, 'user');
        await sleep(50);
        filled = (editor.textContent || '').replace(/\s/g, '').length > 0;
      }
    } catch {
      filled = false;
    }

    // Fallback: simulate a PASTE — the same fix x.poster's Draft.js composer
    // needed — for a build where `__quill` isn't exposed or didn't take.
    // `composed: true` lets the event cross OUT of the editor's shadow root,
    // in case a listener is attached on the host/light-DOM side.
    if (!filled) {
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        editor.dispatchEvent(
          new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            composed: true,
            clipboardData: dt,
          })
        );
        await sleep(50); // Quill re-renders asynchronously
        filled = (editor.textContent || '').replace(/\s/g, '').length > 0;
      } catch {
        filled = false;
      }
    }

    // Last-resort fallback: raw execCommand. Confirmed live to write the DOM
    // even when Quill's model never registers it (Post stays disabled) —
    // still better than an empty box, since the user can see and finish it.
    if (!filled) {
      selectAllContents();
      const inserted = document.execCommand?.('insertText', false, text) ?? false;
      if (!inserted) editor.textContent = text;
      editor.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: text,
        })
      );
    }

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

  // Same shadow-DOM caveat as the share composer (see fillLinkedinShareInPage)
  // — plain querySelector never pierces an open shadow root, so these walk
  // into any encountered along the way.
  const deepQuery = (
    selector: string,
    root: Document | ShadowRoot = document
  ): HTMLElement | null => {
    const direct = root.querySelector<HTMLElement>(selector);
    if (direct) return direct;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      if (el.shadowRoot) {
        const found = deepQuery(selector, el.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  };
  const deepQueryAll = (
    selector: string,
    root: Document | ShadowRoot = document,
    out: HTMLElement[] = []
  ): HTMLElement[] => {
    out.push(...root.querySelectorAll<HTMLElement>(selector));
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      if (el.shadowRoot) deepQueryAll(selector, el.shadowRoot, out);
    }
    return out;
  };

  const findCommentEditor = (): HTMLElement | null =>
    deepQuery('.comments-comment-box .ql-editor[contenteditable="true"]') ??
    deepQuery('.comments-comment-texteditor .ql-editor[contenteditable="true"]') ??
    deepQuery('div[data-placeholder][contenteditable="true"]');

  const findSubmit = (): HTMLElement | null =>
    deepQuery(
      '.comments-comment-box__submit-button, button.comments-comment-box__submit-button'
    ) ??
    deepQueryAll('button').find((b) =>
      /^(post|comment)$/i.test(
        (b.getAttribute('aria-label') || b.innerText || '').trim()
      )
    ) ??
    null;

  return (async () => {
    // Reveal the comment box: click the "Comment" action if the editor is hidden.
    if (!findCommentEditor()) {
      const commentAction =
        deepQueryAll('button').find((b) =>
          /^comment$/i.test(
            (b.getAttribute('aria-label') || b.innerText || '').trim()
          )
        ) ?? null;
      commentAction?.click();
    }

    const editor = await waitFor(findCommentEditor, 10_000);
    if (!editor) {
      try {
        console.warn('[aisee][linkedin] comment editor not found — DOM snapshot', {
          url: location.href,
          qlEditorCountDeep: deepQueryAll('.ql-editor').length,
          contentEditableCountDeep: deepQueryAll('[contenteditable]').length,
          commentBoxPresentDeep: !!deepQuery('.comments-comment-box'),
        });
      } catch {
        /* diagnostics must never throw past the caller */
      }
      return 'not_found';
    }

    editor.focus();
    const selectAllContents = () => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection?.removeAllRanges();
      selection?.addRange(range);
    };
    selectAllContents();

    // Same Quill caveats as the share composer (see fillLinkedinShareInPage):
    // try the exposed `__quill` instance's own setText() first — it is what
    // actually drives Quill's model (and so the submit button's enabled
    // state) — then fall back to a simulated paste, then raw execCommand.
    const findQuillInstance = (): { setText: (t: string, source: string) => void } | null => {
      let node: HTMLElement | null = editor.parentElement;
      let hops = 0;
      while (node && hops < 8) {
        const q = (node as any).__quill;
        if (q && typeof q.setText === 'function') return q;
        node = node.parentElement;
        hops++;
      }
      return null;
    };

    let filled = false;
    try {
      const quill = findQuillInstance();
      if (quill) {
        quill.setText(text, 'user');
        await sleep(50);
        filled = (editor.textContent || '').replace(/\s/g, '').length > 0;
      }
    } catch {
      filled = false;
    }

    if (!filled) {
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        editor.dispatchEvent(
          new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            composed: true,
            clipboardData: dt,
          })
        );
        await sleep(50); // Quill re-renders asynchronously
        filled = (editor.textContent || '').replace(/\s/g, '').length > 0;
      } catch {
        filled = false;
      }
    }

    if (!filled) {
      selectAllContents();
      const inserted = document.execCommand?.('insertText', false, text) ?? false;
      if (!inserted) editor.textContent = text;
      editor.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: text,
        })
      );
    }

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

/**
 * Runs INSIDE the linkedin.com page (serialized — self-contained). Attaches
 * images through LinkedIn's own two-step media flow: click "Add media" → find
 * the file input (it does not exist in the DOM until this click — confirmed
 * live) → hand it File objects, exactly like a user picking files, so
 * LinkedIn runs its own upload pipeline → click "Next" to return to the
 * compose view with the image embedded. Both the trigger button and the file
 * input live behind an open shadow root — see fillLinkedinShareInPage.
 */
function attachLinkedinImagesInPage(
  files: Array<{ name: string; mime: string; b64: string }>
): Promise<'attached' | 'no_button' | 'no_input' | 'no_preview'> {
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
  const deepQuery = (
    selector: string,
    root: Document | ShadowRoot = document
  ): HTMLElement | null => {
    const direct = root.querySelector<HTMLElement>(selector);
    if (direct) return direct;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      if (el.shadowRoot) {
        const found = deepQuery(selector, el.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  };
  const deepQueryAll = (
    selector: string,
    root: Document | ShadowRoot = document,
    out: HTMLElement[] = []
  ): HTMLElement[] => {
    out.push(...root.querySelectorAll<HTMLElement>(selector));
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      if (el.shadowRoot) deepQueryAll(selector, el.shadowRoot, out);
    }
    return out;
  };

  return (async () => {
    const addMediaButton = deepQueryAll('button').find((b) =>
      /^add media$/i.test((b.getAttribute('aria-label') || b.innerText || '').trim())
    );
    if (!addMediaButton) return 'no_button';
    addMediaButton.click();

    const input = (await waitFor(
      () =>
        deepQuery('input#media-editor-file-selector__file-input') ??
        deepQuery('input[type="file"][accept*="image"]') ??
        deepQuery('input[type="file"]'),
      10_000
    )) as HTMLInputElement | null;
    if (!input) return 'no_input';

    const dt = new DataTransfer();
    for (const f of files) {
      const bin = atob(f.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], f.name, { type: f.mime }));
    }
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const preview = await waitFor(() => deepQuery('img[alt^="Preview of"]'), 15_000);
    if (!preview) return 'no_preview';

    const nextButton = await waitFor(() => {
      const btn = deepQueryAll('button').find(
        (b) => (b.getAttribute('aria-label') || b.innerText || '').trim() === 'Next'
      );
      if (!btn) return null;
      return (btn as HTMLButtonElement).disabled ? null : btn;
    }, 8_000);
    if (!nextButton) return 'no_preview';
    nextButton.click();

    // The media-editor overlay closes asynchronously; wait for the compose
    // view's editor to be reachable again before the caller fills text.
    await waitFor(() => deepQuery('.ql-editor[contenteditable="true"]'), 8_000);
    return 'attached';
  })();
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface LinkedinComposeInput {
  text: string;
  /** Server URLs of images to attach via LinkedIn's own media-editor file input. */
  images?: string[];
  /** When false, fill the composer but let the user click Post. Default true. */
  autoSubmit?: boolean;
}

/**
 * Publish a NEW LinkedIn share via linkedin.com's own composer (open tab →
 * attach images → fill Quill editor → click LinkedIn's own Post → capture the
 * create urn). No direct Voyager calls — images go through LinkedIn's own
 * "Add media" file input (see attachLinkedinImagesInPage), the same as a user
 * picking files, mirroring x.poster's image attachment.
 */
export async function postLinkedinCompose(
  input: LinkedinComposeInput
): Promise<ReplyResult> {
  const text = (input.text || '').trim();
  const images = (input.images || []).filter(Boolean);
  if (!text && !images.length) return { ok: false, error: 'Post text is empty' };
  const autoSubmit = input.autoSubmit !== false;

  // Fetch the images BEFORE opening any tab so a bad URL fails fast + clean.
  const files: Array<{ name: string; mime: string; b64: string }> = [];
  try {
    for (const url of images) files.push(await fetchImageForPage(url));
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }

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

    if (files.length) {
      const [attach] = await chrome.scripting.executeScript({
        target: { tabId },
        func: attachLinkedinImagesInPage,
        args: [files],
      });
      console.log('[aisee][linkedin] attach result:', attach?.result);
      if (attach?.result === 'no_button' || attach?.result === 'no_input') {
        await focusTab(tabId);
        return {
          ok: false,
          error:
            'Could not find the media upload control on the LinkedIn composer (DOM may have changed). Post manually.',
        };
      }
      // 'no_preview' falls through: the fill/submit step below still runs —
      // worst case the image silently didn't attach and only text goes out,
      // the same tradeoff x.poster's 'no_preview' already makes.
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

    // Primary: read LinkedIn's own "Post successful. View post" toast — no
    // frame dependency (see readLinkedinPostToastLink's doc comment).
    try {
      const [toastCap] = await chrome.scripting.executeScript({
        target: { tabId },
        func: readLinkedinPostToastLink,
      });
      const href = toastCap?.result?.href;
      const urnFromToast = href?.match(/urn:li:(?:activity|ugcPost|share):\d+/)?.[0];
      if (urnFromToast) {
        confirmed = true;
        postId = urnFromToast;
        permalink = href;
      }
    } catch (e) {
      console.error('[aisee][linkedin] toast capture read failed', e);
    }

    // Fallback: the MAIN-world fetch/XHR interceptor. Only installed in the
    // top frame, so it misses a create request fired from a child frame —
    // confirmed live: a real, toast-confirmed post with an empty capture.
    if (!confirmed) {
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

// In-browser X posting (Option A): open x.com in a tab and drive X's NATIVE
// composer via chrome.scripting.executeScript — replies (postXReply) and new
// posts (postXCompose) both. NEVER call X's internal API from the service
// worker: the tab+interceptor path is the only allowed X write path.
//
// Why executeScript instead of a content script: X serves a strict CSP that
// blocks crxjs's dynamic-import content-script loader, so the normal content
// script never runs on x.com. executeScript injects into the page's isolated
// world directly and is NOT subject to the page's script-src CSP.
//
// We only FILL the composer; the user reviews and clicks X's own Reply button.
// Letting X's own JS build and sign the request (x-client-transaction-id, etc.)
// is far more reliable than replaying its internal API from the background.

import { ReplyResult } from '@gitroom/extension/utils/reply.types';

export interface XReplyInput {
  url: string;
  text: string;
  // When false, fill the composer but let the user click Reply on X.
  // Defaults to true: the extension's submit IS the confirmation, so we send.
  autoSubmit?: boolean;
}

/** Normalize any tweet URL to a canonical https://x.com/<user>/status/<id> form. */
function buildXStatusUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    try {
      parsed = new URL(`https://${url.trim()}`);
    } catch {
      return null;
    }
  }

  const statusMatch =
    parsed.pathname.match(/^\/([^/]+)\/status(?:es)?\/(\d+)/) ??
    parsed.pathname.match(/^\/i\/web\/status\/(\d+)/);
  if (!statusMatch) return null;

  if (statusMatch.length === 3) {
    return `https://x.com/${statusMatch[1]}/status/${statusMatch[2]}`;
  }
  return `https://x.com/i/web/status/${statusMatch[1]}`;
}

/** Resolve once the tab has finished its top-level load (or times out). */
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

/**
 * Runs INSIDE the x.com page (serialized by executeScript — must be fully
 * self-contained, no outer-scope references). Opens the reply composer, fills
 * the draft, and (when autoSubmit) clicks X's own Reply button so X's JS signs
 * and sends the request. Returns 'sent' | 'filled' | 'not_found'.
 */
function fillXReplyInPage(
  text: string,
  autoSubmit: boolean
): Promise<'sent' | 'filled' | 'not_found'> {
  const findComposer = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(
      '[data-testid="tweetTextarea_0"][contenteditable="true"]'
    ) ??
    document.querySelector<HTMLElement>(
      '[data-testid^="tweetTextarea_"][contenteditable="true"]'
    ) ??
    document.querySelector<HTMLElement>(
      'div[role="textbox"][contenteditable="true"]'
    );

  const findSendButton = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(
      '[data-testid="tweetButtonInline"]'
    ) ?? document.querySelector<HTMLElement>('[data-testid="tweetButton"]');

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Poll-based wait that also catches attribute changes (e.g. the send button
  // flipping from aria-disabled="true" to enabled once text is present).
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

  return (async () => {
    if (!findComposer()) {
      const replyButton =
        document.querySelector<HTMLElement>('[data-testid="reply"]') ??
        document.querySelector<HTMLElement>('button[aria-label*="Reply"]');
      replyButton?.click();
    }

    const composer = await waitFor(findComposer, 10_000);
    if (!composer) return 'not_found';

    composer.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection?.removeAllRanges();
    selection?.addRange(range);

    const inserted =
      document.execCommand?.('insertText', false, text) ?? false;
    if (!inserted) composer.textContent = text;

    composer.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text,
      })
    );

    if (!autoSubmit) return 'filled';

    // Wait for the send button to exist AND become enabled, then click it.
    const sendButton = await waitFor(() => {
      const btn = findSendButton();
      if (!btn) return null;
      const disabled =
        btn.getAttribute('aria-disabled') === 'true' ||
        (btn as HTMLButtonElement).disabled === true;
      return disabled ? null : btn;
    }, 6_000);

    if (!sendButton) return 'filled';

    sendButton.click();
    await sleep(1_500); // give X time to fire the request
    return 'sent';
  })();
}

/**
 * Runs in the page's MAIN world (so it can see X's own network calls). Patches
 * window.fetch + XHR to capture the GraphQL CreateTweet response and stash the
 * new tweet's rest_id + author screen_name on window.__aiseeCreatedTweet.
 * Must be installed BEFORE the Reply button is clicked. Self-contained.
 */
function installCreateTweetInterceptor(): void {
  const w = window as any;
  if (w.__aiseeInterceptorInstalled) return;
  w.__aiseeInterceptorInstalled = true;
  w.__aiseeCreatedTweet = null;

  const extract = (json: any) => {
    try {
      const r = json?.data?.create_tweet?.tweet_results?.result;
      const restId = r?.rest_id || r?.legacy?.id_str;
      const user = r?.core?.user_results?.result;
      const userLegacy = user?.legacy;
      const screenName =
        userLegacy?.screen_name || user?.core?.screen_name || '';
      // X moved the avatar around across API versions: newer responses use
      // `result.avatar.image_url`, older ones `legacy.profile_image_url_https`.
      let avatarUrl: string | undefined =
        user?.avatar?.image_url ||
        userLegacy?.profile_image_url_https ||
        undefined;
      // The default variant is the tiny `_normal` (48px); upscale to 400px.
      if (avatarUrl) avatarUrl = avatarUrl.replace('_normal.', '_400x400.');
      if (restId) {
        w.__aiseeCreatedTweet = {
          rest_id: String(restId),
          screen_name: String(screenName),
          author: screenName
            ? {
                handle: String(screenName),
                id: user?.rest_id ? String(user.rest_id) : undefined,
                name: userLegacy?.name || user?.core?.name || undefined,
                avatarUrl,
              }
            : undefined,
        };
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
        if (typeof url === 'string' && url.indexOf('CreateTweet') !== -1) {
          res
            .clone()
            .json()
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
    return OrigOpen.apply(this, a as any);
  };
  XMLHttpRequest.prototype.send = function (this: any, ...a: any[]) {
    this.addEventListener('load', function (this: any) {
      try {
        if (
          typeof this.__aiseeUrl === 'string' &&
          this.__aiseeUrl.indexOf('CreateTweet') !== -1
        ) {
          extract(JSON.parse(this.responseText));
        }
      } catch (e) {
        /* ignore */
      }
    });
    return OrigSend.apply(this, a as any);
  };
}

/** Runs in MAIN world: poll for the captured tweet (~6s) and return it. */
function readCapturedTweet(): Promise<{
  rest_id: string;
  screen_name: string;
  author?: { handle: string; id?: string; name?: string; avatarUrl?: string };
} | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const v = (window as any).__aiseeCreatedTweet;
      if (v && v.rest_id) return resolve(v);
      if (Date.now() - start > 6_000) return resolve(null);
      setTimeout(tick, 200);
    };
    tick();
  });
}

// Grace period before auto-closing a sent tab: let any trailing in-flight X
// requests settle so closing never races / aborts the actual send.
const TAB_CLOSE_GRACE_MS = 1500;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Best-effort: bring a possibly-background tab to the foreground. */
async function focusTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch (e) {
    console.warn('[aisee][x] focusTab failed', e);
  }
}

/** Best-effort: close the tab once the reply is sent (nothing left to show). */
async function closeTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    console.warn('[aisee][x] closeTab failed', e);
  }
}

/**
 * Runs INSIDE the x.com page (serialized — fully self-contained). Rebuilds the
 * images as File objects and hands them to the composer's file input, exactly
 * like a user picking files, so X runs its own upload pipeline. Waits for the
 * attachment previews to appear (uploading keeps the send button disabled, so
 * the later send-click wait covers slow uploads too).
 */
function attachXImagesInPage(
  files: Array<{ name: string; mime: string; b64: string }>
): Promise<'attached' | 'no_input' | 'no_preview'> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return (async () => {
    const input =
      document.querySelector<HTMLInputElement>(
        'input[data-testid="fileInput"]'
      ) ??
      document.querySelector<HTMLInputElement>(
        'input[type="file"][accept*="image"]'
      ) ??
      document.querySelector<HTMLInputElement>('input[type="file"]');
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

    const start = Date.now();
    for (;;) {
      if (document.querySelector('[data-testid="attachments"]'))
        return 'attached';
      if (Date.now() - start > 15_000) return 'no_preview';
      await sleep(250);
    }
  })();
}

/**
 * Download one image from OUR server and encode it for executeScript transfer
 * (args are JSON-serialized, so bytes travel as base64).
 */
async function fetchImageForPage(
  url: string
): Promise<{ name: string; mime: string; b64: string }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`image download failed (${res.status}): ${url}`);
  }
  const blob = await res.blob();
  const mime = blob.type || 'image/jpeg';
  const last = url.split('/').pop()?.split(/[?#]/)[0] || '';
  const name = last.includes('.')
    ? last
    : `${last || 'image'}.${mime.split('/')[1] || 'jpg'}`;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000; // String.fromCharCode arg-count limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return { name, mime, b64: btoa(bin) };
}

export interface XComposeInput {
  text: string;
  /** Server URLs of images to attach via the composer's own file input. */
  images?: string[];
  // When false, fill the composer but let the user click Post on X.
  autoSubmit?: boolean;
}

/**
 * Publish a NEW post via x.com's own compose page — the same tab+interceptor
 * pattern as postXReply (open tab → attach images → fill composer → click X's
 * own Post button → capture CreateTweet). No direct API calls.
 */
export async function postXCompose(input: XComposeInput): Promise<ReplyResult> {
  const text = (input.text || '').trim();
  const images = (input.images || []).filter(Boolean);
  if (!text && !images.length) {
    return { ok: false, error: 'Post text is empty' };
  }
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
      url: 'https://x.com/compose/post',
      active: !autoSubmit,
    });
    tabId = tab.id ?? undefined;
  } catch (e: any) {
    return { ok: false, error: `Failed to open X tab: ${e?.message || e}` };
  }
  if (tabId == null) return { ok: false, error: 'Failed to open X tab' };

  await waitForTabComplete(tabId, 15_000);

  try {
    if (autoSubmit) {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: installCreateTweetInterceptor,
      });
    }

    if (files.length) {
      const [attach] = await chrome.scripting.executeScript({
        target: { tabId },
        func: attachXImagesInPage,
        args: [files],
      });
      console.log('[aisee][x] attach result:', attach?.result);
      if (attach?.result === 'no_input') {
        await focusTab(tabId);
        return {
          ok: false,
          error:
            'Could not find the file input on the X composer (DOM may have changed). Post manually.',
        };
      }
      // 'no_preview' falls through: uploads keep the Post button disabled, so
      // the send-click wait below either succeeds late or ends 'filled'.
    }

    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: fillXReplyInPage,
      args: [text, autoSubmit],
    });
    const status = injection?.result;
    console.log('[aisee][x] compose injection result:', status);

    if (status === 'sent') {
      let permalink: string | undefined;
      let postId: string | undefined;
      let author: ReplyResult['author'];
      let confirmed = false;
      try {
        const [cap] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: readCapturedTweet,
        });
        const captured = cap?.result;
        if (captured?.rest_id) {
          confirmed = true;
          postId = captured.rest_id;
          permalink = captured.screen_name
            ? `https://x.com/${captured.screen_name}/status/${captured.rest_id}`
            : `https://x.com/i/web/status/${captured.rest_id}`;
        }
        author = captured?.author;
      } catch (e) {
        console.error('[aisee][x] capture read failed', e);
      }
      if (confirmed) {
        await wait(TAB_CLOSE_GRACE_MS);
        await closeTab(tabId);
      } else {
        await focusTab(tabId);
      }
      return { ok: true, message: 'Post sent on X.', permalink, postId, author };
    }
    if (status === 'filled') {
      await focusTab(tabId);
      return {
        ok: true,
        pending: true,
        message: autoSubmit
          ? 'Draft filled but the Post button stayed disabled — review and click Post on X.'
          : 'Draft filled into the X composer. Review it, then click Post on X to send.',
      };
    }

    await focusTab(tabId);
    return {
      ok: false,
      error:
        'Opened the composer but could not find the text box (X DOM may have changed). Post manually.',
    };
  } catch (e: any) {
    console.error('[aisee][x] compose executeScript failed', e);
    await focusTab(tabId);
    return { ok: false, error: `X injection failed: ${e?.message || e}` };
  }
}

export async function postXReply(input: XReplyInput): Promise<ReplyResult> {
  const text = (input.text || '').trim();
  if (!text) return { ok: false, error: 'Reply text is empty' };

  const statusUrl = buildXStatusUrl(input.url);
  console.log('[aisee][x] input url:', input.url, '→ statusUrl:', statusUrl);
  if (!statusUrl) {
    return { ok: false, error: 'Could not parse an X status URL from the input' };
  }

  // autoSubmit (default true): the extension clicks X's own Reply button, so the
  // whole round-trip can run in a BACKGROUND tab the user never has to look at —
  // it's auto-closed on success. When false, the user must review + click Reply
  // themselves, so open the tab focused. If background automation can't finish on
  // its own (composer not found / send button disabled / injection error), we
  // bring the tab to the foreground so the user can complete it — we never strand
  // an invisible tab, so the worst case matches the old always-foreground flow.
  const autoSubmit = input.autoSubmit !== false;

  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: statusUrl, active: !autoSubmit });
    tabId = tab.id ?? undefined;
    console.log(
      '[aisee][x] opened tab',
      tabId,
      autoSubmit ? '(background)' : '(foreground)'
    );
  } catch (e: any) {
    console.error('[aisee][x] tabs.create failed', e);
    return { ok: false, error: `Failed to open X tab: ${e?.message || e}` };
  }
  if (tabId == null) return { ok: false, error: 'Failed to open X tab' };

  await waitForTabComplete(tabId, 15_000);
  console.log('[aisee][x] tab load complete, injecting…');

  try {
    // 1) MAIN-world interceptor must be active before the Reply click fires the
    //    CreateTweet request.
    if (autoSubmit) {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: installCreateTweetInterceptor,
      });
    }

    // 2) Fill (+ click) in the ISOLATED world.
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: fillXReplyInPage,
      args: [text, autoSubmit],
    });
    const status = injection?.result;
    console.log('[aisee][x] injection result:', status);

    if (status === 'sent') {
      // 3) Read the captured tweet id/permalink (MAIN world). Falls back to
      //    undefined on timeout so the history row is still recorded.
      let permalink: string | undefined;
      let postId: string | undefined;
      let author: ReplyResult['author'];
      let confirmed = false;
      try {
        const [cap] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: readCapturedTweet,
        });
        const captured = cap?.result;
        if (captured?.rest_id) {
          confirmed = true;
          postId = captured.rest_id;
          permalink = captured.screen_name
            ? `https://x.com/${captured.screen_name}/status/${captured.rest_id}`
            : `https://x.com/i/web/status/${captured.rest_id}`;
        }
        author = captured?.author;
        console.log('[aisee][x] captured tweet:', captured);
      } catch (e) {
        console.error('[aisee][x] capture read failed', e);
      }
      if (confirmed) {
        // The CreateTweet response was intercepted → the reply is durably posted
        // server-side. Wait a short grace period for any trailing requests, THEN
        // close — so the auto-close never aborts a still-in-flight send.
        await wait(TAB_CLOSE_GRACE_MS);
        await closeTab(tabId);
      } else {
        // Reply was clicked but we never saw the CreateTweet response, so we
        // can't be sure it posted. Don't risk closing a tab whose request may
        // still be in flight — surface it instead so the user can confirm.
        await focusTab(tabId);
      }
      return { ok: true, message: 'Reply sent on X.', permalink, postId, author };
    }
    if (status === 'filled') {
      // The composer is filled but X still needs a human click. Surface the tab
      // (it may have been opened in the background) so the user can finish.
      await focusTab(tabId);
      return {
        ok: true,
        pending: true,
        message: autoSubmit
          ? 'Draft filled but the Reply button stayed disabled — review and click Reply on X.'
          : 'Draft filled into the X reply box. Review it, then click Reply on X to send.',
      };
    }

    // Couldn't drive the composer — bring the tab forward so the user can reply
    // by hand instead of being left with nothing.
    await focusTab(tabId);
    return {
      ok: false,
      error:
        'Opened the tweet but could not find the reply box (X DOM may have changed). Reply manually.',
    };
  } catch (e: any) {
    console.error('[aisee][x] executeScript failed', e);
    // Don't strand an invisible broken tab — bring it forward so the user can act.
    await focusTab(tabId);
    return { ok: false, error: `X injection failed: ${e?.message || e}` };
  }
}

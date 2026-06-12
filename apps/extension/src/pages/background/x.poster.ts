// In-browser X reply (Option A): open the tweet in a tab and inject the draft
// into X's native reply composer via chrome.scripting.executeScript.
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

export async function postXReply(input: XReplyInput): Promise<ReplyResult> {
  const text = (input.text || '').trim();
  if (!text) return { ok: false, error: 'Reply text is empty' };

  const statusUrl = buildXStatusUrl(input.url);
  console.log('[aisee][x] input url:', input.url, '→ statusUrl:', statusUrl);
  if (!statusUrl) {
    return { ok: false, error: 'Could not parse an X status URL from the input' };
  }

  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: statusUrl, active: true });
    tabId = tab.id ?? undefined;
    console.log('[aisee][x] opened tab', tabId);
  } catch (e: any) {
    console.error('[aisee][x] tabs.create failed', e);
    return { ok: false, error: `Failed to open X tab: ${e?.message || e}` };
  }
  if (tabId == null) return { ok: false, error: 'Failed to open X tab' };

  await waitForTabComplete(tabId, 15_000);
  console.log('[aisee][x] tab load complete, injecting…');

  const autoSubmit = input.autoSubmit !== false;

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
      try {
        const [cap] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: readCapturedTweet,
        });
        const captured = cap?.result;
        if (captured?.rest_id) {
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
      return { ok: true, message: 'Reply sent on X.', permalink, postId, author };
    }
    if (status === 'filled') {
      return {
        ok: true,
        pending: true,
        message: autoSubmit
          ? 'Draft filled but the Reply button stayed disabled — review and click Reply on X.'
          : 'Draft filled into the X reply box. Review it, then click Reply on X to send.',
      };
    }

    return {
      ok: false,
      error:
        'Opened the tweet but could not find the reply box (X DOM may have changed). Reply manually.',
    };
  } catch (e: any) {
    console.error('[aisee][x] executeScript failed', e);
    return { ok: false, error: `X injection failed: ${e?.message || e}` };
  }
}

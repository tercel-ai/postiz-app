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
 * self-contained, no outer-scope references). Opens the reply composer if
 * needed, waits for it, and inserts the draft text. Returns true on success.
 */
function fillXReplyInPage(text: string): Promise<boolean> {
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

  const waitFor = (
    find: () => HTMLElement | null,
    timeoutMs: number
  ): Promise<HTMLElement | null> => {
    const existing = find();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeoutMs);
      const observer = new MutationObserver(() => {
        const el = find();
        if (!el) return;
        window.clearTimeout(timeout);
        observer.disconnect();
        resolve(el);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  };

  return (async () => {
    if (!findComposer()) {
      const replyButton =
        document.querySelector<HTMLElement>('[data-testid="reply"]') ??
        document.querySelector<HTMLElement>('button[aria-label*="Reply"]');
      replyButton?.click();
    }

    const composer = await waitFor(findComposer, 10_000);
    if (!composer) return false;

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
    return true;
  })();
}

export async function postXReply(input: XReplyInput): Promise<ReplyResult> {
  const text = (input.text || '').trim();
  if (!text) return { ok: false, error: 'Reply text is empty' };

  const statusUrl = buildXStatusUrl(input.url);
  if (!statusUrl) {
    return { ok: false, error: 'Could not parse an X status URL from the input' };
  }

  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: statusUrl, active: true });
    tabId = tab.id ?? undefined;
  } catch (e: any) {
    return { ok: false, error: `Failed to open X tab: ${e?.message || e}` };
  }
  if (tabId == null) return { ok: false, error: 'Failed to open X tab' };

  await waitForTabComplete(tabId, 15_000);

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: fillXReplyInPage,
      args: [text],
    });

    if (injection?.result) {
      return {
        ok: true,
        pending: true,
        message:
          'Draft filled into the X reply box. Review it, then click Reply on X to send.',
      };
    }

    return {
      ok: false,
      error:
        'Opened the tweet but could not find the reply box (X DOM may have changed). Reply manually.',
    };
  } catch (e: any) {
    return { ok: false, error: `X injection failed: ${e?.message || e}` };
  }
}

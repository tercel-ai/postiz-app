import { fetchStorage } from '@gitroom/extension/utils/load.storage';
import { saveStorage } from '@gitroom/extension/utils/save.storage';

export const BROWSER_ASSISTED_TASK_STORAGE_KEY =
  'postiz:pending-browser-assisted-task';

export interface BrowserAssistedReplyTask {
  platform: 'x';
  type: 'reply';
  opportunityId: string;
  externalPostUrl: string;
  draftContent: string;
  createdAt: number;
}

interface PostizExtensionTaskMessage {
  source: 'postiz';
  action: 'postiz:extension-task';
  task: Omit<BrowserAssistedReplyTask, 'createdAt'>;
}

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.trim().length > 0;
};

export function isPostizExtensionTaskMessage(
  value: unknown
): value is PostizExtensionTaskMessage {
  if (!isObject(value)) return false;
  if (value.source !== 'postiz') return false;
  if (value.action !== 'postiz:extension-task') return false;
  if (!isObject(value.task)) return false;

  return (
    value.task.platform === 'x' &&
    value.task.type === 'reply' &&
    isNonEmptyString(value.task.opportunityId) &&
    isNonEmptyString(value.task.externalPostUrl) &&
    isNonEmptyString(value.task.draftContent)
  );
}

export function createExtensionTaskFromMessage(
  value: unknown
): BrowserAssistedReplyTask | null {
  if (!isPostizExtensionTaskMessage(value)) return null;

  return {
    platform: value.task.platform,
    type: value.task.type,
    opportunityId: value.task.opportunityId,
    externalPostUrl: value.task.externalPostUrl,
    draftContent: value.task.draftContent,
    createdAt: Date.now(),
  };
}

export function buildXReplyUrl(url: string): string | null {
  const parsed = parseUrl(url);
  if (!parsed) return null;

  const statusMatch =
    parsed.pathname.match(/^\/([^/]+)\/status(?:es)?\/(\d+)/) ??
    parsed.pathname.match(/^\/i\/web\/status\/(\d+)/);
  if (!statusMatch) return null;

  if (statusMatch.length === 3) {
    return `https://x.com/${statusMatch[1]}/status/${statusMatch[2]}`;
  }

  return `https://x.com/i/web/status/${statusMatch[1]}`;
}

export function findXReplyComposer(root: ParentNode = document): HTMLElement | null {
  return (
    root.querySelector<HTMLElement>(
      '[data-testid="tweetTextarea_0"][contenteditable="true"]'
    ) ??
    root.querySelector<HTMLElement>(
      '[data-testid^="tweetTextarea_"][contenteditable="true"]'
    ) ??
    root.querySelector<HTMLElement>(
      'div[role="textbox"][contenteditable="true"]'
    )
  );
}

export function fillContentEditable(element: HTMLElement, text: string): boolean {
  if (!element || !text) return false;

  element.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);

  const inserted = document.execCommand?.('insertText', false, text) ?? false;
  if (!inserted) {
    element.textContent = text;
  }

  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  return true;
}

export function installBrowserAssistedReplyBridge() {
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;

    const task = createExtensionTaskFromMessage(event.data);
    if (!task) return;

    const targetUrl = buildXReplyUrl(task.externalPostUrl);
    if (!targetUrl) return;

    await saveStorage(BROWSER_ASSISTED_TASK_STORAGE_KEY, {
      ...task,
      externalPostUrl: targetUrl,
    });
    chrome.runtime.sendMessage({ action: 'openTab', url: targetUrl });
  });
}

export function installXBrowserAssistedReplyRunner() {
  if (!isXHost(window.location.hostname)) return;

  void runPendingXReplyTask();
}

async function runPendingXReplyTask() {
  const task = (await fetchStorage(
    BROWSER_ASSISTED_TASK_STORAGE_KEY
  )) as BrowserAssistedReplyTask | null;
  if (!task || task.platform !== 'x' || task.type !== 'reply') return;

  const targetUrl = buildXReplyUrl(task.externalPostUrl);
  const currentUrl = buildXReplyUrl(window.location.href);
  if (!targetUrl || targetUrl !== currentUrl) return;

  await ensureReplyComposerOpen();
  const composer = await waitForElement(() => findXReplyComposer(document), 10_000);
  if (!composer) return;

  fillContentEditable(composer, task.draftContent);
  await saveStorage(BROWSER_ASSISTED_TASK_STORAGE_KEY, null);
}

async function ensureReplyComposerOpen() {
  if (findXReplyComposer(document)) return;

  const replyButton =
    document.querySelector<HTMLElement>('[data-testid="reply"]') ??
    document.querySelector<HTMLElement>('button[aria-label*="Reply"]');
  replyButton?.click();
}

function parseUrl(url: string): URL | null {
  const trimmed = url.trim();
  try {
    return new URL(trimmed);
  } catch {
    try {
      return new URL(`https://${trimmed}`);
    } catch {
      return null;
    }
  }
}

function isXHost(hostname: string) {
  return hostname === 'x.com' || hostname.endsWith('.x.com') ||
    hostname === 'twitter.com' || hostname.endsWith('.twitter.com');
}

async function waitForElement<T>(
  find: () => T | null,
  timeoutMs: number
): Promise<T | null> {
  const existing = find();
  if (existing) return existing;

  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);

    const observer = new MutationObserver(() => {
      const element = find();
      if (!element) return;
      window.clearTimeout(timeout);
      observer.disconnect();
      resolve(element);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  });
}

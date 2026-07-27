// In-browser Quora publishing. Quora has NO public write API, so — like X /
// LinkedIn / Medium — the extension drives quora.com in a real tab with the
// user's OWN session, opens Quora's native "Post" composer, fills it and best-
// effort clicks Quora's own Post button. Quora is a heavily risk-controlled SPA
// with unstable internals, so the selectors are defensive and every path falls
// back to surfacing the tab for the user to finish (never a silent failure,
// never a direct API call).
//
// A Quora feed/space Post is a single text body — no title, no native thread
// continuation — so only segment 0 is published (SINGLE_SEGMENT_PLATFORMS).

import { ReplyResult } from '@gitroom/extension/utils/reply.types';
import {
  closeTab,
  focusTab,
  getTabUrl,
  openTab,
  runInPage,
  sleep,
} from '@gitroom/extension/utils/tab-automation';

const QUORA_HOME = 'https://www.quora.com/';
const RENDER_SETTLE_MS = 3_000;
const TAB_CLOSE_GRACE_MS = 1_500;

export interface QuoraPostInput {
  /** Text body of the post (segment[0].text). */
  text: string;
  /**
   * When false, open+fill the composer but let the user click Post. Defaults to
   * true: the extension drives Quora's own Post flow.
   */
  autoSubmit?: boolean;
}

// ── In-page injected functions (self-contained — no outer-scope refs) ─────────

/** True when quora.com bounced us to a login wall (user not signed in). */
function quoraDetectLogin(): boolean {
  if (/\/login\b/i.test(location.href)) return true;
  // The logged-out home renders a login form and NO composer trigger.
  const hasLoginForm = !!document.querySelector('input[type="password"]');
  return hasLoginForm;
}

/**
 * Open Quora's Post composer, fill the body, and (when autoSubmit) click Post.
 * Returns the outcome; 'no_composer' when the composer couldn't be opened.
 */
function quoraComposeInPage(
  text: string,
  autoSubmit: boolean
): Promise<'posted' | 'filled' | 'no_composer'> {
  const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const byText = (
    selector: string,
    re: RegExp
  ): HTMLElement | null =>
    Array.from(document.querySelectorAll<HTMLElement>(selector)).find((el) =>
      re.test((el.textContent || '').trim())
    ) || null;

  const findEditor = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(
      '[contenteditable="true"][role="textbox"]'
    ) || document.querySelector<HTMLElement>('.doc[contenteditable="true"]') ||
    document.querySelector<HTMLElement>('[contenteditable="true"]');

  const waitFor = async (
    find: () => HTMLElement | null,
    timeoutMs: number
  ): Promise<HTMLElement | null> => {
    const start = Date.now();
    for (;;) {
      const el = find();
      if (el) return el;
      if (Date.now() - start > timeoutMs) return null;
      await sleepMs(150);
    }
  };

  return (async () => {
    // 1) Open the composer. Quora's top bar shows an "Add"/"Post" trigger; the
    //    exact control varies, so try a few by role + visible text.
    if (!findEditor()) {
      const trigger =
        byText('button, div[role="button"]', /^post$/i) ||
        byText('button, div[role="button"]', /ask or share|what do you want/i) ||
        document.querySelector<HTMLElement>('[aria-label*="Post" i]');
      trigger?.click();
      await sleepMs(400);
      // A dialog may offer a "Post" tab (vs "Add question") — pick it.
      const postTab = byText(
        '[role="dialog"] button, [role="tablist"] button, [role="dialog"] div[role="button"]',
        /^post$/i
      );
      postTab?.click();
    }

    const editor = await waitFor(findEditor, 8_000);
    if (!editor) return 'no_composer';

    // 2) Fill the body via a synthetic paste (keeps multi-line paragraphs).
    editor.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel?.removeAllRanges();
    sel?.addRange(range);
    let filled = false;
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      editor.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        })
      );
      await sleepMs(60);
      filled = (editor.textContent || '').replace(/\s/g, '').length > 0;
    } catch {
      filled = false;
    }
    if (!filled) {
      const inserted = document.execCommand?.('insertText', false, text) ?? false;
      if (!inserted) editor.textContent = text;
      editor.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
      );
    }

    if (!autoSubmit) return 'filled';

    // 3) Click the composer's Post/Submit button once it's enabled.
    const submit = await waitFor(() => {
      const btn =
        byText(
          '[role="dialog"] button, form button, div[role="button"]',
          /^(post|submit|share)$/i
        ) || document.querySelector<HTMLElement>('button[type="submit"]');
      if (!btn) return null;
      const disabled =
        btn.getAttribute('aria-disabled') === 'true' ||
        (btn as HTMLButtonElement).disabled === true;
      return disabled ? null : btn;
    }, 6_000);
    if (!submit) return 'filled';
    submit.click();
    await sleepMs(1_500);
    return 'posted';
  })();
}

// ── Orchestration ─────────────────────────────────────────────────────────────

/** Whether a URL looks like a Quora permalink for a just-created post. */
function isQuoraPermalink(url: string): boolean {
  return /quora\.com\/(profile\/[^/]+\/|[^/]*-)/i.test(url) && !/\/$|quora\.com\/?$/i.test(url);
}

/** Publish a single Quora post (segment 0). */
export async function postQuoraPost(input: QuoraPostInput): Promise<ReplyResult> {
  const text = (input.text || '').trim();
  if (!text) return { ok: false, error: 'Quora post is empty' };
  const autoSubmit = input.autoSubmit !== false;

  const handle = await openTab(QUORA_HOME, {
    active: !autoSubmit,
    settleMs: RENDER_SETTLE_MS,
  });
  if (!handle) return { ok: false, error: 'Failed to open Quora tab' };
  const { tabId } = handle;

  try {
    if (await runInPage(tabId, quoraDetectLogin)) {
      await focusTab(tabId);
      return { ok: false, error: 'Not signed in to Quora — log in, then retry.' };
    }

    const outcome = await runInPage(tabId, quoraComposeInPage, [text, autoSubmit]);
    if (outcome === 'no_composer') {
      await focusTab(tabId);
      return {
        ok: false,
        error:
          'Could not open the Quora composer (Quora markup may have changed). Post manually.',
      };
    }
    if (outcome === 'filled') {
      await focusTab(tabId);
      return {
        ok: true,
        pending: true,
        message: autoSubmit
          ? 'Draft filled but the Quora Post button stayed disabled — review and click Post.'
          : 'Draft filled into the Quora composer. Review it, then click Post.',
      };
    }

    // outcome === 'posted': try to read the resulting permalink from the tab URL
    // (Quora often navigates to the new post). A missing permalink is acceptable
    // on this single-segment platform — the post is still live.
    let permalink: string | undefined;
    for (let i = 0; i < 15; i++) {
      await sleep(300);
      const url = (await getTabUrl(tabId)) || '';
      if (isQuoraPermalink(url)) {
        permalink = url.split(/[?#]/)[0];
        break;
      }
    }
    await sleep(TAB_CLOSE_GRACE_MS);
    await closeTab(tabId);
    return { ok: true, message: 'Posted on Quora.', permalink };
  } catch (e: any) {
    console.error('[aisee][quora] post failed', e);
    await focusTab(tabId);
    return { ok: false, error: `Quora injection failed: ${e?.message || e}` };
  }
}

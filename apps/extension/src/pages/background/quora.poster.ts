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
  /**
   * Profile slug of the account this post is bound to (the Integration's
   * internalId). When set, publishing aborts if the tab turns out to be signed
   * in as someone else.
   *
   * The wrong-account check lives HERE, and not in the shared publish guard,
   * because Quora's identity is only readable from inside a quora.com tab —
   * see quoraReadOwnSlug. Leaving it in the guard would mean opening a tab per
   * publish just to read it; here it costs nothing, since the poster has to
   * open that tab anyway, and it runs one step before the composer instead of
   * minutes earlier in the queue.
   */
  expectedSlug?: string;
}

// ── In-page injected functions (self-contained — no outer-scope refs) ─────────

/**
 * The signed-in account's profile slug, read from INSIDE the tab.
 *
 * `/settings` is fetched from the page's own context deliberately: the very
 * same request from the background worker is answered 403 by Quora's WAF, which
 * sees a cross-site `Sec-Fetch-Site` that JS is not allowed to forge. From the
 * tab it is same-origin and returns 200.
 *
 * The path is `/settings` and nothing deeper. `/settings/account` looks right —
 * the page's own first tab is labelled "Account" — but Quora renders those tabs
 * client-side and 404s the sub-path.
 *
 * That page mentions exactly ONE `/profile/` link: the viewer's own. Anything
 * else (a feed, a logged-out shell) shows other people's, and picking one would
 * confidently identify the wrong person — so more than one distinct match
 * yields undefined, "cannot conclude", never a guess.
 */
async function quoraReadOwnSlug(): Promise<string | undefined> {
  try {
    const res = await fetch('/settings', { credentials: 'include' });
    if (!res.ok) return undefined;
    const html = await res.text();
    const found = [...new Set(html.match(/\/profile\/[A-Za-z0-9-]+/g) || [])];
    if (found.length !== 1) return undefined;
    return found[0].replace('/profile/', '') || undefined;
  } catch {
    return undefined;
  }
}

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

/**
 * Canonical form for comparing two Quora profile slugs.
 *
 * Quora treats its slugs case-insensitively, and an Integration row created
 * before the provider started stripping the prefix may still store
 * `/profile/Jane-Doe`. A false mismatch would block a legitimate post, so both
 * sides are normalized; no two distinct accounts can collapse this way, since
 * the slug itself stays intact.
 */
function normalizeSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\/?profile\//, '');
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

    if (input.expectedSlug) {
      const expected = normalizeSlug(input.expectedSlug);
      const actual = await runInPage(tabId, quoraReadOwnSlug);
      if (!actual) {
        // Fail OPEN, and say so. Publishing as intended is far likelier than a
        // wrong account, so an unreadable identity must not block the post —
        // but a wrong-account publish is irreversible and only ever reported
        // after the fact, so "was the account actually checked?" has to be
        // answerable from the log rather than looking identical to a pass.
        console.warn(
          '[aisee][quora] identity unreadable — publishing unverified',
          { expected }
        );
      } else if (normalizeSlug(actual) !== expected) {
        // The tab is signed in as someone else. Close it: leaving it open
        // invites finishing the post by hand as the WRONG account, which is
        // exactly what this check exists to prevent.
        await closeTab(tabId);
        return {
          ok: false,
          error: `This browser is signed in to Quora as ${actual}, but the post is bound to ${input.expectedSlug}. Switch accounts and it will go out on the next attempt.`,
        };
      }
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

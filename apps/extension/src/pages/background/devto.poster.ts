// In-browser Dev.to publishing. Unlike the other article platforms here,
// dev.to DOES have a working write API — and the backend's DevToProvider still
// uses it. This path exists alongside it, not instead of it: an API channel is
// bound by an api-key at "add channel" time, while this publishes with the
// user's own browser session, so someone who never generated a dev.to api-key
// can still publish. Medium, Quora and Hacker News already work exactly this
// way (customFields channel on the backend + in-browser publishing); dev.to was
// the lone exception. `Post.publishMethod` picks the route, once, per post.
//
// The editor at /new is far friendlier than Medium's or LinkedIn's: Forem
// server-renders plain <textarea> fields with stable Rails ids, no
// contenteditable and no shadow DOM (confirmed against a live signed-in
// session). Filling them is a native value set + `input` event so Preact's
// state follows — verified live: the values survive a re-render and Forem's own
// "Revert new changes" control appears, which it only does once the component
// (not merely the DOM) has seen the change.
//
//   title  → #article-form-title      <textarea>
//   body   → #article_body_markdown   <textarea name="body_markdown">
//   cover  → #cover-image-input       <input type="file">
//   submit → the form's own "Publish" button
//
// Images take two routes, each the platform's native one: the body IS markdown,
// so body images are embedded as `![](url)` with no upload UI involved at all,
// while the cover can only be a file upload in the v2 editor. Note the backend
// API path hotlinks its cover the same way (`main_image` is a URL), and Forem
// proxies remote images through its own media CDN either way.
//
// Dev.to articles have no native thread, so only segment 0 is ever published
// here (enforced by SINGLE_SEGMENT_PLATFORMS at enqueue).

import { ReplyResult } from '@gitroom/extension/utils/reply.types';
import { fetchImageForPage } from '@gitroom/extension/pages/background/x.poster';
import {
  closeTab,
  focusTab,
  getTabUrl,
  openTab,
  runInPage,
  sleep,
} from '@gitroom/extension/utils/tab-automation';

const DEVTO_NEW = 'https://dev.to/new';
// Forem server-renders the editor, so it needs far less settle time than
// Medium's client-hydrated one.
const RENDER_SETTLE_MS = 1_200;
const TAB_CLOSE_GRACE_MS = 1_500;

export interface DevtoArticleInput {
  title: string;
  /** Markdown body of the article (segment[0].text). */
  text: string;
  /**
   * Server URLs of images. The FIRST becomes the article's cover (uploaded
   * through the editor's file input, the only way v2 accepts one); the rest are
   * appended to the body as markdown, which is dev.to's own native mechanism.
   */
  images?: string[];
  /**
   * Topic tags (names, no `#`), max 4 — dev.to's distribution runs through tag
   * feeds, so these are load-bearing, not decoration.
   */
  tags?: string[];
  /**
   * Numeric dev.to account id this post must publish as. Checked INSIDE the
   * tab, mirroring quora.poster's expectedSlug: dev.to's signed-in identity
   * lives in a `data-user` attribute Forem renders onto <body>, unreadable from
   * the service worker, and this tab is open anyway. It is the same numeric id
   * DevToProvider stores as Integration.internalId (both come from dev.to's own
   * user record), so the two are directly comparable.
   */
  expectedUserId?: string;
  /** When false, fill the editor but leave Publish to the user. */
  autoSubmit?: boolean;
}

// ── In-page injected functions (self-contained — no outer-scope refs) ────────

/** The signed-in account, straight off Forem's server-rendered <body>. */
function devtoReadSessionInPage(): {
  loggedIn: boolean;
  id?: string;
  handle?: string;
} {
  const body = document.body;
  if (!body || body.getAttribute('data-user-status') !== 'logged-in') {
    return { loggedIn: false };
  }
  try {
    const raw = body.getAttribute('data-user');
    if (!raw) return { loggedIn: true };
    const u = JSON.parse(raw);
    return {
      loggedIn: true,
      id: u?.id != null ? String(u.id) : undefined,
      handle: u?.username || undefined,
    };
  } catch {
    return { loggedIn: true };
  }
}

/**
 * Fill the two editor textareas. Uses the native value setter plus an `input`
 * event: assigning `.value` alone would update the DOM while leaving Preact's
 * state stale, and the next re-render would silently wipe it.
 */
function devtoFillEditorInPage(
  title: string,
  body: string
): 'filled' | 'no_editor' {
  const setNative = (el: HTMLTextAreaElement, text: string) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    el.focus();
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const titleEl = document.getElementById(
    'article-form-title'
  ) as HTMLTextAreaElement | null;
  const bodyEl = document.getElementById(
    'article_body_markdown'
  ) as HTMLTextAreaElement | null;
  if (!titleEl || !bodyEl) return 'no_editor';

  setNative(titleEl, title);
  setNative(bodyEl, body);
  return titleEl.value === title && bodyEl.value === body
    ? 'filled'
    : 'no_editor';
}

/**
 * Hand the cover image to the editor's own file input, exactly like a user
 * picking a file, so Forem runs its own upload pipeline. The input already
 * exists in the DOM (merely visually hidden) — no "add media" click and no
 * shadow root, unlike LinkedIn.
 *
 * Returns 'unconfirmed' rather than failing when no preview appears: a cover is
 * not worth stranding the article over. The caller publishes anyway.
 */
function devtoAttachCoverInPage(file: {
  name: string;
  mime: string;
  b64: string;
}): Promise<'attached' | 'no_input' | 'unconfirmed'> {
  const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return (async () => {
    // Re-query EVERY time rather than holding the node. Forem REPLACES the
    // cover input once its upload finishes (confirmed live: the original node
    // reports document.contains() === false afterwards), so a held reference
    // goes stale and `closest('div')` then walks a detached tree that can never
    // show the post-upload controls — the poll would burn its whole budget and
    // report a false 'unconfirmed' on every cover.
    const coverArea = (): HTMLElement | null =>
      document.getElementById('cover-image-input')?.closest('div') ?? null;
    // Forem swaps "Add a cover image" for Change/Remove controls once the
    // upload lands — the only reliable done-signal (the preview is a background
    // image, not an <img>).
    const uploaded = () =>
      Array.from(coverArea()?.querySelectorAll('button') || []).some((b) =>
        /^(remove|change)$/i.test((b.innerText || '').trim())
      );

    const input = document.getElementById(
      'cover-image-input'
    ) as HTMLInputElement | null;
    if (!input) return 'no_input';

    const bin = atob(file.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], file.name, { type: file.mime }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // ~2s observed for a 1000x420 PNG; 20s leaves room for a slow upload
    // without stalling the publish for long when something is wrong.
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      await sleepMs(300);
      if (uploaded()) return 'attached';
    }
    return 'unconfirmed';
  })();
}

/**
 * Add topic tags through Forem's own autocomplete.
 *
 * Every step here was established against the live widget, because the obvious
 * guesses are all wrong:
 *   - Enter does NOT commit. Neither does a trailing comma. Both leave the raw
 *     text sitting in the input and nothing selected.
 *   - `option.click()` does NOT commit either. The handler runs on MOUSEDOWN
 *     (an autocomplete has to act before the input blurs), so the pointer/mouse
 *     down pair is what actually selects.
 *   - A tag that does not exist on dev.to takes the SAME path: Forem offers the
 *     typed text itself as a creatable option whose `id` is that text, so known
 *     and novel tags need no separate branch.
 *
 * Committed tags land in `#combo-selected` as `div[role=group][aria-label=<tag>]`,
 * which is also the read-back the caller verifies against.
 */
function devtoAddTagsInPage(tags: string[]): Promise<string[]> {
  const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return (async () => {
    const input = document.getElementById(
      'tag-input'
    ) as HTMLInputElement | null;
    if (!input) return [];

    const setNative = (el: HTMLInputElement, text: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set;
      el.focus();
      if (setter) setter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const selected = () =>
      Array.from(
        document.querySelectorAll('#combo-selected div[role="group"]')
      )
        .map((d) => d.getAttribute('aria-label') || '')
        .filter(Boolean);

    for (const tag of tags) {
      if (selected().length >= 4) break; // dev.to's own ceiling
      setNative(input, '');
      await sleepMs(150);
      setNative(input, tag);

      // Wait for the popover to offer this exact tag (existing or creatable).
      let option: HTMLElement | null = null;
      for (let i = 0; i < 20; i++) {
        await sleepMs(200);
        option = document.querySelector<HTMLElement>(
          `#listbox1 li[role="option"][id="${CSS.escape(tag)}"]`
        );
        if (option) break;
      }
      if (!option) continue; // unofferable tag — skip it, never fail the post

      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        option.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            button: 0,
          })
        );
      }
      await sleepMs(400);
    }

    setNative(input, '');
    return selected();
  })();
}

/** Click the editor form's own Publish button. */
function devtoClickPublishInPage(): 'clicked' | 'no_button' {
  const form = document.getElementById('article-form');
  const scope: ParentNode = form || document;
  const publish = Array.from(scope.querySelectorAll('button')).find(
    (b) => (b.innerText || '').trim() === 'Publish'
  ) as HTMLButtonElement | undefined;
  if (!publish || publish.disabled) return 'no_button';
  publish.click();
  return 'clicked';
}

// ── Orchestration (service-worker side) ─────────────────────────────────────

/**
 * A published dev.to article lives at /<username>/<slug>. Anything still on
 * /new (or on a Forem system path) means we have not landed on the article yet.
 */
export function isPublishedDevtoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/(^|\.)dev\.to$/.test(u.hostname)) return false;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return false;
    return !['new', 'enter', 'settings', 'dashboard'].includes(parts[0]);
  } catch {
    return false;
  }
}

/** Append the non-cover images to the markdown body, dev.to's native way. */
function withBodyImages(body: string, images: string[]): string {
  if (!images.length) return body;
  const embeds = images.map((url) => `![](${url})`).join('\n\n');
  return `${body}\n\n${embeds}`;
}

export async function postDevtoArticle(
  input: DevtoArticleInput
): Promise<ReplyResult> {
  const title = (input.title || '').trim();
  if (!title) return { ok: false, error: 'Dev.to article needs a title' };
  const autoSubmit = input.autoSubmit !== false;

  const images = (input.images || []).filter(Boolean);
  const [coverUrl, ...bodyImages] = images;
  const body = withBodyImages((input.text || '').trim(), bodyImages);
  if (!body) return { ok: false, error: 'Dev.to article body is empty' };

  // Download the cover before opening the tab — a fetch failure should not
  // leave an editor tab behind. A cover that cannot be downloaded is dropped,
  // never fatal: the article is the text.
  let cover: { name: string; mime: string; b64: string } | undefined;
  if (coverUrl) {
    try {
      cover = await fetchImageForPage(coverUrl);
    } catch (e) {
      console.warn('[aisee][devto] cover download failed, publishing without it', e);
    }
  }

  const handle = await openTab(DEVTO_NEW, {
    active: !autoSubmit,
    settleMs: RENDER_SETTLE_MS,
  });
  if (!handle) return { ok: false, error: 'Failed to open the Dev.to tab' };
  const { tabId } = handle;

  try {
    const session = await runInPage(tabId, devtoReadSessionInPage);
    if (!session?.loggedIn) {
      await focusTab(tabId);
      return { ok: false, error: 'Not signed in to Dev.to — log in, then retry.' };
    }

    // Wrong-account guard, in the tab (see expectedUserId). Only a CONFIRMED
    // disagreement blocks: an unreadable id means "cannot conclude", and
    // blocking on that would strand posts over a Forem markup change.
    if (
      input.expectedUserId &&
      session.id &&
      session.id !== String(input.expectedUserId)
    ) {
      await focusTab(tabId);
      return {
        ok: false,
        error: `This browser is signed in to Dev.to as ${
          session.handle ? `@${session.handle}` : `user ${session.id}`
        }, but the post publishes as account ${input.expectedUserId} — switch accounts and it will go out on the next attempt.`,
      };
    }

    if (cover) {
      const attached = await runInPage(tabId, devtoAttachCoverInPage, [cover]);
      if (attached !== 'attached') {
        console.warn('[aisee][devto] cover not confirmed', attached);
      }
    }

    const fill = await runInPage(tabId, devtoFillEditorInPage, [title, body]);
    if (fill !== 'filled') {
      await focusTab(tabId);
      return {
        ok: false,
        error:
          'Could not find the Dev.to editor fields (Forem markup may have changed). Publish manually.',
      };
    }

    // Tags go in AFTER the body: the autocomplete steals focus and Forem's
    // editor is happier being filled top-down. A tag the widget refuses is
    // logged and skipped — an under-tagged article still beats one stuck in
    // QUEUE, the same call made for images.
    const wantTags = (input.tags || []).slice(0, 4);
    if (wantTags.length) {
      const added = await runInPage(tabId, devtoAddTagsInPage, [wantTags]);
      const missing = wantTags.filter((t) => !(added || []).includes(t));
      if (missing.length) {
        console.warn('[aisee][devto] tags not applied', missing);
      }
    }

    if (!autoSubmit) {
      await focusTab(tabId);
      return {
        ok: true,
        pending: true,
        message:
          'Draft filled into the Dev.to editor. Review it, then click Publish.',
      };
    }

    const clicked = await runInPage(tabId, devtoClickPublishInPage);
    if (clicked === 'clicked') {
      // Forem navigates to the published article on success — read the URL back.
      let permalink: string | undefined;
      for (let i = 0; i < 25; i++) {
        await sleep(300);
        const url = (await getTabUrl(tabId)) || '';
        if (isPublishedDevtoUrl(url)) {
          permalink = url.split(/[?#]/)[0];
          break;
        }
      }
      if (permalink) {
        await sleep(TAB_CLOSE_GRACE_MS);
        await closeTab(tabId);
        return {
          ok: true,
          message: 'Published on Dev.to.',
          permalink,
          ...(session.handle
            ? {
                author: {
                  handle: session.handle,
                  ...(session.id ? { id: session.id } : {}),
                },
              }
            : {}),
        };
      }
    }

    // Filled and clicked but publication unconfirmed — surface the tab rather
    // than report a success we cannot see.
    await focusTab(tabId);
    return {
      ok: true,
      pending: true,
      message:
        'Dev.to article filled and Publish clicked, but publication was not confirmed — verify in the opened tab.',
    };
  } catch (e: any) {
    console.error('[aisee][devto] publish failed', e);
    await focusTab(tabId);
    return { ok: false, error: `Dev.to injection failed: ${e?.message || e}` };
  }
}

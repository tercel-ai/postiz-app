import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tab layer is the only thing standing between this poster and a live
// browser, so it is stubbed wholesale and the injected functions are dispatched
// by name — that keeps the assertions about WHICH page step ran, which is the
// whole point of these tests. Typing itself now goes through chrome.debugger
// (cdp-typing.ts), stubbed separately so these tests never touch a real
// chrome.debugger global.
const openTab = vi.fn();
const runInPage = vi.fn();
const closeTab = vi.fn();
const focusTab = vi.fn();
const getTabUrl = vi.fn();

const attachDebugger = vi.fn();
const detachDebugger = vi.fn();
const cdpTypeText = vi.fn();

vi.mock('@gitroom/extension/utils/tab-automation', () => ({
  openTab: (...a: any[]) => openTab(...a),
  runInPage: (...a: any[]) => runInPage(...a),
  closeTab: (...a: any[]) => closeTab(...a),
  focusTab: (...a: any[]) => focusTab(...a),
  getTabUrl: (...a: any[]) => getTabUrl(...a),
  sleep: async (): Promise<void> => undefined,
}));

vi.mock('@gitroom/extension/utils/cdp-typing', () => ({
  attachDebugger: (...a: any[]) => attachDebugger(...a),
  detachDebugger: (...a: any[]) => detachDebugger(...a),
  cdpTypeText: (...a: any[]) => cdpTypeText(...a),
}));

import { postMediumStory } from '../medium.poster';

/** Names of the in-page functions, in the order the poster runs them. */
const ran = () => runInPage.mock.calls.map(([, fn]) => (fn as any).name);

const EDITOR_URL = 'https://medium.com/new-story';
const PREVIEW_URL =
  'https://medium.com/p/02fbb1fcb271/submission?redirectUrl=https%3A%2F%2Fmedium.com';
const PUBLISHED_URL = 'https://medium.com/@tercel/some-title-abc123def456';

function stubPage(opts: {
  authWall?: boolean;
  titleFocus?: 'ok' | 'no_editor';
  bodyFocus?: 'ok' | 'no_editor' | 'skip';
  publish?: 'clicked' | 'no_button' | null;
  confirm?: 'clicked' | 'no_button' | null;
} = {}) {
  runInPage.mockImplementation(async (_tabId: number, fn: any, args: any[]) => {
    switch (fn.name) {
      case 'mediumDetectAuthWall':
        return opts.authWall ?? false;
      case 'mediumFocusField':
        return args?.[0] === 'title'
          ? opts.titleFocus ?? 'ok'
          : opts.bodyFocus ?? 'ok';
      case 'mediumClickPublish':
        return opts.publish === undefined ? 'clicked' : opts.publish;
      case 'mediumClickConfirmPublish':
        return opts.confirm === undefined ? 'clicked' : opts.confirm;
      default:
        throw new Error(`unexpected in-page function: ${fn.name}`);
    }
  });
}

/**
 * Medium's Publish is a two-page flow: the editor NAVIGATES to a "Story
 * preview" page, and only its own confirm button publishes. Model that here —
 * the tab reports the published URL only once the confirm click has run.
 */
function stubPublishNavigation() {
  let confirmClicked = false;
  runInPage.mockImplementation(async (_tabId: number, fn: any, args: any[]) => {
    switch (fn.name) {
      case 'mediumDetectAuthWall':
        return false;
      case 'mediumFocusField':
        return 'ok';
      case 'mediumClickPublish':
        return 'clicked';
      case 'mediumClickConfirmPublish':
        confirmClicked = true;
        return 'clicked';
      default:
        throw new Error(`unexpected in-page function: ${fn.name}`);
    }
  });
  getTabUrl.mockImplementation(async () =>
    confirmClicked ? PUBLISHED_URL : EDITOR_URL
  );
  // The editor page hands off to the preview page after the first click.
  getTabUrl.mockImplementationOnce(async () => EDITOR_URL);
  getTabUrl.mockImplementationOnce(async () =>
    confirmClicked ? PUBLISHED_URL : PREVIEW_URL
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  openTab.mockResolvedValue({ tabId: 1 });
  getTabUrl.mockResolvedValue(PUBLISHED_URL);
  attachDebugger.mockResolvedValue(true);
  detachDebugger.mockResolvedValue(undefined);
  cdpTypeText.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('postMediumStory — always opens the tab active', () => {
  it('opens the tab active on the default (auto-submit) path', async () => {
    stubPage();

    await postMediumStory({ title: 'Hello', text: 'World' });

    expect(openTab).toHaveBeenCalledWith(
      'https://medium.com/new-story',
      expect.objectContaining({ active: true })
    );
  });

  it('opens the tab active even when autoSubmit is explicitly false', async () => {
    stubPage();

    await postMediumStory({ title: 'Hello', text: 'World', autoSubmit: false });

    expect(openTab).toHaveBeenCalledWith(
      'https://medium.com/new-story',
      expect.objectContaining({ active: true })
    );
  });
});

describe('postMediumStory — chrome.debugger typing', () => {
  it('attaches the debugger, types title then body via CDP, and detaches afterwards', async () => {
    stubPage();

    await postMediumStory({ title: 'Hello', text: 'World' });

    expect(attachDebugger).toHaveBeenCalledWith(1);
    expect(cdpTypeText).toHaveBeenNthCalledWith(1, 1, 'Hello');
    expect(cdpTypeText).toHaveBeenNthCalledWith(2, 1, 'World');
    expect(detachDebugger).toHaveBeenCalledWith(1);
  });

  it('still detaches the debugger when the fill throws', async () => {
    stubPage();
    cdpTypeText.mockRejectedValueOnce(new Error('boom'));

    const r = await postMediumStory({ title: 'Hello', text: 'World' });

    expect(r.ok).toBe(false);
    expect(detachDebugger).toHaveBeenCalledWith(1);
  });

  it('skips body typing when the editor exposes only a single merged field', async () => {
    stubPage({ bodyFocus: 'skip' });

    const r = await postMediumStory({ title: 'Hello', text: 'World' });

    expect(r.ok).toBe(true);
    expect(cdpTypeText).toHaveBeenCalledTimes(1);
    expect(cdpTypeText).toHaveBeenCalledWith(1, 'Hello');
  });

  it('reports an error without touching the editor when attach fails', async () => {
    stubPage();
    attachDebugger.mockResolvedValueOnce(false);

    const r = await postMediumStory({ title: 'Hello', text: 'World' });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/chrome\.debugger attach failed/i);
    expect(cdpTypeText).not.toHaveBeenCalled();
    expect(ran()).toEqual(['mediumDetectAuthWall']);
  });
});

describe('postMediumStory — happy path', () => {
  it('fills, publishes, and reads back the permalink', async () => {
    stubPage();

    const r = await postMediumStory({ title: 'Hello', text: 'World' });

    expect(r.ok).toBe(true);
    expect(r.permalink).toBe(PUBLISHED_URL);
    expect(ran()).toEqual([
      'mediumDetectAuthWall',
      'mediumFocusField',
      'mediumFocusField',
      'mediumClickPublish',
    ]);
    expect(closeTab).toHaveBeenCalledWith(1);
  });

  it('reports the auth wall before touching the editor', async () => {
    stubPage({ authWall: true });

    const r = await postMediumStory({ title: 'Hello', text: 'World' });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not signed in/i);
    expect(ran()).toEqual(['mediumDetectAuthWall']);
    expect(focusTab).toHaveBeenCalledWith(1);
    expect(attachDebugger).not.toHaveBeenCalled();
  });

  it('surfaces the tab instead of reporting false success when the editor is not found', async () => {
    stubPage({ titleFocus: 'no_editor' });

    const r = await postMediumStory({ title: 'Hello', text: 'World' });

    expect(r.ok).toBe(false);
    expect(focusTab).toHaveBeenCalledWith(1);
    expect(cdpTypeText).not.toHaveBeenCalled();
  });
});

describe('postMediumStory — two-page Publish flow', () => {
  // Regression: clicking Publish NAVIGATES to Medium's "Story preview" page,
  // which tears down the injected script. The confirm click therefore has to be
  // a SECOND injection driven from the worker — when it lived inside the first
  // injected function the story was left sitting unpublished on the preview
  // page while the queue reported "publication was not confirmed".
  it('injects the confirm click into the preview page after the navigation', async () => {
    stubPublishNavigation();

    const r = await postMediumStory({ title: 'Hello', text: 'World' });

    expect(r.ok).toBe(true);
    expect(r.pending).toBeUndefined();
    expect(r.permalink).toBe(PUBLISHED_URL);
    expect(ran()).toEqual([
      'mediumDetectAuthWall',
      'mediumFocusField',
      'mediumFocusField',
      'mediumClickPublish',
      'mediumClickConfirmPublish',
    ]);
    expect(closeTab).toHaveBeenCalledWith(1);
  });

  it('still confirms when the first click tore the frame down before replying', async () => {
    // executeScript rejects (runInPage → null) whenever the navigation beats
    // the result back; that is a landed click, not a missing button.
    stubPage({ publish: null });
    getTabUrl.mockResolvedValueOnce(EDITOR_URL);
    getTabUrl.mockResolvedValueOnce(PREVIEW_URL);

    const r = await postMediumStory({ title: 'Hello', text: 'World' });

    expect(r.ok).toBe(true);
    expect(r.permalink).toBe(PUBLISHED_URL);
    expect(ran()).toContain('mediumClickConfirmPublish');
  });

  it('leaves the tab open and pending when the confirm button never appears', async () => {
    stubPage({ confirm: 'no_button' });
    getTabUrl.mockResolvedValue(PREVIEW_URL);

    const r = await postMediumStory({ title: 'Hello', text: 'World' });

    expect(r.ok).toBe(true);
    expect(r.pending).toBe(true);
    expect(r.message).toMatch(/not confirmed/i);
    expect(focusTab).toHaveBeenCalledWith(1);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('falls back to the canonical /p/<id> permalink from the preview URL', async () => {
    // The preview page is /p/<postId>/submission — the same id that ends the
    // pretty story URL — so a confirmed publish still yields a real permalink
    // when the post-publish redirect never resolves.
    stubPage();
    getTabUrl.mockResolvedValue(PREVIEW_URL);

    const r = await postMediumStory({ title: 'Hello', text: 'World' });

    expect(r.ok).toBe(true);
    expect(r.pending).toBeUndefined();
    expect(r.permalink).toBe('https://medium.com/p/02fbb1fcb271');
  });

  it('does not attempt a confirm click when the editor has no Publish button', async () => {
    stubPage({ publish: 'no_button' });

    const r = await postMediumStory({ title: 'Hello', text: 'World' });

    expect(r.pending).toBe(true);
    expect(ran()).not.toContain('mediumClickConfirmPublish');
  });
});

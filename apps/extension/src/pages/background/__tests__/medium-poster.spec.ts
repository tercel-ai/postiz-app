import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tab layer is the only thing standing between this poster and a live
// browser, so it is stubbed wholesale and the injected functions are dispatched
// by name — that keeps the assertions about WHICH page step ran, which is the
// whole point of these tests.
const openTab = vi.fn();
const runInPage = vi.fn();
const closeTab = vi.fn();
const focusTab = vi.fn();
const getTabUrl = vi.fn();

vi.mock('@gitroom/extension/utils/tab-automation', () => ({
  openTab: (...a: any[]) => openTab(...a),
  runInPage: (...a: any[]) => runInPage(...a),
  closeTab: (...a: any[]) => closeTab(...a),
  focusTab: (...a: any[]) => focusTab(...a),
  getTabUrl: (...a: any[]) => getTabUrl(...a),
  sleep: async (): Promise<void> => undefined,
}));

import { postMediumStory } from '../medium.poster';

/** Names of the in-page functions, in the order the poster runs them. */
const ran = () => runInPage.mock.calls.map(([, fn]) => (fn as any).name);

function stubPage(opts: {
  authWall?: boolean;
  fill?: 'filled' | 'no_editor';
  publish?: 'published' | 'dialog' | 'no_button';
} = {}) {
  runInPage.mockImplementation(async (_tabId: number, fn: any) => {
    switch (fn.name) {
      case 'mediumDetectAuthWall':
        return opts.authWall ?? false;
      case 'mediumFillEditor':
        return opts.fill ?? 'filled';
      case 'mediumClickPublish':
        return opts.publish ?? 'published';
      default:
        throw new Error(`unexpected in-page function: ${fn.name}`);
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  openTab.mockResolvedValue({ tabId: 1 });
  getTabUrl.mockResolvedValue('https://medium.com/@tercel/some-title-abc123def456');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('postMediumStory — background-tab throttling regression', () => {
  // mediumFillEditor types one keystroke at a time over several seconds (the
  // only way Medium's editor accepts bulk text without desyncing — see the
  // comment on mediumFillEditor). Chrome throttles JS timers in background
  // tabs, which stretches/bursts that loop and desyncs Medium's own
  // change-tracking (verified live against medium.com: "Something is wrong
  // and we cannot save your story", Publish left broken). Unlike X/Quora
  // (a single synthetic paste event, immune to throttling), the tab MUST stay
  // active for the whole fill — regardless of autoSubmit.
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

describe('postMediumStory — happy path', () => {
  it('fills, publishes, and reads back the permalink', async () => {
    stubPage();

    const r = await postMediumStory({ title: 'Hello', text: 'World' });

    expect(r.ok).toBe(true);
    expect(r.permalink).toBe('https://medium.com/@tercel/some-title-abc123def456');
    expect(ran()).toEqual([
      'mediumDetectAuthWall',
      'mediumFillEditor',
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
  });

  it('surfaces the tab instead of reporting false success when the editor is not found', async () => {
    stubPage({ fill: 'no_editor' });

    const r = await postMediumStory({ title: 'Hello', text: 'World' });

    expect(r.ok).toBe(false);
    expect(focusTab).toHaveBeenCalledWith(1);
  });
});

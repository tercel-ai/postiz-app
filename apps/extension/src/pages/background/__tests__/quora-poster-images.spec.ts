import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const fetchImageForPage = vi.fn();
vi.mock('@gitroom/extension/pages/background/x.poster', () => ({
  fetchImageForPage: (...a: any[]) => fetchImageForPage(...a),
}));

import { postQuoraPost } from '../quora.poster';

const ran = () => runInPage.mock.calls.map(([, fn]) => (fn as any).name);

beforeEach(() => {
  vi.clearAllMocks();
  openTab.mockResolvedValue({ tabId: 1 });
  getTabUrl.mockResolvedValue('https://www.quora.com/Some-Post-Title');
  runInPage.mockImplementation(async (_tabId: number, fn: any) => {
    switch (fn.name) {
      case 'quoraDetectLogin':
        return false;
      case 'quoraComposeInPage':
        return 'posted';
      default:
        throw new Error(`unexpected in-page function: ${fn.name}`);
    }
  });
  // The MAIN-world create interceptor install + capture-read go through
  // chrome.scripting.executeScript directly (not the runInPage mock above).
  vi.stubGlobal('chrome', {
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: null }]) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('postQuoraPost — images', () => {
  it('downloads images BEFORE opening a tab and forwards them to the composer', async () => {
    fetchImageForPage.mockResolvedValue({
      name: 'a.png',
      mime: 'image/png',
      b64: 'AAAA',
    });

    const r = await postQuoraPost({ text: 'hi', images: ['https://api/a.png'] });

    expect(r.ok).toBe(true);
    expect(fetchImageForPage).toHaveBeenCalledWith('https://api/a.png');
    // Downloaded before the tab opens, so a bad URL never leaves a stray tab open.
    expect(
      fetchImageForPage.mock.invocationCallOrder[0]
    ).toBeLessThan(openTab.mock.invocationCallOrder[0]);
    expect(ran()).toContain('quoraComposeInPage');
    const composeCall = runInPage.mock.calls.find(
      ([, fn]) => fn.name === 'quoraComposeInPage'
    );
    expect(composeCall?.[2]).toEqual([
      'hi',
      true,
      [{ name: 'a.png', mime: 'image/png', b64: 'AAAA' }],
    ]);
  });

  it('fails fast without opening a tab when an image download fails', async () => {
    fetchImageForPage.mockRejectedValue(new Error('404'));

    const r = await postQuoraPost({ text: 'hi', images: ['https://api/missing.png'] });

    expect(r.ok).toBe(false);
    expect(r.error).toContain('404');
    expect(openTab).not.toHaveBeenCalled();
  });

  it('allows an image-only post with no text', async () => {
    fetchImageForPage.mockResolvedValue({
      name: 'a.png',
      mime: 'image/png',
      b64: 'AAAA',
    });

    const r = await postQuoraPost({ text: '', images: ['https://api/a.png'] });

    expect(r.ok).toBe(true);
  });

  it('rejects an empty post with neither text nor images without opening a tab', async () => {
    const r = await postQuoraPost({ text: '   ' });

    expect(r.ok).toBe(false);
    expect(openTab).not.toHaveBeenCalled();
  });

  it('surfaces the tab and reports an error when the image control cannot be found', async () => {
    fetchImageForPage.mockResolvedValue({
      name: 'a.png',
      mime: 'image/png',
      b64: 'AAAA',
    });
    runInPage.mockImplementation(async (_tabId: number, fn: any) => {
      switch (fn.name) {
        case 'quoraDetectLogin':
          return false;
        case 'quoraComposeInPage':
          return 'no_image_input';
        default:
          throw new Error(`unexpected in-page function: ${fn.name}`);
      }
    });

    const r = await postQuoraPost({ text: 'hi', images: ['https://api/a.png'] });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/image upload control/i);
    expect(focusTab).toHaveBeenCalledWith(1);
  });
});

describe('postQuoraPost — permalink capture', () => {
  // Confirmed live against a real Quora account: a successful "Create Post"
  // submit does NOT navigate the tab anywhere — it just closes the dialog and
  // the new post appears inline in the feed at the SAME url. getTabUrl polling
  // (isQuoraPermalink) can therefore never observe a permalink here; the only
  // place the URL exists is the postAdd_Mutation GraphQL response body, which
  // the MAIN-world interceptor (installQuoraCreateInterceptor / readQuoraCreated)
  // captures instead. This is the fix for "posts but never backfills a URL".
  it('reads the permalink from the interceptor capture, not the tab URL', async () => {
    // The tab URL never leaves the feed root — exactly what was observed live.
    getTabUrl.mockResolvedValue('https://www.quora.com/');
    let executeScriptCall = 0;
    vi.stubGlobal('chrome', {
      scripting: {
        executeScript: vi.fn().mockImplementation(async () => {
          executeScriptCall += 1;
          // Call 1 = interceptor install (no meaningful result). Call 2 = the
          // capture read, returning what the interceptor recorded.
          if (executeScriptCall === 1) return [{ result: undefined }];
          return [
            {
              result: {
                url: '/profile/Tercel-Yi/aisee-test-post-1785480111750',
                pid: 253203236,
              },
            },
          ];
        }),
      },
    });

    const r = await postQuoraPost({ text: 'hi' });

    expect(r.ok).toBe(true);
    expect(r.permalink).toBe(
      'https://www.quora.com/profile/Tercel-Yi/aisee-test-post-1785480111750'
    );
    expect(r.postId).toBe('253203236');
    // The tab-URL poll must NOT have been needed to reach a result — a real
    // fix here doesn't just "also" work if the capture happens to be there.
    expect(getTabUrl).not.toHaveBeenCalled();
  });

  it('falls back to polling the tab URL when the capture misses', async () => {
    getTabUrl.mockResolvedValue('https://www.quora.com/profile/Tercel-Yi/fallback-post');
    vi.stubGlobal('chrome', {
      scripting: {
        executeScript: vi.fn().mockResolvedValue([{ result: null }]),
      },
    });

    const r = await postQuoraPost({ text: 'hi' });

    expect(r.ok).toBe(true);
    expect(r.permalink).toBe('https://www.quora.com/profile/Tercel-Yi/fallback-post');
    expect(getTabUrl).toHaveBeenCalled();
  });
});

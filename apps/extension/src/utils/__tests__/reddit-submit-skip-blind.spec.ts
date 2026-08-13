import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const submitRedditPostViaTab = vi.fn();
vi.mock('@gitroom/extension/pages/background/reddit.submit.tab', () => ({
  submitRedditPostViaTab: (...args: unknown[]) => submitRedditPostViaTab(...args),
}));

import { submitRedditPost, clearRedditSessionCache } from '../reddit.poster';

// A signed-in Reddit session, served through the same cookie + /api/me.json
// path getRedditSession uses.
function stubSignedInReddit(onFetch: (url: string) => void) {
  vi.stubGlobal('chrome', {
    cookies: {
      get: (
        _q: { url: string; name: string },
        cb: (c: { value: string } | null) => void
      ) => cb({ value: 'session-cookie' }),
    },
    // Callback style, not promise style: loadSessionCache/saveSessionCache wrap
    // these in `new Promise(resolve => chrome.storage.local.get(keys, cb))`, so
    // a stub that never invokes the callback hangs forever.
    storage: {
      local: {
        get: (_keys: string[], cb: (s: Record<string, unknown>) => void) => cb({}),
        set: (_items: Record<string, unknown>, cb?: () => void) => cb?.(),
      },
    },
  });
  vi.stubGlobal('fetch', async (url: string) => {
    onFetch(url);
    if (url.includes('/api/me.json')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { name: 'tester', modhash: 'mh' } }),
      };
    }
    // Any /api/submit reaching here is the bug these tests are about.
    return {
      ok: true,
      status: 200,
      json: async () => ({ json: { errors: [] as unknown[] } }),
    };
  });
}

describe('submitRedditPost — known flair-required communities', () => {
  let fetched: string[] = [];

  beforeEach(async () => {
    submitRedditPostViaTab.mockReset();
    submitRedditPostViaTab.mockResolvedValue({
      ok: true,
      permalink: 'https://www.reddit.com/r/football/comments/x/t/',
      postId: 't3_x',
    });
    fetched = [];
    stubSignedInReddit((url) => fetched.push(url));
    await clearRedditSessionCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The blind /api/submit cannot carry a flair, so for a community observed to
  // force one it is a guaranteed rejection — and the poster retries once on ANY
  // error before reading it, so the wasted cost is two submits plus a forced
  // session refresh, on every post.
  it('skips the blind /api/submit entirely and goes straight to the tab', async () => {
    const res = await submitRedditPost({
      subreddit: 'football',
      title: 'A title',
      text: 'body',
      flairRequired: true,
      flairLabel: '📰News',
    });

    expect(res.ok).toBe(true);
    expect(fetched.some((u) => u.includes('/api/submit'))).toBe(false);
    expect(submitRedditPostViaTab).toHaveBeenCalledTimes(1);
    expect(submitRedditPostViaTab.mock.calls[0][0]).toMatchObject({
      subreddit: 'football',
      title: 'A title',
      flairLabel: '📰News',
      // Shaped like a live rejection because it stands in for one: this is what
      // gates the flair picker and canAutoSubmitReddit.
      postRule: { flairRequired: true, titleTagRequired: false },
    });
  });

  it('still uses the API path when nothing was observed', async () => {
    await submitRedditPost({
      subreddit: 'football',
      title: 'A title',
      text: 'body',
    });

    expect(fetched.some((u) => u.includes('/api/submit'))).toBe(true);
    expect(submitRedditPostViaTab).not.toHaveBeenCalled();
  });

  // `flairRequired` is only ever set from a real observation, so a falsy value
  // must not be read as "flair is optional" in some third way — it simply means
  // nothing was observed, and the API path is tried as before.
  it('treats an explicit false the same as absent', async () => {
    await submitRedditPost({
      subreddit: 'football',
      title: 'A title',
      text: 'body',
      flairRequired: false,
    });

    expect(fetched.some((u) => u.includes('/api/submit'))).toBe(true);
    expect(submitRedditPostViaTab).not.toHaveBeenCalled();
  });
});

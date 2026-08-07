// Permalink recovery for a just-published Reddit post.
//
// This is the load-bearing path for the backend callback: shreddit frequently
// never puts the new post's permalink in the tab URL (verified on r/football,
// where a SUCCESSFUL submit navigated to the subreddit feed instead), so the
// user's own submissions listing is the only reliable source of the
// releaseURL the backend stores.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { findSubmittedPostByTitle } from '../reddit.submit.tab';

const NOW_S = 1_800_000_000;

function child(overrides: Record<string, unknown>) {
  return {
    data: {
      title: 'Now that the dust has settled, what are your honest thoughts?',
      permalink: '/r/football/comments/1vhv6ob/now_that_the_dust_has_settled/',
      name: 't3_1vhv6ob',
      created_utc: NOW_S,
      ...overrides,
    },
  };
}

function stubFetch(payload: unknown, ok = true) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    json: async () => payload,
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('findSubmittedPostByTitle', () => {
  it('returns the absolute permalink and t3_ fullname for a matching post', async () => {
    stubFetch({ data: { children: [child({})] } });

    const found = await findSubmittedPostByTitle(
      'Consistent_Habit_436',
      'Now that the dust has settled, what are your honest thoughts?',
      NOW_S - 60
    );

    expect(found).toEqual({
      permalink:
        'https://www.reddit.com/r/football/comments/1vhv6ob/now_that_the_dust_has_settled/',
      postId: 't3_1vhv6ob',
    });
  });

  it('queries the signed-in user own submissions with their session cookies', async () => {
    const fetchFn = stubFetch({ data: { children: [] } });

    await findSubmittedPostByTitle('Some_User', 'anything', NOW_S);

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain('/user/Some_User/submitted.json');
    expect(url).toContain('sort=new');
    expect(init).toMatchObject({ credentials: 'include' });
  });

  it('matches case-insensitively and ignores whitespace differences', async () => {
    stubFetch({ data: { children: [child({ title: '  Hello   World  ' })] } });

    const found = await findSubmittedPostByTitle('u', 'hello world', NOW_S - 60);

    expect(found?.permalink).toContain('/comments/');
  });

  // The guard that stops an unrelated older post with the same title from
  // being reported as the one just published.
  it('ignores a same-title post older than the attempt', async () => {
    stubFetch({ data: { children: [child({ created_utc: NOW_S - 5000 })] } });

    const found = await findSubmittedPostByTitle(
      'u',
      'Now that the dust has settled, what are your honest thoughts?',
      NOW_S - 60
    );

    expect(found).toBeNull();
  });

  it('ignores a recent post whose title is different', async () => {
    stubFetch({ data: { children: [child({ title: 'Some other post' })] } });

    const found = await findSubmittedPostByTitle('u', 'The one we posted', NOW_S - 60);

    expect(found).toBeNull();
  });

  it('picks the matching post out of a listing full of others', async () => {
    stubFetch({
      data: {
        children: [
          child({ title: 'Unrelated newest', permalink: '/r/x/comments/aaa/u/', name: 't3_aaa' }),
          child({ title: 'Target post', permalink: '/r/y/comments/bbb/t/', name: 't3_bbb' }),
          child({ title: 'Older unrelated', created_utc: NOW_S - 9999 }),
        ],
      },
    });

    const found = await findSubmittedPostByTitle('u', 'Target post', NOW_S - 60);

    expect(found).toEqual({
      permalink: 'https://www.reddit.com/r/y/comments/bbb/t/',
      postId: 't3_bbb',
    });
  });

  it('returns null without fetching when signed out (no username)', async () => {
    const fetchFn = stubFetch({ data: { children: [child({})] } });

    const found = await findSubmittedPostByTitle('', 'anything', NOW_S - 60);

    expect(found).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  // A transport failure is indistinguishable from "not visible yet"; both mean
  // keep waiting, so this must never throw into the publish flow.
  it('returns null instead of throwing when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(
      findSubmittedPostByTitle('u', 'anything', NOW_S - 60)
    ).resolves.toBeNull();
  });

  it('returns null on a malformed listing body', async () => {
    stubFetch({ nonsense: true });

    await expect(
      findSubmittedPostByTitle('u', 'anything', NOW_S - 60)
    ).resolves.toBeNull();
  });

  it('skips an entry with no permalink rather than returning a bare origin', async () => {
    stubFetch({ data: { children: [child({ permalink: '' })] } });

    const found = await findSubmittedPostByTitle(
      'u',
      'Now that the dust has settled, what are your honest thoughts?',
      NOW_S - 60
    );

    expect(found).toBeNull();
  });
});

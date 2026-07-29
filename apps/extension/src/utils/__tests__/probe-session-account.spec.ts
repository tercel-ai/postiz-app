// The publish guard's id-only session probe. What matters per platform is
// whether it can produce an id that is COMPARABLE to the Integration's
// internalId — a probe that returns a differently-shaped id would block
// legitimate posts, so each platform is pinned to the shape it really stores.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@gitroom/extension/utils/auth.service', () => ({
  getAuthUser: vi.fn(),
}));
vi.mock('@gitroom/extension/utils/reddit.poster', () => ({
  getRedditSession: vi.fn(),
}));

import { getSocialSessions, probeSessionAccount } from '../social-sessions';

/** Cookie jar keyed by `${url}|${name}`, served through a chrome.cookies stub. */
let jar: Record<string, string> = {};

function stubChrome() {
  const sessionStore: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    cookies: {
      get: (
        { url, name }: { url: string; name: string },
        cb: (c: { value: string } | null) => void
      ) => {
        const hit = Object.entries(jar).find(([k]) => {
          const [jarUrl, jarName] = k.split('|');
          return jarName === name && url.startsWith(jarUrl);
        });
        cb(hit ? { value: hit[1] } : null);
      },
    },
    storage: {
      // chrome.storage supports BOTH callback and promise styles and the code
      // under test uses each in different places — the stub has to honour both
      // or a callback-style read simply never resolves.
      session: {
        get: (keys: string[], cb?: (d: Record<string, unknown>) => void) => {
          const out = Object.fromEntries(keys.map((k) => [k, sessionStore[k]]));
          if (cb) return cb(out);
          return Promise.resolve(out);
        },
        set: (obj: Record<string, unknown>, cb?: () => void) => {
          Object.assign(sessionStore, obj);
          if (cb) return cb();
          return Promise.resolve();
        },
      },
    },
  });
}

beforeEach(() => {
  jar = {};
  stubChrome();
  vi.unstubAllGlobals();
  stubChrome();
});

describe('probeSessionAccount — hackernews', () => {
  it('reads the username straight out of the `user` cookie', async () => {
    // HN stores `<username>&<hash>`, and the Integration's internalId IS the
    // username — so no network call is needed to compare them.
    jar['https://news.ycombinator.com/|user'] = 'alice&abc123hash';

    const probe = await probeSessionAccount('hackernews');

    expect(probe).toMatchObject({
      supported: true,
      loggedIn: true,
      id: 'alice',
      handle: 'alice',
    });
  });

  it('reports logged out when the cookie is absent', async () => {
    const probe = await probeSessionAccount('hackernews');
    expect(probe).toMatchObject({ supported: true, loggedIn: false });
    expect(probe.id).toBeUndefined();
  });

  it('yields no id when the cookie is not in the expected format', async () => {
    // The cookie is httpOnly, so its internal format could not be confirmed
    // from a live session. If it ever differs, a garbage id would block every
    // HN publish — no id merely skips the check.
    jar['https://news.ycombinator.com/|user'] =
      '{"token":"eyJhbGciOiJIUzI1NiJ9.payload"}';

    const probe = await probeSessionAccount('hackernews');

    expect(probe).toMatchObject({ supported: true, loggedIn: true });
    expect(probe.id).toBeUndefined();
  });
});

describe('probeSessionAccount — x', () => {
  it('decodes the numeric id from the url-encoded twid cookie', async () => {
    jar['https://x.com/|auth_token'] = 'tok';
    jar['https://x.com/|twid'] = 'u%3D1234567890';

    const probe = await probeSessionAccount('x');

    expect(probe).toMatchObject({
      supported: true,
      loggedIn: true,
      id: '1234567890',
    });
  });

  it('is logged out without auth_token, even if twid lingers', async () => {
    jar['https://x.com/|twid'] = 'u%3D1234567890';
    const probe = await probeSessionAccount('x');
    expect(probe).toMatchObject({ supported: true, loggedIn: false });
  });
});

describe('probeSessionAccount — medium', () => {
  it('takes the @handle out of the /me redirect', async () => {
    jar['https://medium.com/|sid'] = 'sess';
    // Real redirect target from a live session. Note the dot in the handle.
    vi.stubGlobal('fetch', async () => ({
      url: 'https://medium.com/@tercel.yi',
      ok: true,
    }));

    const probe = await probeSessionAccount('medium');

    // internalId for medium IS the handle, so id and handle are the same value.
    expect(probe).toMatchObject({
      supported: true,
      loggedIn: true,
      id: 'tercel.yi',
      handle: 'tercel.yi',
    });
  });
});

describe('probeSessionAccount — linkedin', () => {
  // voyager/api/me exposes the SAME account under a numeric id and an opaque
  // one. The Integration stores the opaque OAuth `sub`, so reading the numeric
  // one would mismatch every time and block every LinkedIn publish.
  const voyagerBody = {
    plainId: 254217383,
    miniProfile: {
      objectUrn: 'urn:li:member:254217383',
      entityUrn:
        'urn:li:fs_miniProfile:ACoAAA8nDKcBk1M3B73uLx0TiF15SaZqdHAL0fo',
    },
  };

  it('reads the opaque entityUrn id, never the numeric plainId', async () => {
    jar['https://www.linkedin.com/|li_at'] = 'tok';
    jar['https://www.linkedin.com/|JSESSIONID'] = '"ajax:123"';
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => voyagerBody,
    }));

    const probe = await probeSessionAccount('linkedin');

    expect(probe.id).toBe('ACoAAA8nDKcBk1M3B73uLx0TiF15SaZqdHAL0fo');
    expect(probe.id).not.toBe('254217383');
  });

  it('returns no id at all when entityUrn is missing', async () => {
    jar['https://www.linkedin.com/|li_at'] = 'tok';
    jar['https://www.linkedin.com/|JSESSIONID'] = '"ajax:123"';
    // Falling back to plainId here would be worse than having no id: no id
    // means the guard lets the post through, a wrong id blocks it.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ plainId: 254217383 }),
    }));

    const probe = await probeSessionAccount('linkedin');

    expect(probe).toMatchObject({ supported: true, loggedIn: true });
    expect(probe.id).toBeUndefined();
  });
});

describe('probeSessionAccount — quora', () => {
  it('takes the profile slug off the settings page', async () => {
    jar['https://www.quora.com/|m-b'] = 'device';
    // The settings page mentions only the signed-in user's own profile.
    //
    // The stub is URL-aware deliberately. A stub that answers ANY url let this
    // resolver ship pointing at `/settings/account` — a path Quora 404s, since
    // the "Account" tab is rendered client-side — so the check was dead in
    // production while the suite stayed green. Assert the url, not just the
    // parse.
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requested.push(url);
      if (url !== 'https://www.quora.com/settings') {
        return { ok: false, status: 404, text: async () => '' };
      }
      return {
        ok: true,
        text: async () => '<a href="/profile/Tercel-Yi">Your profile</a>',
      };
    });

    const probe = await probeSessionAccount('quora');

    expect(requested).toEqual(['https://www.quora.com/settings']);
    expect(probe).toMatchObject({
      supported: true,
      loggedIn: true,
      id: 'Tercel-Yi',
    });
  });

  it('gives up rather than guessing when several profiles appear', async () => {
    // Scraping the FEED returns the post authors' profiles, and picking one
    // would confidently identify the wrong person — blocking every Quora
    // publish. So more than one distinct match must yield no id at all.
    jar['https://www.quora.com/|m-b'] = 'device';
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      text: async () =>
        '<a href="/profile/Sangram-Sagar-1"></a><a href="/profile/Carlos-Rossi-62"></a>',
    }));

    const probe = await probeSessionAccount('quora');

    expect(probe).toMatchObject({ supported: true, loggedIn: true });
    expect(probe.id).toBeUndefined();
  });

  it('is logged out when the browser has never visited quora', async () => {
    const probe = await probeSessionAccount('quora');
    expect(probe).toMatchObject({ supported: true, loggedIn: false });
  });
});

describe('probeSessionAccount — unknown platform', () => {
  it('reports unsupported', async () => {
    const probe = await probeSessionAccount('mastodon');
    expect(probe.supported).toBe(false);
  });
});

describe('identity cache', () => {
  it('keeps every platform it resolved in one snapshot', async () => {
    // The cache is a single storage entry holding all platforms. Reading the
    // map, awaiting the network, then writing back the PRE-read snapshot lets
    // concurrent probes clobber each other — at most one platform survives, and
    // the rest hit the network again on the very next call.
    jar['https://medium.com/|sid'] = 'sess';
    jar['https://www.quora.com/|m-s'] = 'qsess';
    let calls = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      calls++;
      return String(url).includes('quora')
        ? { ok: true, text: async () => '<a href="/profile/Tercel-Yi"></a>' }
        : { ok: true, url: 'https://medium.com/@tercel.yi' };
    });

    await getSocialSessions();
    const afterFirst = calls;
    await getSocialSessions();

    expect(afterFirst).toBe(2); // medium + quora resolved once each
    expect(calls).toBe(afterFirst); // second snapshot fully served from cache
  });

  it('re-probes soon after a failed lookup instead of caching the miss for the full TTL', async () => {
    // A miss means the account could not be named, and the guard treats "no id"
    // as "cannot conclude" and ALLOWS the post. Caching that for the full
    // 10-minute TTL would disable the wrong-account check for the whole window
    // on the strength of one transient 403.
    jar['https://medium.com/|sid'] = 'sess';
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return calls === 1
        ? { ok: true, url: 'https://medium.com/' } // no /@handle → miss
        : { ok: true, url: 'https://medium.com/@tercel.yi' };
    });

    expect((await probeSessionAccount('medium')).id).toBeUndefined();
    // Same call again is served from the short negative cache — no new request.
    expect((await probeSessionAccount('medium')).id).toBeUndefined();
    expect(calls).toBe(1);

    // Past the 30s miss TTL the lookup runs again and recovers. A resolved
    // handle, by contrast, would still be cached at this point (10min TTL).
    const real = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => real() + 31_000);
    expect((await probeSessionAccount('medium')).id).toBe('tercel.yi');
    expect(calls).toBe(2);
    vi.mocked(Date.now).mockRestore();
  });

  it('never caches the Quora slug under the device cookie', async () => {
    // `m-b` is a device id that survives sign-out, so caching under it would
    // keep account A's slug alive after the user switched to account B — the
    // guard would then match a stale slug and publish as B.
    jar['https://www.quora.com/|m-b'] = 'device';
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return {
        ok: true,
        text: async () =>
          `<a href="/profile/Account-${calls}"></a>`,
      };
    });

    expect((await probeSessionAccount('quora')).id).toBe('Account-1');
    // Resolved fresh, not served from a cache keyed on the device cookie.
    expect((await probeSessionAccount('quora')).id).toBe('Account-2');
    expect(calls).toBe(2);
  });
});

describe('getSocialSessions', () => {
  it('carries comparable ids for the extension-published platforms', async () => {
    // The web editor compares these ids against Integration.internalId to warn
    // before publishing as the wrong account, so the snapshot must actually
    // include them — not just x/reddit.
    jar['https://news.ycombinator.com/|user'] = 'tercelyi&hash';
    jar['https://www.quora.com/|m-b'] = 'device';
    jar['https://medium.com/|sid'] = 'sess';
    vi.stubGlobal('fetch', async (url: string) =>
      String(url).includes('quora')
        ? { ok: true, text: async () => '<a href="/profile/Tercel-Yi"></a>' }
        : { ok: true, url: 'https://medium.com/@tercel.yi' }
    );

    const sessions = await getSocialSessions();

    expect(sessions.hackernews).toMatchObject({
      loggedIn: true,
      id: 'tercelyi',
    });
    expect(sessions.quora).toMatchObject({ loggedIn: true, id: 'Tercel-Yi' });
    expect(sessions.medium).toMatchObject({ loggedIn: true, id: 'tercel.yi' });
    // Never visited — logged out, and crucially no id to mistake for a mismatch.
    expect(sessions.linkedin).toMatchObject({ loggedIn: false });
    expect(sessions.linkedin.id).toBeUndefined();
  });

  it('never touches the private LinkedIn API for a snapshot', async () => {
    // The LinkedIn id costs a call to voyager/api/me from the worker, on the
    // one platform known to fingerprint this extension. The snapshot only
    // renders signed-in/signed-out, so it reports LinkedIn from the cookie
    // alone; the id is paid for only on the publish path, where it is what
    // stops an irreversible wrong-account post.
    jar['https://www.linkedin.com/|li_at'] = 'li-session';
    jar['https://www.linkedin.com/|JSESSIONID'] = '"ajax:1"';
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(String(url));
      return {
        ok: true,
        json: async () => ({
          miniProfile: { entityUrn: 'urn:li:fs_miniProfile:ACoAAA' },
        }),
      };
    });

    const sessions = await getSocialSessions();

    expect(sessions.linkedin).toMatchObject({ loggedIn: true });
    expect(sessions.linkedin.id).toBeUndefined();
    expect(fetched.filter((u) => u.includes('linkedin.com'))).toEqual([]);
  });

  it('still resolves the LinkedIn id on the publish path', async () => {
    // The counterpart of the test above: the guard's probe DOES pay for it.
    jar['https://www.linkedin.com/|li_at'] = 'li-session';
    jar['https://www.linkedin.com/|JSESSIONID'] = '"ajax:1"';
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        miniProfile: { entityUrn: 'urn:li:fs_miniProfile:ACoAAA' },
      }),
    }));

    const probe = await probeSessionAccount('linkedin');

    expect(probe).toMatchObject({ loggedIn: true, id: 'ACoAAA' });
  });

  it('leaves loggedIn UNSET when a platform cannot be probed', async () => {
    // Consumers block publishing on an explicit `false`. A probe that failed —
    // or a platform with no probe — must not be reported as "signed out", or a
    // lookup hiccup would block a legitimate post.
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down');
    });
    jar['https://medium.com/|sid'] = 'sess';

    const sessions = await getSocialSessions();

    expect(sessions.medium.id).toBeUndefined();
    expect(sessions.medium.loggedIn).not.toBe(false);
  });
});

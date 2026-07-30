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

import {
  SESSION_PLATFORMS,
  getPlatformLoginSnapshot,
  getSocialSessions,
  probeSessionAccount,
} from '../social-sessions';

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
      // dev.to is the one platform probed by LISTING cookies rather than asking
      // for a name — its session cookie is httpOnly, so the exact name could
      // not be confirmed from a live page.
      getAll: async ({ domain }: { domain: string }) =>
        Object.entries(jar)
          .filter(([k]) => k.split('|')[0].includes(domain))
          .map(([k, value]) => ({ name: k.split('|')[1], value })),
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
  it('reports signed-in from cookies WITHOUT touching the network', async () => {
    // Quora's identity page is 403'd for every request from the worker: a
    // different origin means Chrome stamps `Sec-Fetch-Site: cross-site`, and JS
    // cannot override it. Asking anyway would add a guaranteed-rejected request
    // to each publish, so the probe must stay offline and simply not claim an
    // id — the wrong-account check happens in quora.poster instead, inside the
    // tab it opens to publish.
    jar['https://www.quora.com/|m-login'] = '1';
    jar['https://www.quora.com/|m-b'] = 'device';
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requested.push(url);
      return { ok: false, status: 403, text: async () => '' };
    });

    const probe = await probeSessionAccount('quora');

    expect(requested).toEqual([]);
    expect(probe).toMatchObject({ supported: true, loggedIn: true });
    expect(probe.id).toBeUndefined();
  });

  it('stays offline on the publish path too, where network defaults on', async () => {
    // The publish guard omits `network`, so it defaults to true. Quora must
    // ignore that rather than pay a 403 before every post.
    jar['https://www.quora.com/|m-login'] = '1';
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requested.push(url);
      return { ok: false, status: 403, text: async () => '' };
    });

    const probe = await probeSessionAccount('quora', { network: true });

    expect(requested).toEqual([]);
    expect(probe).toMatchObject({ supported: true, loggedIn: true });
  });

  it('is logged out when the browser has never visited quora', async () => {
    const probe = await probeSessionAccount('quora');
    expect(probe).toMatchObject({ supported: true, loggedIn: false });
  });

  it('treats a lone device cookie as signed in', async () => {
    // `m-b` survives sign-out, so it cannot prove a session — but its absence
    // is the only safe logged-out conclusion, and claiming logged-out on its
    // presence alone would block legitimate posts.
    jar['https://www.quora.com/|m-b'] = 'device';
    const probe = await probeSessionAccount('quora');
    expect(probe).toMatchObject({ supported: true, loggedIn: true });
  });
});

describe('probeSessionAccount — unknown platform', () => {
  it('reports unsupported', async () => {
    const probe = await probeSessionAccount('mastodon');
    expect(probe.supported).toBe(false);
  });
});

describe('identity cache', () => {
  it('keeps every platform it resolved concurrently', async () => {
    // The cache is a single storage entry holding all platforms. Reading the
    // map, awaiting the network, then writing back the PRE-read snapshot lets
    // concurrent probes clobber each other — at most one platform survives, and
    // the rest hit the network again on the very next call.
    jar['https://medium.com/|sid'] = 'sess';
    jar['https://www.linkedin.com/|li_at'] = 'tok';
    jar['https://www.linkedin.com/|JSESSIONID'] = '"ajax:123"';
    let calls = 0;
    const probeBoth = () =>
      Promise.all([
        probeSessionAccount('medium'),
        probeSessionAccount('linkedin'),
      ]);
    vi.stubGlobal('fetch', async (url: string) => {
      calls++;
      return String(url).includes('linkedin')
        ? { ok: true, json: async () => ({ miniProfile: { entityUrn: 'urn:li:fs_miniProfile:ACoAAA' } }) }
        : { ok: true, url: 'https://medium.com/@tercel.yi' };
    });

    await probeBoth();
    const afterFirst = calls;
    await probeBoth();

    expect(afterFirst).toBe(2); // medium + linkedin resolved once each
    expect(calls).toBe(afterFirst); // second round fully served from cache
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

  it('drops a cached identity the moment the session cookie changes', async () => {
    // The cache key MUST be a cookie that turns over on logout/account switch.
    // Keyed on anything device-scoped, account A's handle would outlive the
    // switch to account B and the guard would wave the post through as B —
    // precisely the case it exists to catch.
    jar['https://medium.com/|sid'] = 'sess-a';
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return { ok: true, url: `https://medium.com/@account-${calls}` };
    });

    expect((await probeSessionAccount('medium')).id).toBe('account-1');
    expect((await probeSessionAccount('medium')).id).toBe('account-1'); // cached
    expect(calls).toBe(1);

    jar['https://medium.com/|sid'] = 'sess-b'; // signed in as someone else
    expect((await probeSessionAccount('medium')).id).toBe('account-2');
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
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      url: 'https://medium.com/@tercel.yi',
    }));

    const sessions = await getSocialSessions();

    expect(sessions.hackernews).toMatchObject({
      loggedIn: true,
      id: 'tercelyi',
    });
    expect(sessions.medium).toMatchObject({ loggedIn: true, id: 'tercel.yi' });
    // Quora is the exception: signed-in is knowable from cookies, the account
    // is not — its identity page is 403'd for anything this worker sends. The
    // editor therefore cannot pre-warn on Quora, and the wrong-account check
    // moves into quora.poster, inside the tab that publishes.
    expect(sessions.quora).toMatchObject({ loggedIn: true });
    expect(sessions.quora.id).toBeUndefined();
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

  it('covers every platform the popup counts', async () => {
    // The popup (SESSION_PLATFORMS) and the web app (this snapshot) answer the
    // same question through different paths, and they drifted once: dev.to was
    // probed for the popup but omitted from the snapshot, so the web app showed
    // a signed-in dev.to as simply absent. Assert the platform LIST, not just
    // that dev.to is present, so the next platform added to one side cannot
    // silently skip the other.
    jar['https://dev.to/|remember_user_token'] = 'devto-session';

    const sessions = await getSocialSessions();

    for (const platform of SESSION_PLATFORMS) {
      expect(sessions).toHaveProperty(platform);
    }
    // dev.to is cookie-only, like quora: signed-in is knowable, the account is
    // not — its identity needs a real page, so devto.poster checks it in the
    // tab it opens to publish.
    expect(sessions.devto).toMatchObject({ loggedIn: true });
    expect(sessions.devto.id).toBeUndefined();
  });
});

describe('getPlatformLoginSnapshot', () => {
  it('counts every platform the extension publishes with a browser session', () => {
    // dev.to counts like the rest: its scan/metrics are anonymous, but its
    // PUBLISH path drives dev.to/new in a real tab, so a signed-out dev.to is a
    // genuine gap. Its api-key channel is a parallel route, not a replacement —
    // the same arrangement medium/quora/hackernews already have.
    expect([...SESSION_PLATFORMS]).toEqual([
      'x',
      'reddit',
      'linkedin',
      'medium',
      'quora',
      'hackernews',
      'devto',
    ]);
  });

  it('reports every platform, signed in or out, in a fixed order', async () => {
    jar['https://x.com/|auth_token'] = 'x-session';
    jar['https://www.reddit.com/|reddit_session'] = 'r-session';
    jar['https://news.ycombinator.com/|user'] = 'tercelyi&hash';

    const snapshot = await getPlatformLoginSnapshot();

    expect(snapshot.map((e) => e.platform)).toEqual([...SESSION_PLATFORMS]);
    expect(snapshot.filter((e) => e.loggedIn).map((e) => e.platform)).toEqual([
      'x',
      'reddit',
      'hackernews',
    ]);
  });

  it('costs nothing but cookies while collapsed', async () => {
    // The popup renders this counter on every open, before the user asks for
    // anything — so no platform may be contacted. medium/linkedin therefore
    // report signed-in without an account name.
    jar['https://medium.com/|sid'] = 'sess';
    jar['https://www.linkedin.com/|li_at'] = 'li-session';
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(String(url));
      return { ok: true, url: 'https://medium.com/@tercel.yi' };
    });

    const snapshot = await getPlatformLoginSnapshot();
    const byKey = Object.fromEntries(snapshot.map((e) => [e.platform, e]));

    expect(byKey.medium).toMatchObject({ loggedIn: true });
    expect(byKey.medium.id).toBeUndefined();
    expect(byKey.linkedin).toMatchObject({ loggedIn: true });
    expect(fetched).toEqual([]);
  });

  it('names the accounts it safely can once expanded', async () => {
    jar['https://medium.com/|sid'] = 'sess';
    jar['https://news.ycombinator.com/|user'] = 'tercelyi&hash';
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      url: 'https://medium.com/@tercel.yi',
    }));

    const snapshot = await getPlatformLoginSnapshot({ detailed: true });
    const byKey = Object.fromEntries(snapshot.map((e) => [e.platform, e]));

    expect(byKey.medium).toMatchObject({ loggedIn: true, handle: 'tercel.yi' });
    expect(byKey.hackernews).toMatchObject({ handle: 'tercelyi' });
  });

  it('recognises the dev.to session by shape, not by a guessed name', async () => {
    // Forem's session cookie is httpOnly, so its exact name could not be
    // confirmed against a live signed-in page (document.cookie there shows only
    // ahoy/GA analytics). Hardcoding a guess is what went wrong on Quora, so the
    // probe matches Rails/Devise shapes over chrome.cookies.getAll instead.
    jar['https://dev.to/|_forem_session'] = 'abc';
    const rails = await getPlatformLoginSnapshot();
    expect(rails.find((e) => e.platform === 'devto')).toMatchObject({
      loggedIn: true,
    });

    jar = { 'https://dev.to/|remember_user_token': 'xyz' };
    const devise = await getPlatformLoginSnapshot();
    expect(devise.find((e) => e.platform === 'devto')).toMatchObject({
      loggedIn: true,
    });
  });

  it('does not mistake dev.to analytics cookies for a session', async () => {
    // These are exactly the cookies a SIGNED-OUT visitor gets, and the only ones
    // page JS can see on a signed-in one — treating them as a login would report
    // every anonymous visitor as authenticated.
    jar['https://dev.to/|ahoy_visitor'] = 'v';
    jar['https://dev.to/|ahoy_visit'] = 'v';
    jar['https://dev.to/|_ga'] = 'g';

    const snapshot = await getPlatformLoginSnapshot();

    expect(snapshot.find((e) => e.platform === 'devto')).toMatchObject({
      loggedIn: false,
    });
  });

  it('never opens a dev.to tab for the collapsed counter', async () => {
    // The identity is only readable from a real page, so the detailed pass may
    // open a tab — the counter every popup open pays for may not.
    jar['https://dev.to/|_forem_session'] = 'abc';
    const created: string[] = [];
    vi.stubGlobal('chrome', {
      ...(globalThis as any).chrome,
      tabs: { create: (o: { url: string }) => created.push(o.url) },
    });

    await getPlatformLoginSnapshot();

    expect(created).toEqual([]);
  });

  it('keeps LinkedIn off the private API even when expanded', async () => {
    // Expanding is a display action; it must not buy an extra voyager call on
    // the one platform known to fingerprint this extension. The handle shows up
    // only if a PUBLISH already resolved and cached it under this same li_at.
    jar['https://www.linkedin.com/|li_at'] = 'li-session';
    jar['https://www.linkedin.com/|JSESSIONID'] = '"ajax:1"';
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(String(url));
      return {
        ok: true,
        json: async () => ({
          miniProfile: {
            entityUrn: 'urn:li:fs_miniProfile:ACoAAA',
            publicIdentifier: 'tercel-yi',
          },
        }),
      };
    });

    const cold = await getPlatformLoginSnapshot({ detailed: true });
    expect(cold.find((e) => e.platform === 'linkedin')).toMatchObject({
      loggedIn: true,
    });
    expect(fetched.filter((u) => u.includes('linkedin.com'))).toEqual([]);

    // A publish resolves the identity; the next expand reuses that cache.
    await probeSessionAccount('linkedin');
    const warm = await getPlatformLoginSnapshot({ detailed: true });

    expect(warm.find((e) => e.platform === 'linkedin')).toMatchObject({
      loggedIn: true,
      handle: 'tercel-yi',
    });
    expect(fetched.filter((u) => u.includes('linkedin.com'))).toHaveLength(1);
  });
});

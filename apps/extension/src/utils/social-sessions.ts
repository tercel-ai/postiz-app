// Service-worker side of the `aisee:social-sessions` bridge: snapshot which
// social platforms the BROWSER is logged into, and who the account is.
//
//   - X: `auth_token` cookie = logged in; `twid` = numeric user id. The
//     username/display-name/avatar are NOT in any cookie, so they are read the
//     only allowed way — a real BROWSER TAB (background x.com page, DOM read
//     of X's own nav: the Profile link href + account-switcher button). NEVER
//     X API calls from the worker. The identity is cached in
//     chrome.storage.session keyed by twid, so the tab read happens once per
//     login/account-switch, not per probe.
//   - Reddit: `reddit_session` cookie = logged in; identity comes from the
//     same session /api/me.json read (+ 10-min cache) the reply poster uses —
//     a browser-session request Reddit serves routinely. `token_v2` JWT decode
//     stays as a fallback id source when me.json is unreachable.
//   - aisee (our own platform): the extension's current session — id/email/
//     username, since it is our own auth.
//
// Emails for X/Reddit are never exposed to the browser session at all — only
// the aisee entry can carry one.

import type {
  AiseeSessionInfo,
  PlatformSessionInfo,
  RedditSessionInfo,
  SocialSessions,
  XSessionInfo,
} from '@gitroom/helpers/extension/social-sessions';
import { getAuthUser } from '@gitroom/extension/utils/auth.service';
import { getRedditSession } from '@gitroom/extension/utils/reddit.poster';

const REDDIT_BASE = 'https://www.reddit.com';
const X_IDENTITY_CACHE_KEY = 'aisee_x_identity';

function getCookie(url: string, name: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      chrome.cookies.get({ url, name }, (c) => resolve(c?.value || ''));
    } catch {
      resolve('');
    }
  });
}

/** First non-empty value of a cookie across x.com and twitter.com. */
async function getXCookie(name: string): Promise<string> {
  return (
    (await getCookie('https://x.com/', name)) ||
    (await getCookie('https://twitter.com/', name))
  );
}

// ── X identity via a real browser tab ───────────────────────────────────────

interface XIdentity {
  handle?: string;
  name?: string;
  avatarUrl?: string;
}

interface XIdentityCache extends XIdentity {
  /** The twid user id this identity belongs to — account-switch invalidator. */
  twid: string;
  at: number;
}

function loadXIdentityCache(): Promise<XIdentityCache | null> {
  return new Promise((resolve) => {
    try {
      chrome.storage.session.get([X_IDENTITY_CACHE_KEY], (d) =>
        resolve(d?.[X_IDENTITY_CACHE_KEY] ?? null)
      );
    } catch {
      resolve(null);
    }
  });
}

function saveXIdentityCache(value: XIdentityCache): void {
  try {
    chrome.storage.session.set({ [X_IDENTITY_CACHE_KEY]: value });
  } catch {
    /* session storage unavailable — identity just re-reads next time */
  }
}

/** Resolve once the tab finishes its top-level load (or times out). */
function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    const listener = (
      updatedTabId: number,
      info: chrome.tabs.TabChangeInfo
    ) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Runs INSIDE the x.com page (serialized — fully self-contained). Polls for
 * X's own left-nav Profile link (its href IS the logged-in handle) and reads
 * the display name + avatar from the account-switcher button. Pure DOM read
 * of what X renders for its logged-in user — no network, no API.
 */
function readXIdentityInPage(): Promise<{
  handle?: string;
  name?: string;
  avatarUrl?: string;
} | null> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return (async () => {
    const start = Date.now();
    for (;;) {
      const link = document.querySelector<HTMLAnchorElement>(
        'a[data-testid="AppTabBar_Profile_Link"]'
      );
      if (link) {
        let handle: string | undefined;
        try {
          handle = new URL(link.href).pathname.split('/')[1] || undefined;
        } catch {
          /* malformed href — leave handle unset */
        }
        const switcher = document.querySelector<HTMLElement>(
          '[data-testid="SideNav_AccountSwitcher_Button"]'
        );
        const avatarUrl =
          switcher?.querySelector('img')?.src?.replace('_normal.', '_400x400.') ||
          undefined;
        // The switcher renders "<display name>\n@<handle>" — first line = name.
        const firstLine = (switcher?.innerText || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)[0];
        return { handle, name: firstLine || undefined, avatarUrl };
      }
      if (Date.now() - start > 8_000) return null;
      await sleep(250);
    }
  })();
}

/** Open a background x.com tab, read the logged-in identity, close the tab. */
async function readXIdentityViaTab(): Promise<XIdentity> {
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({
      url: 'https://x.com/home',
      active: false,
    });
    tabId = tab.id ?? undefined;
    if (tabId == null) return {};
    await waitForTabComplete(tabId, 15_000);
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readXIdentityInPage,
    });
    const v = res?.result;
    return v ? { handle: v.handle, name: v.name, avatarUrl: v.avatarUrl } : {};
  } catch (e) {
    console.warn('[aisee][sessions] x identity tab read failed', e);
    return {};
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* already gone */
      }
    }
  }
}

// Single in-flight tab read — concurrent probes share it instead of racing
// multiple background tabs.
let xIdentityInFlight: Promise<XIdentity> | null = null;

async function getXSession(): Promise<XSessionInfo> {
  const authToken = await getXCookie('auth_token');
  if (!authToken) return { loggedIn: false };
  // twid looks like "u%3D1234567890" (url-encoded `u=<numeric id>`).
  const twid = await getXCookie('twid');
  const m = decodeURIComponent(twid).match(/u=(\d+)/);
  const userId = m?.[1];
  const base: XSessionInfo = { loggedIn: true, ...(userId ? { userId } : {}) };

  const cache = await loadXIdentityCache();
  if (cache && cache.twid === (userId || '') && (cache.handle || cache.name)) {
    return {
      ...base,
      handle: cache.handle,
      name: cache.name,
      avatarUrl: cache.avatarUrl,
    };
  }

  if (!xIdentityInFlight) {
    xIdentityInFlight = readXIdentityViaTab().finally(() => {
      xIdentityInFlight = null;
    });
  }
  const identity = await xIdentityInFlight;
  if (identity.handle || identity.name) {
    saveXIdentityCache({ twid: userId || '', ...identity, at: Date.now() });
  }
  return { ...base, ...identity };
}

// ── Reddit ──────────────────────────────────────────────────────────────────

/**
 * Best-effort t2_* account id from Reddit's `token_v2` JWT payload, decoded
 * locally. The payload's key names have changed over time, so scan the values
 * for the t2_ pattern instead of hardcoding one key. Returns undefined on any
 * malformed/opaque token — the caller treats the id as simply unknown.
 */
export function decodeRedditIdFromJwt(jwt: string): string | undefined {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return undefined;
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = JSON.parse(atob(padded));
    for (const v of Object.values(json)) {
      if (typeof v === 'string' && /^t2_[a-z0-9]+$/i.test(v)) return v;
    }
  } catch {
    /* opaque or absent token — id stays unknown */
  }
  return undefined;
}

async function getRedditSessionInfo(): Promise<RedditSessionInfo> {
  // Cheap cookie gate first: logged out → never touch me.json.
  const sessionCookie = await getCookie(`${REDDIT_BASE}/`, 'reddit_session');
  if (!sessionCookie) return { loggedIn: false };

  try {
    const s = await getRedditSession();
    if (s.name) {
      return {
        loggedIn: true,
        handle: s.name,
        ...(s.author?.id ? { id: s.author.id } : {}),
        name: s.author?.name || s.name,
        ...(s.author?.avatarUrl ? { avatarUrl: s.author.avatarUrl } : {}),
      };
    }
  } catch (e) {
    console.warn('[aisee][sessions] reddit me.json read failed', e);
  }

  // me.json unreachable (WAF hiccup etc.) — cookie says logged in; recover at
  // least the account id from the token_v2 JWT.
  const token = await getCookie(`${REDDIT_BASE}/`, 'token_v2');
  const id = decodeRedditIdFromJwt(token);
  return { loggedIn: true, ...(id ? { id } : {}) };
}

// ── aisee ───────────────────────────────────────────────────────────────────

/**
 * The extension's own aisee session (explicit extension login or bridged from
 * a logged-in frontend tab). Our own platform, so id/email/username are fair
 * game — unlike the X/Reddit probes.
 */
async function getAiseeSession(): Promise<AiseeSessionInfo> {
  try {
    const user = await getAuthUser();
    if (!user) return { loggedIn: false };
    return {
      loggedIn: true,
      ...(user.id ? { id: user.id } : {}),
      ...(user.email ? { email: user.email } : {}),
      ...(user.username ? { username: user.username } : {}),
    };
  } catch {
    return { loggedIn: false };
  }
}

// ── Lightweight id-only probe (publish guard) ───────────────────────────────

export interface SessionAccountProbe {
  /**
   * False when this platform has NO session probe at all — the caller cannot
   * conclude anything about who is logged in, so it must not treat the result
   * as a mismatch.
   */
  supported: boolean;
  loggedIn: boolean;
  /** Platform-side account id, in whatever shape the platform reports it. */
  id?: string;
  /** Handle when it is already cached; never fetched on demand here. */
  handle?: string;
}

const IDENTITY_CACHE_KEY = 'aisee_publish_identity';
const IDENTITY_TTL_MS = 10 * 60 * 1000;
/**
 * Misses get their own, much shorter TTL.
 *
 * A miss means the resolver could not name the account — a 403 from LinkedIn, a
 * Medium layout change, a transient network error. The publish guard treats "no
 * id" as "cannot conclude" and ALLOWS the post, so caching a miss for the full
 * 10 minutes would silently disable the wrong-account check for that whole
 * window on the strength of one transient failure. A short TTL still stops the
 * network probe from running before every single publish (the reason the cache
 * exists) while letting the very next drain cycle recover.
 */
const IDENTITY_MISS_TTL_MS = 30 * 1000;

interface CachedIdentity {
  /** The session cookie this identity was resolved under — the invalidator. */
  key: string;
  handle?: string;
  at: number;
}

async function readIdentityCache(): Promise<Record<string, CachedIdentity>> {
  try {
    const d = await chrome.storage.session.get([IDENTITY_CACHE_KEY]);
    return d?.[IDENTITY_CACHE_KEY] ?? {};
  } catch {
    /* no session storage — resolve fresh every time */
    return {};
  }
}

/**
 * Cache a network-resolved handle against the session cookie it belongs to, so
 * a logout/account-switch invalidates it immediately rather than after the TTL.
 * Keyed per platform in one storage entry.
 *
 * `sessionKey` MUST be a cookie that actually changes on logout/account switch —
 * a device-scoped cookie would keep the previous account's identity alive across
 * a switch, which is exactly the case the guard exists to catch. Pass undefined
 * when no such cookie is available and the lookup runs uncached.
 */
async function cachedHandle(
  platform: string,
  sessionKey: string | undefined,
  resolve: () => Promise<string | undefined>
): Promise<string | undefined> {
  // No trustworthy invalidator → never cache. Correctness beats one saved
  // request: a stale identity here means publishing as the wrong account.
  if (!sessionKey) return resolve();

  const hit = (await readIdentityCache())[platform];
  if (hit && hit.key === sessionKey) {
    const ttl = hit.handle ? IDENTITY_TTL_MS : IDENTITY_MISS_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.handle;
  }
  const handle = await resolve();
  try {
    // Re-read immediately before writing. getSocialSessions resolves several
    // platforms inside one Promise.all, so a map snapshot taken BEFORE the
    // network await is already stale by now — writing it back would discard
    // whatever the sibling probes stored in the meantime, leaving at most one
    // platform cached per snapshot and defeating the cache entirely.
    const all = await readIdentityCache();
    all[platform] = { key: sessionKey, handle, at: Date.now() };
    await chrome.storage.session.set({ [IDENTITY_CACHE_KEY]: all });
  } catch (e) {
    console.warn('[aisee][sessions] identity cache write failed', platform, e);
  }
  return handle;
}

/**
 * Medium's own "my profile" redirect: /me lands on /@handle for the logged-in
 * session. A same-session navigation Medium serves routinely — no API key, no
 * scraping of another user's page.
 */
async function readMediumHandle(): Promise<string | undefined> {
  try {
    const res = await fetch('https://medium.com/me', {
      credentials: 'include',
      redirect: 'follow',
    });
    const m = new URL(res.url).pathname.match(/^\/@([^/?#]+)/);
    return m?.[1] || undefined;
  } catch (e) {
    console.warn('[aisee][sessions] medium identity read failed', e);
    return undefined;
  }
}

/**
 * LinkedIn's member id via its own session endpoint. The CSRF token IS the
 * JSESSIONID cookie value (LinkedIn's own convention).
 *
 * Which field to read is NOT interchangeable. voyager/api/me returns the same
 * account under two different identifiers:
 *
 *   plainId   254217383                                    (numeric)
 *   objectUrn urn:li:member:254217383                      (the same number)
 *   entityUrn urn:li:fs_miniProfile:ACoAAA8nDKcBk1M...     (opaque)
 *
 * The Integration's internalId is the OAuth `sub` from /v2/userinfo (see
 * linkedin.provider authenticate), which is the OPAQUE one. Reading plainId
 * would therefore never match and would block every LinkedIn publish — so this
 * reads entityUrn only, and returns undefined rather than falling back to a
 * numeric id that is guaranteed to mismatch. Verified against a live session.
 */
async function readLinkedinMemberId(): Promise<string | undefined> {
  try {
    const jsession = (
      await getCookie('https://www.linkedin.com/', 'JSESSIONID')
    ).replace(/"/g, '');
    if (!jsession) return undefined;
    const res = await fetch('https://www.linkedin.com/voyager/api/me', {
      credentials: 'include',
      headers: { 'csrf-token': jsession, accept: 'application/json' },
    });
    if (!res.ok) {
      console.warn('[aisee][sessions] linkedin identity read HTTP', res.status);
      return undefined;
    }
    const body = await res.json();
    const entityUrn: string =
      body?.miniProfile?.entityUrn || body?.entityUrn || '';
    return (
      String(entityUrn).match(/urn:li:fs_miniProfile:([^,)\s"]+)/)?.[1] ||
      undefined
    );
  } catch (e) {
    console.warn('[aisee][sessions] linkedin identity read failed', e);
    return undefined;
  }
}

/**
 * Which account this browser is logged into on `platform`, resolved from
 * COOKIES ALONE.
 *
 * Deliberately not getSocialSessions(): that one also resolves display identity,
 * which for X means opening a background tab and waiting seconds. This runs
 * before every single publish, so it must stay cheap — and the stable account id
 * it compares on is already in the cookies. A handle is returned only when a
 * previous probe happened to cache one; it is for wording the error, never for
 * the comparison.
 *
 * `network: false` restricts this to cookies ALONE — medium / linkedin then
 * report logged-in without their account id. Callers that only need "is this
 * browser signed in" (the session snapshot the web app renders) pass it so the
 * platform never sees a request; the publish guard, where the id is what makes
 * the check work at all, uses the default.
 *
 * Quora ignores the flag: it is cookie-only either way, because its identity is
 * unreadable from this worker at all (see the `quora` case). Its wrong-account
 * check runs in quora.poster, inside the tab it opens to publish.
 */
export async function probeSessionAccount(
  platform: string,
  opts: { network?: boolean } = {}
): Promise<SessionAccountProbe> {
  const network = opts.network !== false;
  switch ((platform || '').toLowerCase()) {
    case 'x': {
      const authToken = await getXCookie('auth_token');
      if (!authToken) return { supported: true, loggedIn: false };
      const twid = await getXCookie('twid');
      const id = decodeURIComponent(twid).match(/u=(\d+)/)?.[1];
      // Only reuse the cached handle when it belongs to THIS account, else a
      // stale one from the previously logged-in account would word the error
      // with the wrong name.
      const cache = await loadXIdentityCache();
      const handle =
        cache && cache.twid === (id || '') ? cache.handle : undefined;
      return {
        supported: true,
        loggedIn: true,
        ...(id ? { id } : {}),
        ...(handle ? { handle } : {}),
      };
    }
    case 'reddit': {
      const sessionCookie = await getCookie(
        `${REDDIT_BASE}/`,
        'reddit_session'
      );
      if (!sessionCookie) return { supported: true, loggedIn: false };
      // JWT decode, not me.json: a local read with no network round-trip.
      const id = decodeRedditIdFromJwt(
        await getCookie(`${REDDIT_BASE}/`, 'token_v2')
      );
      return { supported: true, loggedIn: true, ...(id ? { id } : {}) };
    }
    case 'hackernews': {
      // HN's `user` cookie is `<username>&<hash>`, and the Integration's
      // internalId IS the HN username — an exact, network-free comparison.
      // The cookie is httpOnly (confirmed against a live session): readable
      // here via chrome.cookies, invisible to page JS.
      const raw = await getCookie('https://news.ycombinator.com/', 'user');
      if (!raw) return { supported: true, loggedIn: false };
      let candidate = '';
      try {
        candidate = decodeURIComponent(raw).split('&')[0] || '';
      } catch {
        // Malformed percent-encoding — fall back to the raw split.
        candidate = raw.split('&')[0] || '';
      }
      // The cookie's INTERNAL format is the one thing a live session could not
      // confirm (httpOnly hides it from the page). So accept the value only if
      // it actually looks like an HN username: should the format ever differ,
      // a garbage id would block every HN publish, while no id just skips the
      // check. HN usernames are 2-15 chars of [A-Za-z0-9_-].
      const handle = /^[A-Za-z0-9_-]{2,15}$/.test(candidate)
        ? candidate
        : undefined;
      return {
        supported: true,
        loggedIn: true,
        ...(handle ? { id: handle, handle } : {}),
      };
    }
    case 'medium': {
      const sid = await getCookie('https://medium.com/', 'sid');
      if (!sid) return { supported: true, loggedIn: false };
      if (!network) return { supported: true, loggedIn: true };
      // internalId is the @handle, so the handle is the id here.
      const handle = await cachedHandle('medium', sid, readMediumHandle);
      return {
        supported: true,
        loggedIn: true,
        ...(handle ? { id: handle, handle } : {}),
      };
    }
    case 'linkedin': {
      const liAt = await getCookie('https://www.linkedin.com/', 'li_at');
      if (!liAt) return { supported: true, loggedIn: false };
      if (!network) return { supported: true, loggedIn: true };
      // ACCEPTED EXCEPTION to the extension's "drive a real tab, never call a
      // private API from the worker" rule (queue.ts, linkedin/page-scripts.ts).
      // It is bounded deliberately: one GET of the user's OWN profile, only on
      // the publish path where the id is what makes the guard work, cached for
      // 10 minutes per li_at — never on the session snapshot, which passes
      // network:false. Opening a tab per publish would be far more conspicuous
      // than one request the LinkedIn web app itself makes on every page load.
      const id = await cachedHandle('linkedin', liAt, readLinkedinMemberId);
      return { supported: true, loggedIn: true, ...(id ? { id } : {}) };
    }
    case 'quora': {
      // Cookies only, and deliberately no id — Quora is the one platform whose
      // account this worker CANNOT name.
      //
      // Its identity lives on `/settings`, and Quora's WAF answers that page
      // 403 for any request from here: the worker is a different origin, so
      // Chrome stamps `Sec-Fetch-Site: cross-site`, which JS may not override.
      // The identical fetch from inside a quora.com tab is same-origin and
      // returns 200 — so the wrong-account check runs there instead, in
      // quora.poster, which opens such a tab to publish anyway. Retrying it
      // here would only add a guaranteed 403 to every publish, and a rejected
      // request per post is exactly the traffic pattern a risk-controlled site
      // is watching for.
      //
      // `m-login` is the signed-in marker; `m-b` is a device id that survives
      // sign-out, so its absence is the one safe logged-out conclusion — this
      // browser has never been to Quora at all.
      const loginKey = await getCookie('https://www.quora.com/', 'm-login');
      const deviceKey = await getCookie('https://www.quora.com/', 'm-b');
      if (!loginKey && !deviceKey) {
        return { supported: true, loggedIn: false };
      }
      return { supported: true, loggedIn: true };
    }
    default:
      return { supported: false, loggedIn: false };
  }
}

/**
 * Reuse the publish guard's probe for a platform that has no richer identity
 * read. Never throws — an unresolvable platform reports logged-out rather than
 * failing the whole snapshot.
 */
async function platformSession(platform: string): Promise<PlatformSessionInfo> {
  try {
    // LinkedIn is held to cookies here. Its id costs a call to a PRIVATE API
    // from the worker, on the one platform this extension is known to be
    // fingerprinted by — worth paying on the publish path, where the id is what
    // stops an irreversible wrong-account post, but not for a snapshot that
    // only renders "signed in / signed out". Medium resolves its handle from an
    // ordinary same-session page, so it keeps the id. Quora is cookie-only
    // whatever this flag says — see probeSessionAccount.
    const probe = await probeSessionAccount(platform, {
      network: platform !== 'linkedin',
    });
    // `{}` — NOT `{loggedIn: false}`. Consumers block publishing on an explicit
    // false, so claiming "signed out" for a platform we simply cannot probe
    // would block legitimate posts.
    if (!probe.supported) return {};
    return {
      loggedIn: probe.loggedIn,
      ...(probe.id ? { id: probe.id } : {}),
      ...(probe.handle ? { handle: probe.handle } : {}),
    };
  } catch (e) {
    console.warn('[aisee][sessions] platform probe failed', platform, e);
    return {};
  }
}

/**
 * Snapshot all platforms in parallel; a platform probe never throws.
 *
 * The four platforms below go through the cheap id-only probe: cookies, plus one
 * cached session request for medium (LinkedIn and Quora are cookie-only here —
 * see platformSession). Only X opens a browser tab (its handle is in no cookie),
 * so adding these does not change what dominates this call's latency.
 */
export async function getSocialSessions(): Promise<SocialSessions> {
  const [x, reddit, aisee, linkedin, hackernews, medium, quora] =
    await Promise.all([
      getXSession(),
      getRedditSessionInfo(),
      getAiseeSession(),
      platformSession('linkedin'),
      platformSession('hackernews'),
      platformSession('medium'),
      platformSession('quora'),
    ]);
  return { x, reddit, aisee, linkedin, hackernews, medium, quora };
}

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

// ── dev.to ──────────────────────────────────────────────────────────────────

let devtoCookieNamesLogged = false;

/**
 * dev.to's session cookies, matched by PATTERN rather than one hardcoded name.
 *
 * Forem is a Rails/Devise app: its session cookie ends in `_session` and the
 * persistent-login cookie is Devise's `remember_user_token`. Both are httpOnly,
 * which chrome.cookies can read but page JS cannot — so, unlike every other
 * platform here, the exact name could NOT be confirmed against a live signed-in
 * session (`document.cookie` on dev.to exposes only ahoy/GA analytics cookies).
 *
 * Betting the probe on a guessed name is precisely what produced a wrong
 * diagnosis on Quora, so it matches the two shapes Forem can plausibly use and
 * logs whatever it actually finds ONCE per worker — the first real run confirms
 * the name, without a wrong guess silently reporting a signed-in user as
 * signed out.
 */
async function getDevtoSessionCookies(): Promise<chrome.cookies.Cookie[]> {
  try {
    const all = (await chrome.cookies.getAll({ domain: 'dev.to' })) || [];
    if (!devtoCookieNamesLogged) {
      devtoCookieNamesLogged = true;
      console.debug(
        '[aisee][sessions] dev.to cookie names',
        all.map((c) => c.name)
      );
    }
    return all.filter(
      (c) => /_session$/i.test(c.name) || c.name === 'remember_user_token'
    );
  } catch (e) {
    console.warn('[aisee][sessions] dev.to cookie read failed', e);
    return [];
  }
}

/**
 * Cache key for a dev.to identity: the live session cookies themselves, so a
 * logout or an account switch invalidates the cached account immediately.
 */
function devtoSessionKey(cookies: chrome.cookies.Cookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('|');
}

export interface DevtoIdentity {
  /** Numeric account id — the SAME id DevToProvider stores as internalId. */
  id?: string;
  /** @handle without the @. */
  handle?: string;
  name?: string;
  avatarUrl?: string;
}

/**
 * Runs INSIDE a dev.to page (serialized — fully self-contained). Forem
 * server-renders the signed-in account onto <body data-user='{...}'> together
 * with `data-user-status`, so this is a pure DOM read of what dev.to already
 * published to the page — no API call, no scraping of anyone else's data.
 */
function readDevtoIdentityInPage(): {
  loggedIn: boolean;
  id?: string;
  handle?: string;
  name?: string;
  avatarUrl?: string;
} {
  const body = document.body;
  if (!body) return { loggedIn: false };
  if (body.getAttribute('data-user-status') !== 'logged-in') {
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
      name: u?.name || undefined,
      avatarUrl: u?.profile_image_90 || u?.profile_image || undefined,
    };
  } catch {
    // Attribute present but unparseable — still signed in, just unnamed.
    return { loggedIn: true };
  }
}

/** Open a background dev.to tab, read the signed-in identity, close the tab. */
async function readDevtoIdentityViaTab(): Promise<DevtoIdentity | undefined> {
  let tabId: number | undefined;
  try {
    // The identity is server-rendered into the HTML, so the cheapest page will
    // do — no need for the feed to hydrate.
    const tab = await chrome.tabs.create({
      url: 'https://dev.to/',
      active: false,
    });
    tabId = tab.id ?? undefined;
    if (tabId == null) return undefined;
    await waitForTabComplete(tabId, 15_000);
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readDevtoIdentityInPage,
    });
    const v = res?.result;
    if (!v?.loggedIn) return undefined;
    return { id: v.id, handle: v.handle, name: v.name, avatarUrl: v.avatarUrl };
  } catch (e) {
    console.warn('[aisee][sessions] dev.to identity tab read failed', e);
    return undefined;
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

// ── Quora ───────────────────────────────────────────────────────────────────

export interface QuoraIdentity {
  /**
   * The numeric `m-uid`, kept for diagnostics and as the cache key — NEVER as
   * `id`. It is a different namespace from what an Integration is bound with,
   * so account-guard must never see it (see `id` below).
   */
  uid?: string;
  /**
   * The profile SLUG, same value as `handle` — deliberately not the numeric
   * `m-uid`. QuoraProvider binds an Integration with the slug (`id: username`),
   * and account-guard compares this against that internalId, so the uid would
   * be an unmatchable value from a different namespace.
   */
  id?: string;
  /** Profile slug, e.g. `Tercel-Yi` in /profile/Tercel-Yi. */
  handle?: string;
  name?: string;
  avatarUrl?: string;
}

/**
 * Runs INSIDE a quora.com page (serialized — fully self-contained).
 *
 * Quora ships no viewer object to the page (ansFrontendGlobals carries only
 * settings), and its markup is hash-obfuscated, so the one durable anchor is
 * the account's OWN avatar: Quora renders it as `main-thumb-<uid>-<size>-…`,
 * and `m-uid` names that uid. Filtering on the uid is what makes this the
 * viewer's identity and not some author's in the feed — a bare
 * `a[href*="/profile/"]` would match hundreds of other people. The wrapping
 * anchor carries the slug and the img's alt carries the display name, so one
 * matched element yields the whole identity.
 */
async function readQuoraIdentityInPage(): Promise<{
  loggedIn: boolean;
  uid?: string;
  id?: string;
  handle?: string;
  name?: string;
  avatarUrl?: string;
}> {
  const uid = (document.cookie.match(/(?:^|;\s*)m-uid=([^;]+)/) || [])[1];
  if (!uid) return { loggedIn: false };
  const selector = `a[href*="/profile/"] img[src*="main-thumb-${uid}-"]`;

  // MUST poll — `complete` is too early here. The avatar URL IS in the server
  // HTML, but only inside a script payload: parsing that HTML yields ZERO
  // matching <img> elements (measured), because React renders the avatar during
  // hydration. dev.to gets away with a single read because <body data-user> is
  // a plain SSR attribute; Quora does not. Reading once at tab-complete is what
  // made this return a bare uid instead of the account.
  let img = document.querySelector(selector);
  const deadline = Date.now() + 10_000;
  while (!img && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    img = document.querySelector(selector);
  }
  // Signed in for certain (the cookie says so) but unnamed. Deliberately NO
  // `id` — see QuoraIdentity: the uid is not comparable to internalId, and
  // returning it here would fail every publish's account check.
  if (!img) return { loggedIn: true, uid };

  const href = img.closest('a')?.getAttribute('href') || '';
  const slug = (href.split('/profile/')[1] || '').split(/[/?#]/)[0];
  const alt = img.getAttribute('alt') || '';
  const name = alt.replace(/^Profile photo for\s*/i, '').trim();
  // `id` is the slug, NOT the uid it was found by — see QuoraIdentity.
  return {
    loggedIn: true,
    uid,
    id: slug || undefined,
    handle: slug || undefined,
    name: name || undefined,
    avatarUrl: img.getAttribute('src') || undefined,
  };
}

/** Open a background quora.com tab, read the signed-in identity, close it. */
async function readQuoraIdentityViaTab(): Promise<QuoraIdentity | undefined> {
  let tabId: number | undefined;
  try {
    // Must be a real tab: every request this worker sends Quora is stamped
    // `Sec-Fetch-Site: cross-site` and answered 403 by its WAF (see
    // probeSessionAccount). The identical read from inside a quora.com tab is
    // same-origin and simply works.
    const tab = await chrome.tabs.create({
      url: 'https://www.quora.com/',
      active: false,
    });
    tabId = tab.id ?? undefined;
    if (tabId == null) return undefined;
    await waitForTabComplete(tabId, 15_000);
    // The injected function is async (it waits for hydration) — executeScript
    // awaits the returned promise and hands back the resolved value.
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readQuoraIdentityInPage,
    });
    const v = res?.result;
    if (!v?.loggedIn) return undefined;
    // No slug → report a MISS (undefined), not a named-but-empty identity.
    // cachedValue gives a defined value the full 10-minute TTL, so caching the
    // unnamed case would lock the row to "signed in" for ten minutes on the
    // strength of one slow hydration; a miss retries after 30s. Nothing is lost
    // — the uid is readable from the cookie whenever it is actually wanted.
    if (!v.handle) return undefined;
    return {
      uid: v.uid,
      id: v.id,
      handle: v.handle,
      name: v.name,
      avatarUrl: v.avatarUrl,
    };
  } catch (e) {
    console.warn('[aisee][sessions] quora identity tab read failed', e);
    return undefined;
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
  /**
   * Handle, when available: for X, only when already cached (never fetched on
   * demand here); for LinkedIn, read alongside `id` in the same request — a
   * second, independently-comparable signal for account-guard to fall back on
   * when `id` disagrees with the Integration's (a real, confirmed case — see
   * readLinkedinIdentity).
   */
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
  value?: unknown;
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
 * Cache a network-resolved value against the session cookie it belongs to, so
 * a logout/account-switch invalidates it immediately rather than after the TTL.
 * Keyed per platform in one storage entry. Generic over T so a platform can
 * cache a single handle string (medium) or a richer identity (linkedin's
 * {id, handle} — one voyager request must yield both, never two).
 *
 * `sessionKey` MUST be a cookie that actually changes on logout/account switch —
 * a device-scoped cookie would keep the previous account's identity alive across
 * a switch, which is exactly the case the guard exists to catch. Pass undefined
 * when no such cookie is available and the lookup runs uncached.
 */
async function cachedValue<T>(
  platform: string,
  sessionKey: string | undefined,
  resolve: () => Promise<T | undefined>
): Promise<T | undefined> {
  // No trustworthy invalidator → never cache. Correctness beats one saved
  // request: a stale identity here means publishing as the wrong account.
  if (!sessionKey) return resolve();

  const hit = (await readIdentityCache())[platform];
  if (hit && hit.key === sessionKey) {
    const ttl = hit.value !== undefined ? IDENTITY_TTL_MS : IDENTITY_MISS_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.value as T;
  }
  const value = await resolve();
  try {
    // Re-read immediately before writing. getSocialSessions resolves several
    // platforms inside one Promise.all, so a map snapshot taken BEFORE the
    // network await is already stale by now — writing it back would discard
    // whatever the sibling probes stored in the meantime, leaving at most one
    // platform cached per snapshot and defeating the cache entirely.
    const all = await readIdentityCache();
    all[platform] = { key: sessionKey, value, at: Date.now() };
    await chrome.storage.session.set({ [IDENTITY_CACHE_KEY]: all });
  } catch (e) {
    console.warn('[aisee][sessions] identity cache write failed', platform, e);
  }
  return value;
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

export interface LinkedinIdentity {
  /** Opaque fs_miniProfile id — see the mismatch caveat below. */
  id?: string;
  /** Public profile vanity slug (linkedin.com/in/<publicIdentifier>). */
  handle?: string;
}

/**
 * LinkedIn's member identity via its own session endpoint. The CSRF token IS
 * the JSESSIONID cookie value (LinkedIn's own convention).
 *
 * Which field to read is NOT interchangeable. voyager/api/me returns the same
 * account under several identifiers:
 *
 *   plainId          254217383                                (numeric)
 *   objectUrn        urn:li:member:254217383                  (the same number)
 *   entityUrn        urn:li:fs_miniProfile:ACoAAA8nDKcBk1M...  (opaque)
 *   publicIdentifier tercel-yi                                 (vanity slug)
 *
 * The Integration's internalId is the OAuth `sub` from /v2/userinfo (see
 * linkedin.provider authenticate) — an id LinkedIn issues per-app, drawn from a
 * DIFFERENT namespace than voyager's own internal session id. Confirmed live:
 * the two opaque ids disagreed for the very same real account, so entityUrn
 * alone is not reliable evidence of a mismatch. publicIdentifier is read
 * alongside it as a second, independently-comparable signal (against the
 * Integration's `profile`, itself the OAuth `vanityName` — see
 * linkedin.provider authenticate/refreshToken) for account-guard to fall back
 * on when the opaque ids disagree.
 */
async function readLinkedinIdentity(): Promise<LinkedinIdentity | undefined> {
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
    const id =
      String(entityUrn).match(/urn:li:fs_miniProfile:([^,)\s"]+)/)?.[1] ||
      undefined;
    const handle: string | undefined =
      body?.miniProfile?.publicIdentifier || undefined;
    return id || handle ? { id, handle } : undefined;
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
      const handle = await cachedValue('medium', sid, readMediumHandle);
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
      const identity = await cachedValue('linkedin', liAt, readLinkedinIdentity);
      return {
        supported: true,
        loggedIn: true,
        ...(identity?.id ? { id: identity.id } : {}),
        ...(identity?.handle ? { handle: identity.handle } : {}),
      };
    }
    case 'devto': {
      // Cookie-only, and deliberately no id — mirroring quora, for a different
      // reason. Dev.to's session cookies ARE readable here (httpOnly is no
      // barrier to chrome.cookies), but the account behind them is not: the
      // identity lives in a `data-user` attribute Forem server-renders onto
      // <body>, which needs a real page. The publish path opens a dev.to tab
      // anyway, so the wrong-account check runs there (devto.poster's
      // expectedUserId), exactly like quora.poster's expectedSlug.
      const cookies = await getDevtoSessionCookies();
      return { supported: true, loggedIn: cookies.length > 0 };
    }
    case 'quora': {
      // Cookies only, and NO id — deliberately, even though `m-uid` sits right
      // there in the jar. It is the wrong NAMESPACE: QuoraProvider binds an
      // Integration with the profile slug (`id: username`, e.g. `Tercel-Yi`),
      // so reporting the numeric uid as `id` would make account-guard compare
      // `1923931969` against `Tercel-Yi`, find no match, and reject every
      // single Quora post as a wrong-account publish. The slug is the only
      // comparable identifier here, so it travels as `handle`.
      //
      // The slug needs a real page: Quora's WAF answers any request from this
      // worker 403 — we are a different origin, so Chrome stamps
      // `Sec-Fetch-Site: cross-site`, which JS may not override. The identical
      // read from inside a quora.com tab is same-origin and returns 200 (see
      // readQuoraIdentityViaTab, which detailedLoginEntry pays for on expand).
      // So, exactly like X: reuse a cached slug, never resolve one here.
      // Retrying the fetch would only add a guaranteed 403 to every publish,
      // and a rejected request per post is exactly the traffic pattern a
      // risk-controlled site is watching for — quora.poster does the real
      // wrong-account check inside the tab it opens to publish anyway.
      //
      // `m-login` is the signed-in marker; `m-b` is a device id that survives
      // sign-out, so its absence is the one safe logged-out conclusion — this
      // browser has never been to Quora at all.
      const loginKey = await getCookie('https://www.quora.com/', 'm-login');
      const deviceKey = await getCookie('https://www.quora.com/', 'm-b');
      if (!loginKey && !deviceKey) {
        return { supported: true, loggedIn: false };
      }
      // `m-uid` earns its keep as the CACHE KEY: it changes on an account
      // switch, so a slug cached under the previous account is never reused.
      const uid = await getCookie('https://www.quora.com/', 'm-uid');
      const cached = await readCachedIdentity<QuoraIdentity>('quora', uid);
      return {
        supported: true,
        loggedIn: true,
        ...(cached?.id ? { id: cached.id } : {}),
        ...(cached?.handle ? { handle: cached.handle } : {}),
      };
    }
    default:
      return { supported: false, loggedIn: false };
  }
}

/** A cached identity, but only when it still belongs to the live session. */
async function readCachedIdentity<T>(
  platform: string,
  sessionKey: string
): Promise<T | undefined> {
  if (!sessionKey) return undefined;
  const hit = (await readIdentityCache())[platform];
  if (!hit || hit.key !== sessionKey || hit.value === undefined) {
    return undefined;
  }
  if (Date.now() - hit.at >= IDENTITY_TTL_MS) return undefined;
  return hit.value as T;
}

// ── Platform login snapshot (popup / side panel) ────────────────────────────

/**
 * The platforms whose BROWSER session the extension actually depends on — the
 * denominator of the popup's "n/m signed in" counter.
 *
 * dev.to counts like any other. Its scan and metrics run anonymously against
 * Forem's public REST API and need nothing, but its PUBLISH path drives
 * dev.to/new in a real tab with the user's own session, exactly like medium,
 * quora and hackernews — all of which likewise bind an API-credential channel
 * on the backend AND publish in-browser. The two routes are parallel, not
 * alternatives, so a signed-out dev.to is a real, reportable gap.
 */
export const SESSION_PLATFORMS = [
  'x',
  'reddit',
  'linkedin',
  'medium',
  'quora',
  'hackernews',
  'devto',
] as const;

export type SessionPlatform = (typeof SESSION_PLATFORMS)[number];

export interface PlatformLoginEntry {
  platform: SessionPlatform;
  loggedIn: boolean;
  id?: string;
  handle?: string;
  name?: string;
  avatarUrl?: string;
}

/** Cookies only: what the popup renders on open, before any user interaction. */
async function cheapLoginEntry(
  platform: SessionPlatform
): Promise<PlatformLoginEntry> {
  const probe = await probeSessionAccount(platform, { network: false });
  return {
    platform,
    loggedIn: probe.loggedIn,
    ...(probe.id ? { id: probe.id } : {}),
    ...(probe.handle ? { handle: probe.handle } : {}),
  };
}

/**
 * Who the account is — resolved only when the user expands the list, because
 * naming an account is not free: Reddit reads me.json, X/dev.to/Quora each open
 * a background tab, and LinkedIn calls a private API (all cached per account
 * afterwards, keyed on the session cookie so a logout invalidates them).
 *
 * Expanding the list IS the opt-in. The two paths that run without the user
 * asking — cheapLoginEntry on popup open, and the web app's getSocialSessions
 * snapshot — stay on cookies plus cache reads, and never trigger any of this.
 */
async function detailedLoginEntry(
  platform: SessionPlatform
): Promise<PlatformLoginEntry> {
  if (platform === 'x') {
    const s = await getXSession();
    return {
      platform,
      loggedIn: s.loggedIn,
      ...(s.userId ? { id: s.userId } : {}),
      ...(s.handle ? { handle: s.handle } : {}),
      ...(s.name ? { name: s.name } : {}),
      ...(s.avatarUrl ? { avatarUrl: s.avatarUrl } : {}),
    };
  }
  if (platform === 'reddit') {
    const s = await getRedditSessionInfo();
    return {
      platform,
      loggedIn: s.loggedIn,
      ...(s.id ? { id: s.id } : {}),
      ...(s.handle ? { handle: s.handle } : {}),
      ...(s.name ? { name: s.name } : {}),
      ...(s.avatarUrl ? { avatarUrl: s.avatarUrl } : {}),
    };
  }
  if (platform === 'devto') {
    // Same shape as X: the account is only readable from a real page, so the
    // tab read happens once per session and is cached against the session
    // cookie, which a logout or account switch invalidates immediately.
    const cookies = await getDevtoSessionCookies();
    if (!cookies.length) return { platform, loggedIn: false };
    const identity = await cachedValue<DevtoIdentity>(
      'devto',
      devtoSessionKey(cookies),
      readDevtoIdentityViaTab
    );
    return {
      platform,
      loggedIn: true,
      ...(identity?.id ? { id: identity.id } : {}),
      ...(identity?.handle ? { handle: identity.handle } : {}),
      ...(identity?.name ? { name: identity.name } : {}),
      ...(identity?.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
    };
  }
  if (platform === 'quora') {
    // Same shape as dev.to: only readable from a real page, so the tab read
    // happens once per session and is cached against `m-uid`, which changes on
    // an account switch.
    //
    // `id` is the SLUG, not the uid — QuoraProvider binds Integrations by slug,
    // and this field is compared against internalId (see probeSessionAccount).
    const loginKey = await getCookie('https://www.quora.com/', 'm-login');
    const deviceKey = await getCookie('https://www.quora.com/', 'm-b');
    if (!loginKey && !deviceKey) return { platform, loggedIn: false };
    const uid = await getCookie('https://www.quora.com/', 'm-uid');
    const identity = await cachedValue<QuoraIdentity>(
      'quora',
      uid,
      readQuoraIdentityViaTab
    );
    return {
      platform,
      loggedIn: true,
      ...(identity?.handle ? { id: identity.handle, handle: identity.handle } : {}),
      ...(identity?.name ? { name: identity.name } : {}),
      ...(identity?.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
    };
  }
  if (platform === 'linkedin') {
    const liAt = await getCookie('https://www.linkedin.com/', 'li_at');
    if (!liAt) return { platform, loggedIn: false };
    // Resolves on demand (one GET of voyager/api/me — the same call the
    // LinkedIn web app itself makes on every page load), cached per li_at.
    //
    // This row used to be cache-READ only, so it stayed nameless until the
    // user had published to LinkedIn at least once in the last 10 minutes —
    // in practice it always rendered a bare "signed in" while every other
    // platform showed its @handle. Paying for it HERE, and only here, keeps
    // the cost where the user asked for it by expanding the list: the cheap
    // popup-open path (cheapLoginEntry) and the web app's snapshot still never
    // touch LinkedIn, and the publish path reuses whatever this cached.
    const identity = await cachedValue<LinkedinIdentity>(
      'linkedin',
      liAt,
      readLinkedinIdentity
    );
    return {
      platform,
      loggedIn: true,
      ...(identity?.id ? { id: identity.id } : {}),
      ...(identity?.handle ? { handle: identity.handle } : {}),
    };
  }
  // medium resolves its @handle from an ordinary same-session page; hackernews
  // and quora are cookie-only whatever the flag says.
  const probe = await probeSessionAccount(platform);
  return {
    platform,
    loggedIn: probe.loggedIn,
    ...(probe.id ? { id: probe.id } : {}),
    ...(probe.handle ? { handle: probe.handle } : {}),
  };
}

/**
 * Login state for every session-backed platform, in SESSION_PLATFORMS order.
 * A platform that throws reports logged-out rather than failing the snapshot —
 * this feeds a status counter, never the publish guard.
 */
export async function getPlatformLoginSnapshot(
  opts: { detailed?: boolean } = {}
): Promise<PlatformLoginEntry[]> {
  const resolve = opts.detailed ? detailedLoginEntry : cheapLoginEntry;
  return Promise.all(
    SESSION_PLATFORMS.map((platform) =>
      resolve(platform).catch((e) => {
        console.warn('[aisee][sessions] login snapshot failed', platform, e);
        return { platform, loggedIn: false } as PlatformLoginEntry;
      })
    )
  );
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
 * Fill in an account name from the identity cache — a READ, never a resolve.
 *
 * dev.to, Quora and LinkedIn all cost something real to NAME (a background tab
 * for the first two, a private-API call for the third), which is why only
 * detailedLoginEntry pays for it, when the user expands the popup. Reusing what
 * that already cached is free, though, and skipping it is what made the two
 * views disagree: the popup showed `@handle` while `__aisee.sessions()`
 * reported a nameless `loggedIn: true` for the very same account.
 *
 * `sessionKey` is the session cookie the cached identity was resolved under, so
 * a logout or account switch drops it instead of surfacing a stale handle.
 */
async function withCachedIdentity(
  platform: string,
  sessionKey: string | undefined,
  base: PlatformSessionInfo
): Promise<PlatformSessionInfo> {
  if (!base.loggedIn || !sessionKey) return base;
  const identity = await readCachedIdentity<{ id?: string; handle?: string }>(
    platform,
    sessionKey
  );
  return {
    ...base,
    ...(identity?.id ? { id: identity.id } : {}),
    ...(identity?.handle ? { handle: identity.handle } : {}),
  };
}

/** dev.to: cookies for logged-in, cached identity for the account. */
async function devtoSessionFromCache(): Promise<PlatformSessionInfo> {
  try {
    const cookies = await getDevtoSessionCookies();
    if (!cookies.length) return { loggedIn: false };
    return withCachedIdentity('devto', devtoSessionKey(cookies), {
      loggedIn: true,
    });
  } catch (e) {
    console.warn('[aisee][sessions] devto session probe failed', e);
    return {};
  }
}

/**
 * Quora: `m-uid` already gives the id for free (see probeSessionAccount), so
 * only the slug comes from the cache.
 */
async function quoraSessionFromCache(): Promise<PlatformSessionInfo> {
  const base = await platformSession('quora');
  try {
    const uid = await getCookie('https://www.quora.com/', 'm-uid');
    return withCachedIdentity('quora', uid, base);
  } catch (e) {
    console.warn('[aisee][sessions] quora identity cache read failed', e);
    return base;
  }
}

/** LinkedIn: cookies only for logged-in — the id/handle come from the cache. */
async function linkedinSessionFromCache(): Promise<PlatformSessionInfo> {
  const base = await platformSession('linkedin');
  try {
    const liAt = await getCookie('https://www.linkedin.com/', 'li_at');
    return withCachedIdentity('linkedin', liAt, base);
  } catch (e) {
    console.warn('[aisee][sessions] linkedin identity cache read failed', e);
    return base;
  }
}

/**
 * Snapshot all platforms in parallel; a platform probe never throws.
 *
 * The platforms below go through the cheap id-only probe: cookies, plus one
 * cached session request for medium. LinkedIn, Quora and dev.to add a cache
 * READ on top (withCachedIdentity) — never a resolve, so this path still sends
 * those three nothing. Only X opens a browser tab (its handle is in no cookie),
 * so adding these does not change what dominates this call's latency.
 *
 * This must keep covering every entry in SESSION_PLATFORMS, plus `aisee`. The
 * popup and the web app are two views of one question, and a platform present in
 * only one of them reads as "not signed in" on the side that omits it.
 */
export async function getSocialSessions(): Promise<SocialSessions> {
  const [x, reddit, aisee, linkedin, hackernews, medium, quora, devto] =
    await Promise.all([
      getXSession(),
      getRedditSessionInfo(),
      getAiseeSession(),
      linkedinSessionFromCache(),
      platformSession('hackernews'),
      platformSession('medium'),
      quoraSessionFromCache(),
      devtoSessionFromCache(),
    ]);
  return { x, reddit, aisee, linkedin, hackernews, medium, quora, devto };
}

// Standalone extension auth against aisee_auth — lets the extension log in
// directly (no website needed) and keep a valid access token via the refresh
// token, WITHOUT ever storing the password.
//
// Tokens:
//   - access_token  : short-lived JWT (api-post backend accepts it as Bearer).
//                     Kept in chrome.storage.session — in memory, gone on browser
//                     close, never written to disk.
//   - refresh_token : httpOnly cookie on the AUTH origin (browser-managed,
//                     ~30-day sliding: every /token-refresh rotates it). The
//                     extension never stores it; for the /token-refresh body
//                     fallback it reads the cookie via chrome.cookies.
//
// Password is SHA-1 hashed before it leaves the form and discarded immediately.

// AUTH service base. Defaults to dev; build:prod injects the prod URL; set
// AUTH_URL in .env to target local/LAN (http://localhost:9001 / :9001).
const IS_PROD = import.meta.env?.EXTENSION_ENV === 'production';
const PROD_AUTH = 'https://api-auth.aisee.live';

// Dev/internal priority: local → LAN → dev domain → prod. First to answer
// /health wins (cached). Mirrors the website's local→LAN→dev order. Setting
// AUTH_URL in .env pins one and skips probing.
const DEV_AUTH_CANDIDATES = [
  'http://localhost:9001',
  'http://192.168.110.98:9001',
  'https://api-auth-dev.aisee.live',
  'https://api-auth.aisee.live',
];

const PINNED_AUTH = (
  import.meta.env?.AUTH_URL ||
  process?.env?.AUTH_URL ||
  ''
).replace(/\/$/, '');

let resolvedAuthBase: string | null = IS_PROD ? PROD_AUTH : PINNED_AUTH || null;

// Lightweight debug logging to the service-worker console (prefix to grep).
const alog = (...args: unknown[]) => {
  try {
    console.log('[aisee-auth]', ...args);
  } catch {
    /* console may be unavailable in some SW states */
  }
};
alog('init', { IS_PROD, PINNED_AUTH, resolvedAuthBase });

/** Resolve the auth base: prod/pinned use a fixed URL; dev probes the priority
 *  list and caches the first reachable. */
async function resolveAuthBase(): Promise<string> {
  if (resolvedAuthBase) {
    alog('resolveAuthBase: using', resolvedAuthBase, PINNED_AUTH ? '(pinned)' : IS_PROD ? '(prod)' : '(cached)');
    return resolvedAuthBase;
  }
  alog('resolveAuthBase: probing', DEV_AUTH_CANDIDATES);
  for (const base of DEV_AUTH_CANDIDATES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(`${base}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        resolvedAuthBase = base;
        alog('resolveAuthBase: reachable →', base);
        return base;
      }
    } catch {
      alog('resolveAuthBase: unreachable', base);
    }
  }
  resolvedAuthBase = DEV_AUTH_CANDIDATES[0]; // last-resort default
  alog('resolveAuthBase: none answered, fallback →', resolvedAuthBase);
  return resolvedAuthBase;
}

const ACCESS_KEY = 'aisee_access'; // chrome.storage.session
const REFRESH_ALARM = 'aisee-token-refresh';
// 20 days — comfortably inside the 30-day refresh-token window, and each fire
// rotates the refresh token so the session rolls forward while installed.
const REFRESH_PERIOD_MINUTES = 20 * 24 * 60;
// Refresh when the access token has under this many seconds left.
const EXPIRY_SKEW_SECONDS = 60;

export interface AuthUser {
  id: string;
  email: string;
  username?: string;
  [k: string]: unknown;
}

interface AccessState {
  accessToken: string;
  expiresAt: number; // unix seconds
  user?: AuthUser;
  // True when bridged from a browser tab (content-script auth bridge / frontend
  // cookie) rather than an explicit extension login. Such a session is dropped
  // when the page logs out; an explicit login is not.
  fromFrontend?: boolean;
}

/** SHA-1 hex of the raw password (the API contract). */
export async function sha1Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function saveAccess(state: AccessState): Promise<void> {
  return new Promise((resolve) =>
    chrome.storage.session.set({ [ACCESS_KEY]: state }, () => resolve())
  );
}

function loadAccess(): Promise<AccessState | null> {
  return new Promise((resolve) =>
    chrome.storage.session.get([ACCESS_KEY], (s) =>
      resolve((s?.[ACCESS_KEY] as AccessState) || null)
    )
  );
}

function clearAccess(): Promise<void> {
  return new Promise((resolve) =>
    chrome.storage.session.remove(ACCESS_KEY, () => resolve())
  );
}

/** Read the refresh_token cookie (body fallback for envs where SameSite blocks it). */
function readRefreshCookie(base: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.cookies.get({ url: base, name: 'refresh_token' }, (c) => {
        alog('readRefreshCookie', base, c ? `found (${c.value.length} chars, domain=${c.domain})` : 'NOT FOUND');
        resolve(c?.value || undefined);
      });
    } catch (e) {
      alog('readRefreshCookie error', String(e));
      resolve(undefined);
    }
  });
}

/** Decode a JWT payload (no verification — just to read sub/email for display). */
function decodeJwt(token: string): any {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(b64)
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Minimal user derived from a session JWT — used when the session is
 *  bootstrapped from a shared cookie rather than an explicit extension login.
 *  Handles both token shapes:
 *    - aisee access token: { sub, email, username }
 *    - postiz `auth` cookie (signJWT(User)): { id, email, name }
 *  Returns undefined when the payload carries no identity (so a foreign `auth`
 *  cookie that merely happens to be a JWT is not mistaken for a session). */
function deriveUserFromToken(token: string): AuthUser | undefined {
  const p = decodeJwt(token);
  if (!p) return undefined;
  const id = p.sub ?? p.id;
  const email = p.email ?? '';
  const username = p.username ?? p.name ?? p.displayName;
  if (!id && !email && !username) return undefined;
  return {
    id: String(id ?? ''),
    email: String(email),
    username: username ? String(username) : undefined,
  };
}

/**
 * Frontend origins to probe for the `auth` cookie: every http(s) host the
 * extension was granted (read from the manifest at runtime, so it tracks the
 * baked host_permissions in dev and prod without a hardcoded list).
 */
function frontendCookieOrigins(): string[] {
  try {
    const hp = (chrome.runtime.getManifest().host_permissions || []) as string[];
    return Array.from(
      new Set(
        hp
          .map((p) => p.replace(/\*$/, '').replace(/\/$/, ''))
          .filter((o) => /^https?:\/\//.test(o))
      )
    );
  } catch {
    return [];
  }
}

/** Read the `auth` cookie at an explicit origin URL (with port). */
function getAuthCookie(url: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.cookies.get({ url, name: 'auth' }, (c) => {
        void chrome.runtime.lastError;
        resolve(c?.value || undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Browser→extension login bridge: derive a session from a frontend `auth`
 * cookie. Logging into apps/frontend (postiz) proxies to aisee_auth server-side,
 * so the browser only receives the postiz `auth` cookie — never the aisee_auth
 * refresh_token cookie. The popup must recognise that cookie as a live session,
 * exactly as the in-browser reply flow already does.
 *
 * IMPORTANT: probes each granted origin with `cookies.get({url})` rather than
 * `cookies.getAll({name})`. Host permissions carry a PORT (e.g. :4200) while
 * cookies are portless, so getAll cannot reconcile the two and silently returns
 * nothing for IP/port origins — whereas get({url}) matches by the full URL and
 * works (the reply backfill relies on the same call). NOT persisted by the
 * caller, so a browser logout reflects immediately.
 */
async function readFrontendAuthSession(): Promise<AccessState | null> {
  const now = Math.floor(Date.now() / 1000);
  for (const origin of frontendCookieOrigins()) {
    const value = await getAuthCookie(origin);
    if (!value) continue;
    const user = deriveUserFromToken(value);
    if (!user) continue; // not an aisee/postiz session JWT
    // postiz signJWT(User) carries no `exp` → rely on cookie presence; the aisee
    // access token does carry `exp`.
    const claims = decodeJwt(value);
    const exp = Number(claims?.exp) || 0;
    if (exp && exp - now <= EXPIRY_SKEW_SECONDS) continue; // expired token
    alog('frontend auth cookie → session', {
      origin,
      who: user.email || user.username || user.id,
    });
    return { accessToken: value, expiresAt: exp || now + 3600, user };
  }
  alog('readFrontendAuthSession: no aisee/postiz `auth` cookie on any granted origin');
  return null;
}

// Defensive: accept {access_data:{access_token,expires_at}} or {access_token,expires_at}.
function parseTokenResponse(
  data: any
): { accessToken: string; expiresAt: number } | null {
  const ad = data?.access_data ?? data;
  const accessToken = ad?.access_token;
  const expiresAt = ad?.expires_at ?? ad?.expiresAt;
  if (!accessToken) return null;
  return { accessToken, expiresAt: Number(expiresAt) || 0 };
}

/** Log in with email + password (password is SHA-1 hashed before sending). */
export async function login(email: string, rawPassword: string): Promise<AuthUser> {
  const password = await sha1Hex(rawPassword);
  const base = await resolveAuthBase();
  alog('login: POST', `${base}/login`, 'email=', email);
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  alog('login: response', res.status, data?.success);
  if (!res.ok || data?.success === false) {
    alog('login: FAILED', data?.detail || data?.message);
    throw new Error(data?.detail || data?.message || `Login failed (${res.status})`);
  }
  const tok = parseTokenResponse(data);
  if (!tok) throw new Error('Login succeeded but no access token in response');

  await saveAccess({ accessToken: tok.accessToken, expiresAt: tok.expiresAt, user: data.user });
  await ensureRefreshAlarm();
  // Confirm the browser actually stored the refresh_token cookie on this host.
  await readRefreshCookie(base);
  alog('login: OK', { user: data.user?.email, expiresAt: tok.expiresAt });
  return data.user as AuthUser;
}

// Single-flight: never run two /token-refresh at once (rotation invalidates the
// old refresh token, so concurrent refreshes would race).
let refreshing: Promise<string | null> | null = null;

async function refresh(): Promise<string | null> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const base = await resolveAuthBase();
      const rt = await readRefreshCookie(base);
      // Short-circuit: no refresh_token cookie = no session to resume. The
      // extension can read httpOnly cookies, so a miss here means the cookie
      // genuinely isn't there (and `credentials: 'include'` would send nothing
      // either). Skip the request so a logged-out bootstrap doesn't emit a noisy
      // 401 on every popup open / SW wake.
      if (!rt) {
        alog('refresh: no refresh_token cookie → skip /token-refresh (not signed in)');
        return null;
      }
      alog('refresh: POST', `${base}/token-refresh`, `cookieToken=yes(${rt.length})`);
      const res = await fetch(`${base}/token-refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alog('refresh: FAILED', res.status, err?.error || err?.detail);
        return null;
      }
      const data = await res.json().catch(() => ({}));
      const tok = parseTokenResponse(data);
      if (!tok) {
        alog('refresh: no token in response');
        return null;
      }
      alog('refresh: OK', { expiresAt: tok.expiresAt });
      const cur = await loadAccess();
      const user =
        (data?.user as AuthUser) ||
        cur?.user ||
        deriveUserFromToken(tok.accessToken);
      await saveAccess({
        accessToken: tok.accessToken,
        expiresAt: tok.expiresAt,
        user,
      });
      // A successful refresh means there's a live session (incl. bootstrapping
      // from the website's shared refresh cookie) → keep the 20-day alarm armed.
      await ensureRefreshAlarm();
      return tok.accessToken;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * Resolve the current session, bootstrapping from the browser where possible so
 * that logging in on EITHER side logs in both. Resolution order:
 *   1. A non-expired locally-cached session (explicit extension login / a prior
 *      refresh).
 *   2. A silent refresh against the shared aisee_auth refresh_token cookie
 *      (aisee-app login sets this client-side). Persisted by refresh().
 *   3. A frontend `auth` cookie (postiz apps/frontend login sets only this).
 *      Deliberately NOT persisted, so a browser logout reflects immediately.
 * Returns null only when there is no session on any of these — i.e. genuinely
 * logged out everywhere.
 */
async function resolveSession(): Promise<AccessState | null> {
  const cur = await loadAccess();
  const now = Math.floor(Date.now() / 1000);
  if (cur?.accessToken && cur.expiresAt - now > EXPIRY_SKEW_SECONDS) {
    alog('resolveSession: cached token still valid', cur.expiresAt - now, 's left');
    return cur;
  }
  alog('resolveSession: stale/absent → refresh', {
    has: !!cur?.accessToken,
    expiresAt: cur?.expiresAt,
    now,
  });
  if (await refresh()) {
    const after = await loadAccess();
    if (after?.accessToken) return after;
  }
  // Last resort: the postiz frontend session cookie (browser→extension bridge).
  return readFrontendAuthSession();
}

/** A non-expired access token, refreshing silently if needed. null = re-login. */
export async function getValidAccessToken(): Promise<string | null> {
  return (await resolveSession())?.accessToken ?? null;
}

/**
 * Current logged-in user (or null), for the popup to render login state. Shares
 * resolveSession() with getValidAccessToken so the popup reflects a browser
 * login made on either frontend (aisee-app via the refresh cookie, or postiz
 * apps/frontend via the `auth` cookie) without a separate extension login.
 */
export async function getAuthUser(): Promise<AuthUser | null> {
  return (await resolveSession())?.user ?? null;
}

/**
 * Browser→extension bootstrap from a page token pushed by the content-script
 * auth bridge — the aisee localStorage `access_token` (which the background
 * cannot read itself) or the postiz `auth` cookie. Lets the popup reflect a
 * browser login that never established an extension session of its own. An empty
 * token means the page logged out → drop a previously bridged session (but never
 * an explicit extension login, which has its own refresh-token-backed session).
 */
export async function bootstrapFromFrontendToken(token?: string): Promise<void> {
  const cur = await loadAccess();
  const now = Math.floor(Date.now() / 1000);

  if (!token) {
    if (cur?.fromFrontend) {
      alog('bootstrap: page logged out → clearing bridged session');
      await clearAccess();
    }
    return;
  }

  const user = deriveUserFromToken(token);
  if (!user) {
    alog('bootstrap: token has no identity claims → ignored');
    return;
  }
  const claims = decodeJwt(token);
  const exp = Number(claims?.exp) || 0;
  if (exp && exp - now <= EXPIRY_SKEW_SECONDS) {
    alog('bootstrap: token expired → ignored');
    return;
  }
  // Never clobber a live explicit extension login.
  if (
    cur?.accessToken &&
    !cur.fromFrontend &&
    cur.expiresAt - now > EXPIRY_SKEW_SECONDS
  ) {
    return;
  }
  alog('bootstrap: bridged frontend session', {
    who: user.email || user.username || user.id,
  });
  await saveAccess({
    accessToken: token,
    expiresAt: exp || now + 3600,
    user,
    fromFrontend: true,
  });
}

/**
 * Clear the frontend `auth` session cookie on every granted origin so a popup
 * logout actually ends the browser session — otherwise the next popup open would
 * re-detect the still-present cookie and show logged-in again. Uses the same
 * explicit-origin probe as readFrontendAuthSession (getAll misses port origins),
 * and only removes cookies that decode to OUR session JWT. */
async function clearFrontendAuthCookies(): Promise<void> {
  for (const origin of frontendCookieOrigins()) {
    const value = await getAuthCookie(origin);
    if (!value || !deriveUserFromToken(value)) continue; // not ours — leave it
    await new Promise<void>((resolve) => {
      try {
        chrome.cookies.remove({ url: origin, name: 'auth' }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }
}

/** Log out: revoke server-side, clear the cookies, token, and refresh alarm. */
export async function logout(): Promise<void> {
  const base = await resolveAuthBase();
  alog('logout: revoking at', base);
  try {
    const rt = await readRefreshCookie(base);
    await fetch(`${base}/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rt ? { refresh_token: rt } : {}),
    });
  } catch {
    /* best-effort — still clear locally below */
  }
  await new Promise<void>((resolve) => {
    try {
      chrome.cookies.remove({ url: base, name: 'refresh_token' }, () =>
        resolve()
      );
    } catch {
      resolve();
    }
  });
  // Also drop the postiz frontend `auth` cookie(s) so the popup's cookie-based
  // bootstrap doesn't immediately resurrect the session after logout.
  await clearFrontendAuthCookies();
  await clearAccess();
  await chrome.alarms.clear(REFRESH_ALARM);
}

async function ensureRefreshAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(REFRESH_ALARM);
  if (!existing) {
    chrome.alarms.create(REFRESH_ALARM, {
      periodInMinutes: REFRESH_PERIOD_MINUTES,
      delayInMinutes: REFRESH_PERIOD_MINUTES,
    });
  }
}

/** Background alarm handler — fire a silent refresh on the 20-day tick. */
export async function handleAuthAlarm(name: string): Promise<void> {
  if (name === REFRESH_ALARM) await refresh();
}

/** Re-arm the alarm on SW/browser startup if still logged in (alarms are
 *  cleared on extension reload/update). */
export async function reArmRefreshAlarmIfLoggedIn(): Promise<void> {
  const cur = await loadAccess();
  if (cur?.accessToken) await ensureRefreshAlarm();
}

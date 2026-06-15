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

/** Minimal user derived from the access-token JWT (sub + email) — used when the
 *  session is bootstrapped from the shared refresh cookie (website login). */
function deriveUserFromToken(token: string): AuthUser | undefined {
  const p = decodeJwt(token);
  if (!p?.sub) return undefined;
  return { id: String(p.sub), email: String(p.email || ''), username: p.username };
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

/** A non-expired access token, refreshing silently if needed. null = re-login. */
export async function getValidAccessToken(): Promise<string | null> {
  const cur = await loadAccess();
  const now = Math.floor(Date.now() / 1000);
  if (cur?.accessToken && cur.expiresAt - now > EXPIRY_SKEW_SECONDS) {
    alog('getValidAccessToken: cached token still valid', cur.expiresAt - now, 's left');
    return cur.accessToken;
  }
  alog('getValidAccessToken: stale/absent → refresh', { has: !!cur?.accessToken, expiresAt: cur?.expiresAt, now });
  return refresh();
}

/**
 * Current logged-in user (or null), for the popup to render login state. This
 * BOOTSTRAPS from the shared refresh_token cookie: if there's no local session
 * but the user logged in on the website (shared `.aisee.live` cookie), a silent
 * refresh establishes the extension session too — so login on either side logs
 * in both.
 */
export async function getAuthUser(): Promise<AuthUser | null> {
  const token = await getValidAccessToken();
  if (!token) return null;
  return (await loadAccess())?.user ?? null;
}

/** Log out: revoke server-side, clear the cookie, token, and refresh alarm. */
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

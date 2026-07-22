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

/** Snapshot all platforms in parallel; a platform probe never throws. */
export async function getSocialSessions(): Promise<SocialSessions> {
  const [x, reddit, aisee] = await Promise.all([
    getXSession(),
    getRedditSessionInfo(),
    getAiseeSession(),
  ]);
  return { x, reddit, aisee };
}

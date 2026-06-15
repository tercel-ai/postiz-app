import { ProviderList } from '@gitroom/extension/providers/provider.list';

/**
 * Browser→extension login bridge (content script half).
 *
 * The popup's logged-in state lives in the background service worker, which can
 * read cookies but NOT a page's localStorage. The aisee frontend keeps its
 * session token in localStorage('access_token') (the same source the in-browser
 * reply flow trusts); the postiz frontend uses the `auth` cookie. This bridge
 * runs on the app/frontend origins, reads whichever the page has, and pushes it
 * to the background so logging in on the website also logs the extension in —
 * and a logout (token gone) logs it out.
 */

/** True on social provider pages (x.com, linkedin) where the content script also
 *  runs — never read a page token there, it isn't an aisee/postiz session. */
function isProviderOrigin(): boolean {
  try {
    const host = window.location.hostname;
    return ProviderList.some((p) => {
      try {
        return new URL(p.baseUrl).hostname === host;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** Looks like a JWT: three dot-separated base64url segments. */
function looksLikeJwt(v: string | null | undefined): v is string {
  return !!v && v.split('.').length === 3;
}

/** The aisee/postiz session token currently in the page, or '' if logged out. */
function readPageToken(): string {
  try {
    const ls = window.localStorage.getItem('access_token');
    if (looksLikeJwt(ls)) return ls;
  } catch {
    /* localStorage may be blocked */
  }
  try {
    const m = document.cookie.match(/(?:^|;\s*)auth=([^;]+)/);
    if (m) {
      const v = decodeURIComponent(m[1]);
      if (looksLikeJwt(v)) return v;
    }
  } catch {
    /* document.cookie may be blocked */
  }
  return '';
}

/** Clear the page's session (extension→browser logout). Best-effort: drops the
 *  aisee localStorage token and the non-httpOnly `auth` cookie. */
function clearPageToken(): void {
  try {
    window.localStorage.removeItem('access_token');
  } catch {
    /* ignore */
  }
  try {
    document.cookie =
      'auth=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  } catch {
    /* ignore */
  }
}

export function installAuthBridge(): void {
  if (isProviderOrigin()) {
    console.log('[aisee-auth] bridge: provider origin, skipping');
    return;
  }
  console.log('[aisee-auth] bridge: installed on', window.location.origin);

  let last: string | null = null;
  const push = () => {
    const token = readPageToken();
    if (token === last) return; // de-dupe identical pushes
    last = token;
    console.log(
      '[aisee-auth] bridge: pushing token',
      token ? `present (${token.length} chars)` : 'EMPTY (logged out)'
    );
    try {
      chrome.runtime.sendMessage({ action: 'auth:bootstrap', token });
    } catch (e) {
      console.log('[aisee-auth] bridge: sendMessage failed', String(e));
      /* background may be asleep; the next focus/storage event retries */
    }
  };

  // Extension-initiated logout asks the page to drop its token, then reloads.
  try {
    chrome.runtime.onMessage.addListener((request) => {
      if (request?.action === 'auth:clear') {
        clearPageToken();
        last = '';
      }
    });
  } catch {
    /* ignore */
  }

  push();
  // Re-push so a login or logout performed in this tab propagates without the
  // user reopening the popup.
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key === 'access_token') push();
  });
  window.addEventListener('focus', push);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) push();
  });
}

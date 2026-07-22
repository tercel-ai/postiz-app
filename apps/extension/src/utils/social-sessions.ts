// Service-worker side of the `aisee:social-sessions` bridge: snapshot which
// social platforms the BROWSER is logged into — passively, from cookies only.
// NO network requests to the platforms and NO script injection: a login probe
// must never look like automation to X or Reddit (account-risk rule).
//
//   - X: `auth_token` presence = logged in; `twid` ("u%3D<id>") carries the
//     numeric user id.
//   - Reddit: `reddit_session` presence = logged in; the `token_v2` JWT payload
//     carries the account fullname (t2_*), decoded locally — no fetch.
//
// What this cannot give: usernames/avatars (X would need GraphQL calls, Reddit
// would need /api/me.json — both are active requests) and emails (neither
// platform exposes them to the browser session at all). Page localStorage of
// x.com/reddit.com is also unreachable from the SW without injecting scripts,
// so cookies are the only passive source.

import type {
  RedditSessionInfo,
  SocialSessions,
  XSessionInfo,
} from '@gitroom/helpers/extension/social-sessions';

const REDDIT_BASE = 'https://www.reddit.com';

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

async function getXSession(): Promise<XSessionInfo> {
  const authToken = await getXCookie('auth_token');
  if (!authToken) return { loggedIn: false };
  // twid looks like "u%3D1234567890" (url-encoded `u=<numeric id>`).
  const twid = await getXCookie('twid');
  let userId: string | undefined;
  const m = decodeURIComponent(twid).match(/u=(\d+)/);
  if (m) userId = m[1];
  return { loggedIn: true, ...(userId ? { userId } : {}) };
}

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

async function getRedditSession(): Promise<RedditSessionInfo> {
  // `reddit_session` is the login cookie: present while logged in, cleared on
  // logout — the same signal the reply poster's session cache keys off.
  const session = await getCookie(`${REDDIT_BASE}/`, 'reddit_session');
  if (!session) return { loggedIn: false };
  const token = await getCookie(`${REDDIT_BASE}/`, 'token_v2');
  const id = decodeRedditIdFromJwt(token);
  return { loggedIn: true, ...(id ? { id } : {}) };
}

/** Snapshot both platforms in parallel; a platform probe never throws. */
export async function getSocialSessions(): Promise<SocialSessions> {
  const [x, reddit] = await Promise.all([getXSession(), getRedditSession()]);
  return { x, reddit };
}

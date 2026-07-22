// Service-worker side of the `aisee:social-sessions` bridge: snapshot which
// social platforms the BROWSER is logged into, using only what the session
// itself exposes.
//
//   - Reddit: GET /api/me.json with the session cookies — the same endpoint the
//     reply poster uses — yields handle / t2_* id / display name / avatar.
//   - X: cookies only. `auth_token` presence = logged in; `twid` ("u%3D<id>")
//     carries the numeric user id. NO GraphQL calls from the SW — X data
//     collection must go through a real browser tab (account-risk rule), and a
//     login probe does not justify one, so username stays unresolved here.
//
// Neither platform exposes the account email to the browser session at all.

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

async function getRedditSession(): Promise<RedditSessionInfo> {
  try {
    const res = await fetch(`${REDDIT_BASE}/api/me.json`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    const json = await res.json().catch(() => ({}));
    const d = json?.data || {};
    const handle: string = d.name || '';
    if (!handle) return { loggedIn: false };
    const rawAvatar: string = d.snoovatar_img || d.icon_img || '';
    return {
      loggedIn: true,
      handle,
      ...(d.id ? { id: `t2_${d.id}` } : {}),
      name: d.subreddit?.title || handle,
      ...(rawAvatar
        ? { avatarUrl: String(rawAvatar).replace(/&amp;/g, '&') }
        : {}),
    };
  } catch {
    return { loggedIn: false };
  }
}

/** Snapshot both platforms in parallel; a platform probe never throws. */
export async function getSocialSessions(): Promise<SocialSessions> {
  const [x, reddit] = await Promise.all([getXSession(), getRedditSession()]);
  return { x, reddit };
}

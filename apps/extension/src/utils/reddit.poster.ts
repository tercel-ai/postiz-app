// In-browser Reddit reply (Option A): the extension background fetches Reddit
// with the user's own logged-in session (credentials: 'include'), so the
// request carries their cookies + loid and clears the WAF naturally. No cookie
// is extracted or sent to our server, and the request originates from the
// user's real browser/IP.

import { ReplyResult } from '@gitroom/extension/utils/reply.types';

export interface RedditReplyInput {
  url: string;
  text: string;
}

const REDDIT_BASE = 'https://www.reddit.com';

/**
 * Derive the Reddit "fullname" (thing id) to reply to from a post/comment URL.
 * - post:    /r/<sub>/comments/<postId>/<slug>/            -> t3_<postId>
 * - comment: /r/<sub>/comments/<postId>/<slug>/<commentId>/ -> t1_<commentId>
 */
export function resolveRedditThingId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }

  const parts = parsed.pathname.split('/').filter(Boolean);
  const ci = parts.indexOf('comments');
  if (ci === -1) return null;

  const postId = parts[ci + 1];
  const commentId = parts[ci + 3]; // after <postId>/<slug>/

  if (commentId && /^[a-z0-9]+$/i.test(commentId)) return `t1_${commentId}`;
  if (postId && /^[a-z0-9]+$/i.test(postId)) return `t3_${postId}`;
  return null;
}

/**
 * Extract the new comment's permalink + fullname from a /api/comment response
 * thing. Reddit's old endpoint returns one of TWO shapes:
 *  - structured JSON: { name: 't1_xxx', permalink: '/r/.../xxx/' }
 *  - HTML-render:     { id: 't1_xxx', content: '<div ... data-permalink="/r/.../xxx/" ...>' }
 */
export function parseRedditCommentThing(
  thing: any
): { permalink?: string; postId?: string } {
  if (!thing) return {};

  // fullname: structured uses `name`; HTML-render carries it in `id` (t1_…).
  const postId: string | undefined = thing.name || thing.id || undefined;

  let permalink: string | undefined;
  if (typeof thing.permalink === 'string' && thing.permalink) {
    permalink = `${REDDIT_BASE}${thing.permalink}`;
  } else {
    const html: string =
      (typeof thing.content === 'string' && thing.content) ||
      (typeof thing.contentHTML === 'string' && thing.contentHTML) ||
      '';
    const match = html.match(/data-permalink="([^"]+)"/);
    if (match) permalink = `${REDDIT_BASE}${match[1]}`;
  }

  return { permalink, postId };
}

/**
 * Fallback author parse: pull the comment author's handle + fullname out of the
 * /api/comment HTML-render thing (`data-author` / `data-author-fullname`). Used
 * only if the session (/api/me.json) didn't yield the author; no avatar here.
 */
export function parseRedditAuthorFromThing(
  thing: any
): { handle: string; id?: string } | undefined {
  const html: string =
    (typeof thing?.content === 'string' && thing.content) ||
    (typeof thing?.contentHTML === 'string' && thing.contentHTML) ||
    '';
  const handle = html.match(/data-author="([^"]+)"/)?.[1];
  if (!handle) return undefined;
  const id = html.match(/data-author-fullname="([^"]+)"/)?.[1];
  return { handle, ...(id ? { id } : {}) };
}

/**
 * Read the logged-in user's session from /api/me.json (needed for modhash anyway)
 * and derive the reply author from the SAME response — no extra request. The reply
 * is posted AS this user, so /api/me.json IS the author (handle/id/name/avatar).
 */
async function fetchRedditSession(): Promise<{
  modhash: string;
  name: string;
  author?: ReplyResult['author'];
}> {
  const res = await fetch(`${REDDIT_BASE}/api/me.json`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  const json = await res.json().catch(() => ({}));
  const d = json?.data || {};
  const name: string = d.name || '';

  let author: ReplyResult['author'] | undefined;
  if (name) {
    const rawAvatar: string = d.snoovatar_img || d.icon_img || '';
    author = {
      handle: name,
      id: d.id ? `t2_${d.id}` : undefined,
      name: d.subreddit?.title || name,
      avatarUrl: rawAvatar ? String(rawAvatar).replace(/&amp;/g, '&') : undefined,
    };
  }

  return { modhash: d.modhash || '', name, author };
}

// ── Session cache ──────────────────────────────────────────────────────────
// /api/me.json (modhash + author) is cached so we don't re-fetch it on every
// reply. Invalidated when the `reddit_session` cookie changes (account switch /
// re-login) or after a TTL. A stale modhash is caught at post time (retry).

const SESSION_CACHE_KEY = 'aisee_reddit_session';
const SESSION_TTL_MS = 10 * 60 * 1000;

interface RedditSession {
  modhash: string;
  name: string;
  author?: ReplyResult['author'];
}

/** Current reddit_session cookie value — the account-switch signal. */
function readRedditSessionCookie(): Promise<string> {
  return new Promise((resolve) => {
    try {
      chrome.cookies.get({ url: REDDIT_BASE, name: 'reddit_session' }, (c) =>
        resolve(c?.value || '')
      );
    } catch {
      resolve('');
    }
  });
}

function loadSessionCache(): Promise<any> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([SESSION_CACHE_KEY], (s) =>
        resolve(s?.[SESSION_CACHE_KEY] || null)
      );
    } catch {
      resolve(null);
    }
  });
}

function saveSessionCache(value: any): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [SESSION_CACHE_KEY]: value }, () => resolve());
    } catch {
      resolve();
    }
  });
}

export function clearRedditSessionCache(): Promise<void> {
  return saveSessionCache(null);
}

/**
 * Get the Reddit session, reusing the cache when the reddit_session cookie is
 * unchanged and the cache is within TTL. `forceRefresh` bypasses the cache (used
 * to recover from a stale modhash after a failed post).
 */
async function getRedditSession(forceRefresh = false): Promise<RedditSession> {
  const cookie = await readRedditSessionCookie();

  if (!forceRefresh && cookie) {
    const cache = await loadSessionCache();
    if (
      cache &&
      cache.cookie === cookie &&
      cache.modhash &&
      cache.name &&
      Date.now() - cache.at < SESSION_TTL_MS
    ) {
      return { modhash: cache.modhash, name: cache.name, author: cache.author };
    }
  }

  const fresh = await fetchRedditSession();
  if (fresh.name) {
    await saveSessionCache({
      cookie,
      modhash: fresh.modhash,
      name: fresh.name,
      author: fresh.author,
      at: Date.now(),
    });
  }
  return fresh;
}

/** POST one comment with a given session; returns the parsed response + errors. */
async function postCommentOnce(
  thingId: string,
  text: string,
  session: RedditSession
): Promise<{ data: any; errors: unknown[] }> {
  const body = new URLSearchParams({
    api_type: 'json',
    thing_id: thingId,
    text,
    uh: session.modhash,
  });
  const res = await fetch(`${REDDIT_BASE}/api/comment`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(session.modhash ? { 'X-Modhash': session.modhash } : {}),
    },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  const errors: unknown[] = data?.json?.errors || [];
  return { data, errors };
}

export async function postRedditComment(
  input: RedditReplyInput
): Promise<ReplyResult> {
  const text = (input.text || '').trim();
  if (!text) return { ok: false, error: 'Reply text is empty' };

  const thingId = resolveRedditThingId(input.url);
  if (!thingId) {
    return {
      ok: false,
      error: 'Could not parse a Reddit post/comment id from the URL',
    };
  }

  // 1) Confirm the user is logged in to Reddit in this browser + get modhash.
  //    Cached across replies; invalidated on account switch (cookie) / TTL.
  let session: RedditSession;
  try {
    session = await getRedditSession();
  } catch (e: any) {
    return { ok: false, error: `Reddit session check failed: ${e?.message || e}` };
  }
  if (!session.name) {
    return {
      ok: false,
      error: 'Not logged in to Reddit in this browser. Open reddit.com and log in first.',
    };
  }

  // 2) Post the comment as the logged-in user. If it errors (e.g. a stale cached
  //    modhash), force-refresh the session once and retry.
  try {
    let { data, errors } = await postCommentOnce(thingId, text, session);

    if (Array.isArray(errors) && errors.length > 0) {
      await clearRedditSessionCache();
      session = await getRedditSession(true);
      ({ data, errors } = await postCommentOnce(thingId, text, session));
    }

    if (Array.isArray(errors) && errors.length > 0) {
      return {
        ok: false,
        error: errors
          .map((e) => (Array.isArray(e) ? e.join(': ') : String(e)))
          .join('; '),
        detail: data,
      };
    }

    const thing = data?.json?.data?.things?.[0]?.data;
    const { permalink, postId } = parseRedditCommentThing(thing);
    // Author = the logged-in user (from /api/me.json, already fetched). Fall back
    // to the comment HTML's data-author only if the session somehow lacked it.
    const author: ReplyResult['author'] | undefined =
      session.author ??
      (() => {
        const a = parseRedditAuthorFromThing(thing);
        return a ? { handle: a.handle, id: a.id, name: a.handle } : undefined;
      })();

    return {
      ok: true,
      permalink,
      postId,
      author,
      message: 'Comment posted to Reddit.',
      detail: data,
    };
  } catch (e: any) {
    return { ok: false, error: `Reddit comment failed: ${e?.message || e}` };
  }
}

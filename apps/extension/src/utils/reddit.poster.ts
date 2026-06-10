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

/** Read the logged-in user's modhash + username from the session cookie. */
async function fetchRedditSession(): Promise<{ modhash: string; name: string }> {
  const res = await fetch(`${REDDIT_BASE}/api/me.json`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  const json = await res.json().catch(() => ({}));
  return {
    modhash: json?.data?.modhash || '',
    name: json?.data?.name || '',
  };
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
  let session: { modhash: string; name: string };
  try {
    session = await fetchRedditSession();
  } catch (e: any) {
    return { ok: false, error: `Reddit session check failed: ${e?.message || e}` };
  }
  if (!session.name) {
    return {
      ok: false,
      error: 'Not logged in to Reddit in this browser. Open reddit.com and log in first.',
    };
  }

  // 2) Post the comment as the logged-in user.
  try {
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
    const permalink = thing?.permalink
      ? `${REDDIT_BASE}${thing.permalink}`
      : undefined;

    return {
      ok: true,
      permalink,
      message: 'Comment posted to Reddit.',
      detail: data,
    };
  } catch (e: any) {
    return { ok: false, error: `Reddit comment failed: ${e?.message || e}` };
  }
}

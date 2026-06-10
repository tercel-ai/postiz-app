import { parseRedditCommentId } from '@gitroom/nestjs-libraries/engage/reddit-url';
import { getRedditToken, redditAuthHeaders } from '@gitroom/nestjs-libraries/engage/reddit-auth';
import { redditPublicGet } from '@gitroom/nestjs-libraries/engage/reddit-loid';

/**
 * The author of an engage reply (who actually posted it), persisted to
 * Post.settings.engageAuthor when no connected integration authored the reply.
 * Platform-agnostic: `handle` is the @username / u/username; id/name/avatarUrl are
 * best-effort enrichment. Shared by the X and Reddit lookups.
 */
export interface EngageAuthorProfile {
  handle: string;
  id?: string;
  name?: string;
  avatarUrl?: string;
}

/** GET a Reddit JSON endpoint via the app-only token (oauth host, no WAF) when
 *  available, else the public host through the loid/proxy path. Mirrors the dual
 *  path used by syncRedditMetrics. */
async function redditGet(
  oauthUrl: string,
  publicUrl: string,
  token: string | null,
  log: (m: string) => void
): Promise<{ ok: boolean; status?: number; text(): Promise<string> } | null> {
  if (token) {
    try {
      const r = await fetch(oauthUrl, { headers: redditAuthHeaders(token) });
      if (r.ok) return { ok: true, status: r.status, text: () => r.text() };
      log(`Reddit OAuth author lookup returned ${r.status}; retrying via public JSON`);
    } catch (err) {
      log(`Reddit OAuth author lookup failed; retrying via public JSON: ${(err as Error).message}`);
    }
  }
  try {
    const r = await redditPublicGet(publicUrl, {}, { log });
    return { ok: r.ok, status: r.status, text: () => r.text() };
  } catch (err) {
    log(`Reddit public author lookup failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Best-effort lookup of a Reddit reply's author from the comment URL. Unlike X,
 * the username is NOT in the URL — we resolve the comment id, fetch the comment to
 * read its `author`, then fetch the user's /about for avatar + display name.
 *
 * Always returns `{ handle }` when the comment is reachable and has a real author;
 * enriches with id/name/avatarUrl when /about succeeds. Returns null when the URL
 * has no comment id, the comment is unreachable, or the author is [deleted].
 * Never throws — enrichment failures degrade to handle-only.
 */
export async function fetchRedditAuthorProfile(
  replyUrl: string | null | undefined,
  log: (m: string) => void = () => {}
): Promise<EngageAuthorProfile | null> {
  const commentId = parseRedditCommentId(replyUrl);
  if (!commentId) return null;

  const token = await getRedditToken();

  // 1) comment → author (the redditor who posted the reply)
  const infoRes = await redditGet(
    `https://oauth.reddit.com/api/info?id=t1_${commentId}`,
    `https://www.reddit.com/api/info.json?id=t1_${commentId}`,
    token,
    log
  );
  if (!infoRes || !infoRes.ok) return null;

  let author: string | undefined;
  try {
    const json = JSON.parse(await infoRes.text()) as {
      data?: { children?: Array<{ data?: { author?: string } }> };
    };
    author = json.data?.children?.[0]?.data?.author;
  } catch {
    return null;
  }
  if (!author || author === '[deleted]') return null;

  const profile: EngageAuthorProfile = { handle: author };

  // 2) author → avatar + display name (best-effort; handle-only if it fails)
  const aboutRes = await redditGet(
    `https://oauth.reddit.com/user/${author}/about`,
    `https://www.reddit.com/user/${author}/about.json`,
    token,
    log
  );
  if (aboutRes?.ok) {
    try {
      const about = JSON.parse(await aboutRes.text()) as {
        data?: {
          id?: string;
          icon_img?: string;
          snoovatar_img?: string;
          subreddit?: { title?: string };
        };
      };
      const d = about.data;
      // Reddit serves icon_img with HTML-escaped & in the query string.
      const rawAvatar = (d?.snoovatar_img || d?.icon_img || '').replace(/&amp;/g, '&');
      const name = d?.subreddit?.title?.trim();
      if (d?.id) profile.id = `t2_${d.id}`;
      if (name) profile.name = name;
      if (rawAvatar) profile.avatarUrl = rawAvatar;
    } catch {
      /* keep handle-only on unparseable /about */
    }
  }

  return profile;
}

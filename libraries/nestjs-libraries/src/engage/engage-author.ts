import { parseRedditCommentId } from '@gitroom/nestjs-libraries/engage/reddit-url';
import { getRedditToken, redditAuthHeaders } from '@gitroom/nestjs-libraries/engage/reddit-auth';
import { redditPublicGet } from '@gitroom/nestjs-libraries/engage/reddit-loid';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

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

/**
 * Parsed Reddit `/user/<name>/about` profile. `followers` is the count of accounts
 * subscribed to the user's u/<name> profile subreddit (`data.subreddit.subscribers`)
 * — Reddit's real per-user follower number, which for most redditors is ~0. Null
 * when /about is unreachable or the field is absent.
 */
export interface RedditUserAbout {
  id?: string;        // t2_<id>
  name?: string;      // display name (subreddit.title)
  avatarUrl?: string;
  followers: number | null;
}

// ── Reddit author /about cache (L1 in-process + L2 per-server Redis) ──────────
// Author profiles change slowly; a scan wave can reference the same author across
// many posts and across orgs/workers. L1 dedupes within a process; L2 shares the
// fetch across every process on the host. Keyed by lowercase username (global —
// author followers are objective, not org-scoped). Mirrors the loid L1+L2 pattern;
// when REDIS_URL is unset, ioRedis is an in-memory stub and L2 degrades to L1-only.
const AUTHOR_TTL_MS = Number(process.env.ENGAGE_REDDIT_AUTHOR_TTL_MS ?? 6 * 60 * 60 * 1000); // 6h
const AUTHOR_TTL_SECONDS = Math.max(1, Math.floor(AUTHOR_TTL_MS / 1000));
const authorKey = (username: string) => `postiz:reddit:author:${username.toLowerCase()}`;

const _authorL1 = new Map<string, { value: RedditUserAbout; expiresAt: number }>();

async function readAuthorL2(username: string): Promise<RedditUserAbout | null> {
  try {
    const raw = await ioRedis.get(authorKey(username));
    return raw ? (JSON.parse(raw as string) as RedditUserAbout) : null;
  } catch {
    return null; // Redis unavailable → behave as L1-only
  }
}

async function writeAuthorL2(username: string, value: RedditUserAbout): Promise<void> {
  try {
    await ioRedis.set(authorKey(username), JSON.stringify(value), 'EX', AUTHOR_TTL_SECONDS);
  } catch {
    /* Redis unavailable → L1 still serves this process */
  }
}

/** Test-only: clear the in-process L1 author cache. */
export function _clearRedditAuthorL1(): void {
  _authorL1.clear();
}

/**
 * Cached fetch of a Reddit user's /about profile (incl. real follower count).
 * Returns null only on hard failure (unreachable / unparseable) — a successful
 * fetch with no follower field still resolves to `{ followers: null, ... }` and is
 * cached, so we don't re-hit Reddit's WAF for the same author within the TTL.
 */
export async function getRedditUserAbout(
  username: string,
  log: (m: string) => void = () => {}
): Promise<RedditUserAbout | null> {
  if (!username || username === '[deleted]') return null;

  const l1 = _authorL1.get(username.toLowerCase());
  if (l1 && l1.expiresAt > Date.now()) return l1.value;

  const l2 = await readAuthorL2(username);
  if (l2) {
    _authorL1.set(username.toLowerCase(), { value: l2, expiresAt: Date.now() + AUTHOR_TTL_MS });
    return l2;
  }

  const token = await getRedditToken();
  const aboutRes = await redditGet(
    `https://oauth.reddit.com/user/${username}/about`,
    `https://www.reddit.com/user/${username}/about.json`,
    token,
    log
  );
  if (!aboutRes?.ok) return null;

  let profile: RedditUserAbout;
  try {
    const about = JSON.parse(await aboutRes.text()) as {
      data?: {
        id?: string;
        icon_img?: string;
        snoovatar_img?: string;
        subreddit?: { title?: string; subscribers?: number };
      };
    };
    const d = about.data;
    // Reddit serves icon_img with HTML-escaped & in the query string.
    const rawAvatar = (d?.snoovatar_img || d?.icon_img || '').replace(/&amp;/g, '&');
    const name = d?.subreddit?.title?.trim();
    profile = {
      id: d?.id ? `t2_${d.id}` : undefined,
      name: name || undefined,
      avatarUrl: rawAvatar || undefined,
      followers: typeof d?.subreddit?.subscribers === 'number' ? d.subreddit.subscribers : null,
    };
  } catch {
    return null; // unparseable /about → hard failure, do not cache
  }

  _authorL1.set(username.toLowerCase(), { value: profile, expiresAt: Date.now() + AUTHOR_TTL_MS });
  await writeAuthorL2(username, profile);
  return profile;
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

  // 2) author → avatar + display name (best-effort; handle-only if it fails).
  // Shares the cached /about lookup with the scan-time post-author follower path.
  const about = await getRedditUserAbout(author, log);
  if (about) {
    if (about.id) profile.id = about.id;
    if (about.name) profile.name = about.name;
    if (about.avatarUrl) profile.avatarUrl = about.avatarUrl;
  }

  return profile;
}

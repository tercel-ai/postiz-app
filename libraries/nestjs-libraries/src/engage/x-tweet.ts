import { parseXHandle } from '@gitroom/nestjs-libraries/engage/resolve-x-reply-integration';
import { EngageAuthorProfile } from '@gitroom/nestjs-libraries/engage/engage-author';
import {
  recordApiUsage,
  X_USAGE,
} from '@gitroom/nestjs-libraries/database/prisma/api-usage/api-usage.service';

// The reply tweet id is the numeric snowflake in a /status/<id> permalink.
const TWEET_ID_RE = /\/status(?:es)?\/(\d+)/;
const WEB_STATUS_RE = /\/i\/web\/status\/(\d+)/;

/**
 * Extract the numeric tweet id from any X/Twitter status URL, the single source
 * of truth for "what id do we store / query metrics with". Robust to the formats
 * users actually paste:
 *   - tracking params / fragments:  .../status/123?s=20&t=ab  ·  .../status/123#x
 *   - host variants:                x.com · twitter.com · mobile.twitter.com
 *   - web intent permalinks:        x.com/i/web/status/123
 *   - missing scheme / whitespace:  "  x.com/u/status/123 "
 * Returns null when no id is present (e.g. a profile URL) — callers MUST treat
 * null as "not a valid reply URL", never persist it as a tweet with null id.
 */
export function parseXTweetId(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  // Prefer URL parsing so query/hash are stripped structurally; retry with an
  // assumed scheme for inputs like "x.com/u/status/123"; finally fall back to a
  // raw regex over the whole string (the regex stops at `?`, so params are safe).
  let path = trimmed;
  try {
    path = new URL(trimmed).pathname;
  } catch {
    try {
      path = new URL(`https://${trimmed}`).pathname;
    } catch {
      path = trimmed;
    }
  }
  return (
    path.match(WEB_STATUS_RE)?.[1] ?? path.match(TWEET_ID_RE)?.[1] ?? null
  );
}

/**
 * Best-effort lookup of a reply URL's author (the @handle in the permalink) via
 * the X API v2. Always returns at least `{ handle }` when the URL has a parseable
 * handle; enriches with id/name/avatarUrl when a token is available and the lookup
 * succeeds. Returns null only when no handle can be parsed. Never throws — any
 * enrichment failure degrades to handle-only so the caller can still record who
 * posted the reply.
 *
 * `bearerToken` lets callers pass an org-connected account's OAuth token (so the
 * lookup works without a global X_BEARER_TOKEN); when omitted it falls back to the
 * app-only bearer env var, and finally to handle-only.
 */
export async function fetchXAuthorProfile(
  url: string | null | undefined,
  bearerToken?: string
): Promise<EngageAuthorProfile | null> {
  const handle = parseXHandle(url);
  if (!handle) return null;

  const bearer = bearerToken || process.env.X_BEARER_TOKEN;
  if (!bearer) return { handle };

  try {
    const res = await fetch(
      `https://api.twitter.com/2/users/by/username/${handle}?user.fields=profile_image_url,name`,
      { headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return { handle };
    const json = (await res.json()) as {
      data?: { id?: string; name?: string; profile_image_url?: string };
    };
    const d = json.data;
    if (!d) return { handle };
    recordApiUsage('x', X_USAGE.USER_READ, 1); // 1 returned user record
    return {
      handle,
      ...(d.id ? { id: d.id } : {}),
      ...(d.name ? { name: d.name } : {}),
      ...(d.profile_image_url ? { avatarUrl: d.profile_image_url } : {}),
    };
  } catch {
    return { handle };
  }
}

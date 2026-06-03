// The Reddit comment id is the base36 token in a comment permalink:
//   /r/<sub>/comments/<postId>/<slug-or-"comment">/<commentId>/
// It is the single source of truth for "what id do we query metrics with"
// (fetched as t1_<commentId>) and for validating backfilled reply URLs. A URL
// that points at the POST (no <commentId> segment) or is truncated yields null.
const COMMENT_ID_RE = /\/comments\/[^/]+\/[^/]+\/([a-z0-9]+)\/?/;

/**
 * Extract the Reddit comment id from a comment permalink. Robust to the formats
 * users paste:
 *   - tracking params / fragments:  .../comment/og2vc34/?utm_source=share
 *   - new + legacy slugs:           .../<postId>/comment/<id>/  ·  .../<postId>/<title_slug>/<id>/
 *   - missing scheme / whitespace:  "  reddit.com/r/x/comments/p/c/og2vc34 "
 * Returns null when no comment id is present — callers MUST treat null as "not a
 * valid reply URL", never persist it as a syncable reply (it can never fetch).
 */
export function parseRedditCommentId(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  // Prefer URL parsing so query/hash are stripped structurally; retry with an
  // assumed scheme for inputs like "reddit.com/..."; finally fall back to a raw
  // regex over the whole string.
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
  return path.match(COMMENT_ID_RE)?.[1] ?? null;
}

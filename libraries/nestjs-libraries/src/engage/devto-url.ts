// The dev.to (Forem) comment id is the base36 token that addresses ONE comment.
// It is the single source of truth for "what id do we read metrics with" and for
// validating backfilled dev.to reply URLs, mirroring reddit-url.ts's role.
//
// Two shapes carry it, and BOTH are what a user actually has in hand:
//   canonical permalink   https://dev.to/<author>/comment/<shortId>
//   article + fragment    https://dev.to/<author>/<slug>#comment-<shortId>
// The second is what Forem's own timestamp / "Copy link" anchors point at (it is
// also what the extension reads the id off), so refusing it would reject the one
// link a user is most likely to paste. A URL that names only the ARTICLE carries
// no comment id and yields null — persisting that as a releaseURL would store a
// link whose metrics can never be fetched.
const COMMENT_PATH_RE = /^\/[^/]+\/comment\/([a-z0-9]+)\/?$/i;
const COMMENT_FRAGMENT_RE = /^#comment-([a-z0-9]+)$/i;

/**
 * Extract the dev.to comment shortId from a comment permalink or an article URL
 * carrying a `#comment-<id>` fragment. Tolerates a missing scheme and
 * surrounding whitespace, the way users paste links.
 *
 * Returns null when no comment id is present — callers MUST treat null as "not a
 * valid reply URL" rather than persist a link nothing can ever sync.
 */
export function parseDevtoCommentShortId(
  url: string | null | undefined
): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    try {
      parsed = new URL(`https://${trimmed}`);
    } catch {
      return null;
    }
  }
  if (!/(^|\.)dev\.to$/i.test(parsed.hostname)) return null;

  return (
    parsed.pathname.match(COMMENT_PATH_RE)?.[1] ??
    parsed.hash.match(COMMENT_FRAGMENT_RE)?.[1] ??
    null
  );
}

/**
 * The canonical permalink for a comment shortId. Forem serves the full article
 * page at this address with the comment as its subject, which is where the
 * per-comment reaction count is read from.
 *
 * `author` is the comment author's handle. Forem does not validate it (any
 * handle resolves the same comment), but the canonical form is what its own
 * "Report abuse" link uses, so it is what we store.
 */
export function devtoCommentPermalink(author: string, shortId: string): string {
  return `https://dev.to/${author}/comment/${shortId}`;
}

// `themeTitle` materializes verbatim into `Post.title`, which several platforms
// (Reddit, Hashnode and other blog channels) submit as the published post title.
// The generation prompt instructs the model to keep themeTitle clean and to
// encode the week+phase ONLY in themeKey ("w1:foundations") — but a prompt is a
// SOFT constraint, and the surrounding prompt is saturated with week/w1..wN
// language, so the model still occasionally leaks a "W1 - " week prefix. This is
// the HARD guarantee at the publish boundary: strip any leaked week label so no
// external platform ever receives a polluted title. The week is never lost — it
// stays in themeKey and is derivable from the post date.
//
// The token is stripped defensively across the shapes a model actually emits:
// "W1 - ", "Week 2 – " (en/em dash), "W3: ".
const WEEK_PREFIX_RE = /^\s*W(?:eek)?\s*\d+\s*[-–—:]+\s*/i;

/**
 * The publish-ready post title for a content item: its `themeTitle` with any
 * leading week label removed. Falls back to the trimmed original when stripping
 * would leave an empty string (so `Post.title` never violates its non-empty
 * contract for a degenerate "W1 -" theme).
 */
export function postTitleFromTheme(themeTitle: string): string {
  const stripped = themeTitle.replace(WEEK_PREFIX_RE, '').trim();
  return stripped || themeTitle.trim();
}

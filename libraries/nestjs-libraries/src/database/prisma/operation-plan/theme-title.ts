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

// Canonical form of a line for title-duplication comparison: markdown heading
// markers, bold/italic wrappers and surrounding quotes carry no meaning on the
// publish surface, and models decorate a repeated headline with exactly these
// plus trailing separators (":", "—", ".").
function normalizeTitleLine(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^([*_]{1,3})(.+?)\1$/, '$2')
    .replace(/^["'“”‘’]+/, '')
    .replace(/["'“”‘’]+$/, '')
    .replace(/[\s:\-–—.!?…]+$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * On title-submitting platforms (Reddit, Hacker News, Medium, dev.to) the post
 * title travels SEPARATELY (`Post.title`) and `content` is the body only — but
 * the model, writing article-style copy, still repeats the headline as the
 * content's first line, so the published post shows its title twice. The prompt
 * forbids this, but (as with the week prefix above) a prompt is a soft
 * constraint; this is the hard guarantee at the materialization boundary.
 *
 * Strips the first line of `content` when it duplicates `title` (ignoring
 * markdown heading/bold/quote decoration, trailing punctuation and case), plus
 * the blank lines that follow it. Left untouched when the first line is not the
 * title, or when stripping would leave the content empty (a degenerate
 * title-only content must stay non-empty).
 */
export function stripDuplicatedTitleFromContent(
  title: string,
  content: string
): string {
  const newlineIndex = content.indexOf('\n');
  const firstLine = newlineIndex === -1 ? content : content.slice(0, newlineIndex);
  const normalizedTitle = normalizeTitleLine(title);
  if (!normalizedTitle || normalizeTitleLine(firstLine) !== normalizedTitle) {
    return content;
  }
  const rest = newlineIndex === -1 ? '' : content.slice(newlineIndex + 1);
  const stripped = rest.trimStart();
  return stripped.trim() ? stripped : content;
}

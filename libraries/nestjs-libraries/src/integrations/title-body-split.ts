/**
 * The TITLE-vs-BODY split, for the platforms that submit the two through
 * separate fields (`TITLE_SEPARATED_PLATFORMS` in platform-content-profile.ts:
 * reddit, hackernews, medium, devto).
 *
 * Two halves of ONE contract live here on purpose:
 *
 *  - `parseTitledOutput` reads the `TITLE: …` first line a generator asks a
 *    model for, and
 *  - `stripDuplicatedTitleFromContent` removes the title when the model writes
 *    it AGAIN at the top of the body.
 *
 * Splitting them across modules is what lets the emitted format and the parser
 * drift apart, and a drift here is silent: the post still publishes, just with
 * a mangled title or a headline printed twice.
 *
 * `stripDuplicatedTitleFromContent` used to live in
 * `database/prisma/operation-plan/theme-title.ts`, private to the marketing
 * plan. It is not an operation-plan rule — it is a rule about these platforms —
 * and engage's reference-post generation needs exactly it the moment it can
 * target one of them. Its behaviour is unchanged by the move; the
 * operation-plan importers just point here now.
 */

// The exact token a generator tells the model to open its answer with, and the
// exact token the parser looks for. Shared so a prompt reword can never leave
// the parser hunting for a string nobody emits any more.
export const TITLE_LINE_PREFIX = 'TITLE:';

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
 * title travels SEPARATELY (`Post.settings.title`) and `content` is the body
 * only — but the model, writing article-style copy, still repeats the headline
 * as the content's first line, so the published post shows its title twice.
 * The prompt forbids this, but a prompt is a soft constraint; this is the hard
 * guarantee at the materialization boundary.
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

// The title line as it actually comes back. The prompt asks for a bare
// `TITLE: …`, but models decorate their own headings unprompted — `**TITLE:**`,
// `## TITLE:`, a lowercase `Title:`, a fullwidth colon in CJK output. Matching
// only the literal would reject a perfectly good title over a pair of asterisks
// and send the caller back to slicing a title out of the body, which is the
// exact defect this module exists to remove.
//
// Two branches, because a marker run sitting after the colon is ambiguous on
// its own: in `**TITLE:** Foo` it CLOSES the decorated label, in
// `TITLE: **Foo** and **Bar**` it OPENS the title's own bold. What resolves it
// is whether the LABEL was decorated, i.e. whether the line began with markers.
// Consuming it unconditionally (as one combined branch did) swallowed the
// title's opening `**` and left every later `**` paired with the wrong partner
// — `**Redis** vs **Postgres**` came back as `Redis vs Postgres**`.
const TITLE_LINE_RE =
  /^(?:[*_#]+\s*title[*_\s]*[:：][*_\s]*|\s*title[*_\s]*[:：]\s*)(.+)$/i;

/**
 * The title VALUE, cleaned of decoration that would otherwise publish
 * literally (Reddit shows `**Foo**` as three asterisks, not as bold).
 *
 * Deliberately NOT `normalizeTitleLine`: that one lowercases and drops
 * trailing punctuation because it exists to COMPARE two lines, and a title is
 * a user-visible string that must keep its case and its question mark.
 */
function cleanTitleValue(value: string): string {
  return value
    .trim()
    .replace(/^([*_]{1,3})([\s\S]+?)\1$/, '$2')
    // Bold applied to PART of the title — a model emphasising one term inside
    // its own headline, which the whole-string rule above cannot reach.
    // Restricted to `**…**` deliberately: `*`, `_` and `__` all occur as
    // ordinary characters in the titles these four platforms carry, and
    // stripping them costs more than the decoration does. `user_id`,
    // `snake_case`, `SELECT * FROM`, `__init__` are dev.to and Hacker News
    // titles, not markup — a general emphasis strip corrupts every one of
    // them, and would fire far more often than a model disobeys the "plain
    // text, no Markdown" instruction it is given. A stray single marker
    // publishes literally; a mangled identifier is worse and much likelier.
    .replace(/\*\*([\s\S]+?)\*\*/g, '$1')
    .replace(/[*_]+$/, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface TitledOutput {
  /**
   * The model's own title, or `null` when it did not emit a usable TITLE line.
   * `null` is a FALLBACK signal, never an error: the generation is already
   * paid for, so a caller derives a title some other way rather than failing.
   */
  title: string | null;
  /**
   * The body. Byte-for-byte `raw` whenever `title` is null, so a caller that
   * parses an untitled response is in exactly the state it would have been in
   * without this function at all.
   */
  body: string;
}

/**
 * Split a model response of the form
 *
 *     TITLE: <title>
 *     <blank line>
 *     <body…>
 *
 * into its two fields, and de-duplicate a title the model repeated at the top
 * of the body anyway.
 *
 * Only ever called for a target platform that actually submits a separate
 * title — everywhere else the response IS the body and running a parser over
 * it could only ever take something away.
 *
 * Degrades instead of failing, in both directions: no recognisable TITLE line,
 * or a response that is nothing BUT a title line, returns `{title: null, body:
 * raw}`. Handing back an empty body would turn "the model formatted its answer
 * oddly" into a lost, already-billed generation.
 */
export function parseTitledOutput(raw: string): TitledOutput {
  const newlineIndex = raw.indexOf('\n');
  const firstLine = newlineIndex === -1 ? raw : raw.slice(0, newlineIndex);
  const title = cleanTitleValue(TITLE_LINE_RE.exec(firstLine)?.[1] ?? '');
  if (!title) return { title: null, body: raw };

  const rest = newlineIndex === -1 ? '' : raw.slice(newlineIndex + 1);
  const body = stripDuplicatedTitleFromContent(title, rest.trimStart());
  if (!body.trim()) return { title: null, body: raw };
  return { title, body };
}

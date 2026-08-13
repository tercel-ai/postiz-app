// What a subreddit REQUIRES of a post, cached on the monitored-channel row.
//
// Why this is observed rather than fetched: Reddit's flair endpoints
// (/r/<sub>/api/link_flair[_v2].json) answer USER_REQUIRED to any unauthenticated
// caller — verified 2026-08-12 against r/ClaudeAI through the loid + proxy path,
// in a run where /r/<sub>/about.json returned 200, so the rejection is Reddit's
// auth check and not the WAF. The OAuth route that WOULD answer needs Reddit API
// credentials this deployment does not have, so no server-side call can read a
// flair list at all. What CAN read it is the browser extension: Reddit renders
// the real option set into its own submit page, and the extension is already
// there whenever it publishes. This module is the shape that observation is
// stored in.
//
// Storage lives on EngageTrackedAccount.metadata (an unstructured Json column)
// under a `reddit` sub-object rather than flattened beside the existing
// description/url/avatar keys: those are DISPLAY data written once at add time
// by redditSearch, these are PUBLISHING data written after the fact by whoever
// observed them. Different writers, different lifetimes — flattening would have
// them overwrite each other.

/**
 * One option from a subreddit's post-flair picker.
 *
 * Label only, deliberately. Reddit's flair TEMPLATE ID would be the better key,
 * but no observer this deployment has can see one: the extension reads the
 * picker's rendered text, and the endpoints that return ids answer
 * USER_REQUIRED without OAuth credentials this deployment does not have. A
 * modelled `id` was carried through every layer here for a while and never
 * written by anyone — add it back alongside an observer that can actually
 * populate it.
 */
export interface RedditFlairOption {
  /** Visible text, in Reddit's own casing and including any emoji. */
  label: string;
}

export interface RedditChannelCapability {
  /**
   * The subreddit's post-flair options. A SNAPSHOT: whoever writes it replaces
   * the whole list (see mergeRedditCapability). Absent = never observed, which
   * is not the same as "this subreddit has no flairs".
   */
  flairs?: RedditFlairOption[];
  /** Observed SUBMIT_VALIDATION_FLAIR_REQUIRED — a post here needs a flair. */
  flairRequired?: boolean;
  /** Observed POST_GUIDANCE_VALIDATION_FAILED — the title needs a tag. */
  titleTagRequired?: boolean;
  /** ISO timestamp of the observation this record came from. */
  observedAt?: string;
  /**
   * Which path observed it. Only the extension can — see RedditFlairOption —
   * so this is single-valued today and exists to keep the stored record
   * self-describing and to make widening it non-breaking.
   */
  source?: 'extension';
}

const MAX_FLAIRS = 100;
const MAX_LABEL_LENGTH = 128;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readFlairs(value: unknown): RedditFlairOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: RedditFlairOption[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    if (!label) continue;
    options.push({ label: label.slice(0, MAX_LABEL_LENGTH) });
    if (options.length >= MAX_FLAIRS) break;
  }
  return options;
}

/**
 * Read the capability record out of a row's raw `metadata`.
 *
 * Defensive on every key: the column is schema-less Json written by several
 * unrelated paths (and, for the flair list, ultimately by DOM scraping), so any
 * shape has to degrade to "not observed" rather than throw. An absent key and a
 * malformed one are deliberately indistinguishable to callers — both mean the
 * value cannot be trusted, and there is nothing a caller could do differently.
 */
export function readRedditCapability(metadata: unknown): RedditChannelCapability {
  const reddit = asRecord(asRecord(metadata).reddit);
  const flairs = readFlairs(reddit.flairs);
  return {
    ...(flairs ? { flairs } : {}),
    ...(typeof reddit.flairRequired === 'boolean'
      ? { flairRequired: reddit.flairRequired }
      : {}),
    ...(typeof reddit.titleTagRequired === 'boolean'
      ? { titleTagRequired: reddit.titleTagRequired }
      : {}),
    ...(typeof reddit.observedAt === 'string' ? { observedAt: reddit.observedAt } : {}),
    ...(reddit.source === 'extension' ? { source: reddit.source } : {}),
  };
}

/**
 * Fold one observation into a row's existing `metadata`, returning the whole
 * new metadata object (keys outside `reddit` are passed through untouched).
 *
 * Merge rules, which are the point of this function:
 *   - `flairs` REPLACES the stored list, never merges into it. The list is a
 *     snapshot of what the subreddit offers right now; union-ing would keep a
 *     flair alive in our cache forever after the mods deleted it.
 *   - the booleans are only written when the patch states them. `undefined`
 *     means "this observation did not cover it", NOT false — a publish that
 *     succeeded says nothing about whether flair is required, and must not
 *     silently clear a `flairRequired: true` learned from a real rejection.
 *   - `observedAt` is stamped on every write so staleness is comparable.
 */
export function mergeRedditCapability(
  metadata: unknown,
  patch: RedditChannelCapability,
  observedAt: string
): Record<string, unknown> {
  const existingMetadata = asRecord(metadata);
  const existing = readRedditCapability(metadata);
  const flairs = patch.flairs ? readFlairs(patch.flairs) : existing.flairs;

  const next: RedditChannelCapability = {
    ...(flairs?.length ? { flairs } : {}),
    ...(typeof patch.flairRequired === 'boolean'
      ? { flairRequired: patch.flairRequired }
      : typeof existing.flairRequired === 'boolean'
      ? { flairRequired: existing.flairRequired }
      : {}),
    ...(typeof patch.titleTagRequired === 'boolean'
      ? { titleTagRequired: patch.titleTagRequired }
      : typeof existing.titleTagRequired === 'boolean'
      ? { titleTagRequired: existing.titleTagRequired }
      : {}),
    observedAt,
    source: patch.source ?? existing.source ?? 'extension',
  };

  return { ...existingMetadata, reddit: next };
}

const normalizeLabel = (s: string): string =>
  s.replace(/\s+/g, ' ').trim().toLowerCase();

// Emoji, pictographs, symbol glyphs, and the invisible variation-selector /
// ZWJ glue that composes them. Flair labels routinely carry these ("📰News",
// "⇄ Transfer News" on r/football) and a generated label never does.
const DECORATION_RE = /[\p{Extended_Pictographic}\p{So}\p{Sk}️‍]/gu;

const coreLabel = (s: string): string =>
  normalizeLabel(s).replace(DECORATION_RE, '').replace(/\s+/g, ' ').trim();

/**
 * Resolve a proposed flair label against a subreddit's real option set, or null
 * when it matches nothing.
 *
 * Same two-pass rule the extension applies inside the submit page
 * (selectRedditFlairInPage), and deliberately so: whatever this returns is what
 * the extension will later have to find on the page, so a label this accepts and
 * that rejects would just be a hand-off with extra steps. Exact whole-text
 * first; only then a decoration-stripped comparison, and only when exactly one
 * option survives it — stripping emoji can make two distinct flairs collide, and
 * picking either would file a post under a topic nobody chose.
 *
 * Returns the OPTION, not the input: callers should carry Reddit's own text
 * forward so the extension's exact-match pass hits instead of relying on its
 * decoration-stripping fallback.
 */
export function matchRedditFlairLabel(
  proposed: string | null | undefined,
  options: RedditFlairOption[] | undefined
): RedditFlairOption | null {
  const want = normalizeLabel(proposed || '');
  if (!want || !options?.length) return null;

  const exact = options.find((o) => normalizeLabel(o.label) === want);
  if (exact) return exact;

  const core = coreLabel(want);
  if (!core) return null;
  const hits = options.filter((o) => coreLabel(o.label) === core);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * True when the patch carries nothing worth a database write. Callers use this
 * to skip a no-op UPDATE — the extension reports after every publish attempt,
 * and most of those attempts observe nothing new.
 */
export function isEmptyRedditCapability(patch: RedditChannelCapability): boolean {
  return (
    !patch.flairs?.length &&
    typeof patch.flairRequired !== 'boolean' &&
    typeof patch.titleTagRequired !== 'boolean'
  );
}

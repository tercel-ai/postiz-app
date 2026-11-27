// The "this Reddit post has no community yet" marker, and the settings surgery
// that resolves it.
//
// Reddit is the one platform an operation plan cannot publish to on content
// alone: the submit call needs a subreddit, and picking one means asking Reddit
// which communities exist and whether this text may be posted there. That read
// used to happen inline during plan generation (reddit-target-resolver), and a
// post whose subreddit could not be validated was DROPPED — so an unreachable
// Reddit meant the plan silently lost its Reddit half.
//
// Dropping was defensible while the backend was the only component that could
// ask Reddit anything. It is not any more: the browser extension reads Reddit
// with the user's own logged-in session, which has no egress to be blocked. So
// an unresolved post is now PARKED instead of discarded — materialized as a
// DRAFT carrying this marker in place of `settings.subreddit`, and completed
// later by whoever can answer.
//
// Both resolvers write the same field, which is the point: the backend fills it
// in immediately when its egress works, and the extension fills it in when the
// backend's does not. One state machine, one write path, one guard — rather than
// a backend branch and an extension branch that can disagree about what a
// half-resolved post looks like.
//
// The guard matters as much as the marker. A Reddit post in QUEUE with no
// subreddit cannot publish and cannot fail usefully: the extension's poster
// rejects it, the row stays QUEUE, and the publish-due poll re-offers it every
// minute forever. `settingsHavePendingRedditTarget` is what keeps a parked post
// out of that loop (see PostsRepository.extensionRoutedWhere).

/**
 * Key under `Post.settings` holding the marker. Also matched as a raw substring
 * by the publish-due query — `settings` is a JSON *string* column, so excluding
 * parked posts in SQL means a `contains` on this exact spelling. Changing it
 * requires changing that filter and migrating existing rows.
 */
export const REDDIT_TARGET_PENDING_KEY = 'redditTargetPending';

/** A resolved draft with an unfinished handoff to ordinary plan admission. */
export const REDDIT_PLAN_SCHEDULE_PENDING_KEY = 'redditPlanSchedulePending';

export function hasRedditPlanSchedulePending(settings: string | null | undefined): boolean {
  return parseSettings(settings)?.[REDDIT_PLAN_SCHEDULE_PENDING_KEY] === true;
}

export function markRedditPlanSchedulePending(settings: string): string {
  return JSON.stringify({ ...parseSettings(settings), [REDDIT_PLAN_SCHEDULE_PENDING_KEY]: true });
}

export function clearRedditPlanSchedulePending(settings: string): string {
  const parsed = parseSettings(settings);
  if (!parsed || !(REDDIT_PLAN_SCHEDULE_PENDING_KEY in parsed)) return settings;
  delete parsed[REDDIT_PLAN_SCHEDULE_PENDING_KEY];
  return JSON.stringify(parsed);
}

/** Why the backend could not resolve the target itself. Diagnostics + routing. */
export type RedditTargetPendingReason =
  /** Backend has no working route to Reddit (breaker open / no proxy / mode). */
  | 'egress-unavailable'
  /** The probe could not complete, so the candidate is unverified — not bad. */
  | 'probe-unreachable'
  /** Generation proposed no usable subreddit name at all. */
  | 'no-candidate'
  /** The destination was verified and is now waiting for flair selection. */
  | 'flair-pending';

/**
 * What a resolver needs to finish the job later. Everything here is a HINT, not
 * an instruction: the extension re-validates whatever it uses, because this was
 * written by a component that could not check it.
 */
export interface RedditTargetPending {
  /**
   * The subreddit generation proposed, normalized when it was a usable name and
   * null when it was not. The extension tries this first and searches only if it
   * turns out not to exist — so a good guess costs one lookup, not a search.
   */
  candidate: string | null;
  /** The post title Reddit requires, already title-tagged and clamped. */
  title: string;
  /** Proposed flair label, unverified. Absent when generation proposed none. */
  flairLabel?: string;
  /** A new plan expects validated flair options from the extension. */
  selectFlair?: true;
  /** This draft was reopened after a definitive no-match and still needs a selection. */
  flairCatalogRetry?: true;
  /** Observed rule for an already verified destination. */
  flairRequired?: true;
  reason: RedditTargetPendingReason;
  /** ISO timestamp — lets a stale-parked-post sweep exist later. */
  since: string;
}

/** The resolved header, as written into `settings.subreddit[0].value`. */
export interface RedditTargetResolution {
  subreddit: string;
  title: string;
  type: 'self';
  flairLabel?: string;
  flairRequired?: true;
  /** Last definitive catalog tried when the required selection had no match. */
  flairOptionsRevision?: string;
}

function parseSettings(settings: string | null | undefined): Record<string, any> | null {
  if (!settings) return null;
  try {
    const parsed = JSON.parse(settings);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function hasLegacyRedditFlairResolution(settings: string | null | undefined): boolean {
  return parseSettings(settings)?.redditLegacyFlairResolution === true;
}

/** The parked marker on a post, or null when it carries none. */
export function readRedditTargetPending(
  settings: string | null | undefined
): RedditTargetPending | null {
  const parsed = parseSettings(settings);
  const pending = parsed?.[REDDIT_TARGET_PENDING_KEY];
  if (!pending || typeof pending !== 'object') return null;
  if (typeof pending.title !== 'string') return null;
  return {
    candidate: typeof pending.candidate === 'string' ? pending.candidate : null,
    title: pending.title,
    ...(typeof pending.flairLabel === 'string' ? { flairLabel: pending.flairLabel } : {}),
    ...(pending.selectFlair === true ? { selectFlair: true as const } : {}),
    ...(pending.flairCatalogRetry === true ? { flairCatalogRetry: true as const } : {}),
    ...(pending.flairRequired === true ? { flairRequired: true as const } : {}),
    reason: (pending.reason ?? 'egress-unavailable') as RedditTargetPendingReason,
    since: typeof pending.since === 'string' ? pending.since : new Date(0).toISOString(),
  };
}

/** The explicit subreddit saved independently of the pending marker. */
export function readSavedRedditSubreddit(settings: string | null | undefined): string | undefined {
  const target = parseSettings(settings)?.subreddit?.[0]?.value?.subreddit;
  return typeof target === 'string' && target.trim() ? target : undefined;
}

/** The last effective option set tried for a required flair without a match. */
export function readTriedRedditFlairRevision(settings: string | null | undefined): string | undefined {
  const revision = parseSettings(settings)?.subreddit?.[0]?.value?.flairOptionsRevision;
  return typeof revision === 'string' && /^[a-f0-9]{64}$/.test(revision) ? revision : undefined;
}

/** The title last saved by the editor, including any user edits to a parked draft. */
export function readSavedRedditTitle(settings: string | null | undefined): string | undefined {
  const title = parseSettings(settings)?.subreddit?.[0]?.value?.title;
  return typeof title === 'string' && title.trim() ? title : undefined;
}

export function readSavedRedditFlairTemplateId(settings: string | null | undefined): string | undefined {
  const id = parseSettings(settings)?.subreddit?.[0]?.value?.flair?.id;
  return typeof id === 'string' && id.trim() ? id.trim().toLowerCase() : undefined;
}

/** An explicit template ID or label saved on the post, never a resolver hint. */
export function hasSavedRedditFlairSelection(settings: string | null | undefined): boolean {
  const target = parseSettings(settings)?.subreddit?.[0]?.value;
  return [target?.flair?.id, target?.flairLabel].some(
    value => typeof value === 'string' && Boolean(value.trim())
  );
}

/** True when this post is parked awaiting a subreddit. */
export function settingsHavePendingRedditTarget(
  settings: string | null | undefined
): boolean {
  return readRedditTargetPending(settings) !== null;
}

/**
 * Write a resolved target into a post's settings: fill `subreddit` in the shape
 * RedditSettingsDto expects. A known destination can retain its marker while
 * waiting for flair evidence. Completed resolutions clear it.
 *
 * `is_flair_required` is pinned false for the same reason the generator pins it
 * (see ResolvedRedditTarget): the DTO makes `flair` — a `{id, name}` whose id
 * needs OAuth — conditionally required on it, so a true here would make the post
 * fail validation on every later save. An observed requirement rides in
 * `flairRequired` instead.
 */
export function applyResolvedRedditTarget(
  settings: string | null | undefined,
  resolution: RedditTargetResolution,
  pending?: RedditTargetPending
): string {
  const parsed = parseSettings(settings) ?? {};
  if (pending) parsed[REDDIT_TARGET_PENDING_KEY] = pending;
  else delete parsed[REDDIT_TARGET_PENDING_KEY];
  parsed.subreddit = [
    {
      value: {
        subreddit: resolution.subreddit,
        title: resolution.title,
        type: resolution.type,
        is_flair_required: false,
        ...(resolution.flairLabel ? { flairLabel: resolution.flairLabel } : {}),
        ...(resolution.flairRequired ? { flairRequired: true } : {}),
        ...(resolution.flairOptionsRevision ? { flairOptionsRevision: resolution.flairOptionsRevision } : {}),
      },
    },
  ];
  return JSON.stringify(parsed);
}

/**
 * Drop the pending marker WITHOUT supplying a target — the resolver looked and
 * found nothing publishable. The caller decides what happens to the post (it is
 * soft-deleted today); this only makes the settings consistent with that.
 */
export function clearRedditTargetPending(
  settings: string | null | undefined
): string {
  const parsed = parseSettings(settings) ?? {};
  delete parsed[REDDIT_TARGET_PENDING_KEY];
  return JSON.stringify(parsed);
}

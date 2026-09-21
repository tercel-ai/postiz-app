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

/** Why the backend could not resolve the target itself. Diagnostics + routing. */
export type RedditTargetPendingReason =
  /** Backend has no working route to Reddit (breaker open / no proxy / mode). */
  | 'egress-unavailable'
  /** The probe could not complete, so the candidate is unverified — not bad. */
  | 'probe-unreachable'
  /** Generation proposed no usable subreddit name at all. */
  | 'no-candidate';

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
    reason: (pending.reason ?? 'egress-unavailable') as RedditTargetPendingReason,
    since: typeof pending.since === 'string' ? pending.since : new Date(0).toISOString(),
  };
}

/** True when this post is parked awaiting a subreddit. */
export function settingsHavePendingRedditTarget(
  settings: string | null | undefined
): boolean {
  return readRedditTargetPending(settings) !== null;
}

/**
 * Write a resolved target into a post's settings: fill `subreddit` in the shape
 * RedditSettingsDto expects and DELETE the pending marker, atomically in one
 * value so a post can never carry both.
 *
 * `is_flair_required` is pinned false for the same reason the generator pins it
 * (see ResolvedRedditTarget): the DTO makes `flair` — a `{id, name}` whose id
 * needs OAuth — conditionally required on it, so a true here would make the post
 * fail validation on every later save. An observed requirement rides in
 * `flairRequired` instead.
 */
export function applyResolvedRedditTarget(
  settings: string | null | undefined,
  resolution: RedditTargetResolution
): string {
  const parsed = parseSettings(settings) ?? {};
  delete parsed[REDDIT_TARGET_PENDING_KEY];
  parsed.subreddit = [
    {
      value: {
        subreddit: resolution.subreddit,
        title: resolution.title,
        type: resolution.type,
        is_flair_required: false,
        ...(resolution.flairLabel ? { flairLabel: resolution.flairLabel } : {}),
        ...(resolution.flairRequired ? { flairRequired: true } : {}),
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

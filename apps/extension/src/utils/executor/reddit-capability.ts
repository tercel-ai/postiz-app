// Report what a subreddit's own submit page revealed about its posting rules.
//
// This exists because nothing server-side can read it: Reddit's flair endpoints
// (/r/<sub>/api/link_flair[_v2].json) answer USER_REQUIRED to an unauthenticated
// caller — verified against r/ClaudeAI in a run where /r/<sub>/about.json
// returned 200, so it is Reddit's auth check and not the anti-bot WAF — and the
// OAuth route that would answer needs Reddit API credentials this deployment
// does not have. The extension is the only component that ever sees the real
// option set, as a by-product of publishing there.
//
// Strictly a by-product: every call site fires this WITHOUT awaiting it and
// swallows failures. Publishing is the job; losing an observation costs one
// more manual flair pick next time, while letting a reporting failure surface
// would cost a post.

import { backendCall } from '@gitroom/extension/utils/executor/api';

export interface RedditCapabilityReport {
  subreddit: string;
  /**
   * The subreddit's full flair option set, in Reddit's own casing. A SNAPSHOT —
   * the server replaces the stored list with it, so never send a partial read.
   */
  flairs?: string[];
  /**
   * Set ONLY when the rule was observed to apply — never `false`, which is why
   * the type is `true` rather than `boolean`.
   *
   * The server treats an absent boolean as "this observation did not cover it"
   * and a present one as authoritative, so a `false` that nobody observed
   * ERASES a `true` learned from a real rejection. That is reachable: the only
   * producer here is `redditPostRuleFromErrors`, which returns a required
   * boolean per rule and therefore reports `false` for whichever rule Reddit
   * did not happen to cite. A subreddit enforcing both a flair and a title tag
   * can reject on one at a time, so a title-tag-only bounce used to clear a
   * previously learned `flairRequired: true`.
   *
   * A genuine `false` is not observable on this path at all: `postRule` exists
   * only when a rule DID fire, and a submit that succeeds never reaches the
   * reporting code. If positive "no rule here" evidence ever becomes available,
   * widen this deliberately and add a merge test for it.
   */
  flairRequired?: true;
  titleTagRequired?: true;
}

/**
 * POST one observation. Resolves to false on any failure (including no session)
 * rather than throwing, so callers can `void` it without an unhandled rejection.
 */
export async function reportRedditCapability(
  report: RedditCapabilityReport
): Promise<boolean> {
  const subreddit = (report.subreddit || '').trim();
  const flairs = (report.flairs || [])
    .map((label) => (label || '').trim())
    // Match the server's per-label @MaxLength(128) as well as its
    // @ArrayMaxSize(100): class-validator rejects the WHOLE body on one
    // over-length label, so an unclamped label would cost the entire snapshot
    // rather than just itself — and deterministically, since the same picker
    // yields the same labels on every future publish there.
    .map((label) => label.slice(0, 128))
    .filter(Boolean)
    .slice(0, 100)
    .map((label) => ({ label }));

  // Truthiness, not `typeof === 'boolean'`: a `false` is never an observation
  // on this path (see RedditCapabilityReport), and forwarding one would erase a
  // stored `true`. The type says `?: true`, but this is the boundary that
  // actually reaches the database, so it enforces the rule at runtime too
  // rather than trusting every present and future caller to be type-checked.
  const flairRequired = report.flairRequired === true;
  const titleTagRequired = report.titleTagRequired === true;

  const hasObservation = flairs.length > 0 || flairRequired || titleTagRequired;
  if (!subreddit || !hasObservation) return false;

  try {
    const res = await backendCall('/engage/monitored-channels/reddit/capability', 'POST', {
      subreddit,
      ...(flairs.length ? { flairs } : {}),
      ...(flairRequired ? { flairRequired: true } : {}),
      ...(titleTagRequired ? { titleTagRequired: true } : {}),
    });
    if (!res.ok) {
      // `res.data` carries the parsed body on any status, which for a
      // class-validator 400 names the offending field and constraint. This warn
      // is the ONLY trace of a failed observation — the call is voided, the
      // publish is unaffected, and nothing reaches the user — so a bare status
      // would leave a systematic rejection indistinguishable from a transient
      // one, with nothing to debug from.
      console.warn('[aisee][reddit] capability report rejected', {
        subreddit,
        status: res.status,
        reason: res.data,
      });
    }
    return res.ok;
  } catch (e) {
    console.warn('[aisee][reddit] capability report failed', e);
    return false;
  }
}

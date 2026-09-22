// How long an X account's post may be — which is a property of the ACCOUNT's
// subscription, not of X.
//
// MEASURED on x.com by filling the composer and reading its countdown ring plus
// the Post button's aria-disabled: 280 weighted characters without a
// subscription, 25000 with one. The same account read 280 on 2026-09-15 and
// 25000 on 2026-09-22, having subscribed in between — so this is a moving fact
// about a customer, not a constant to hardcode.
//
// Nothing here can read it. X states the ceiling only in the logged-in web UI,
// so the browser EXTENSION observes it as a by-product of publishing, keeps it
// under the session cookie that invalidates it, and hands it to the web app
// over the social-sessions bridge (`XSessionInfo.maxWeighted`). The app then
// passes it down with the generation request.
//
// WHY IT IS NOT STORED SERVER-SIDE. It was, briefly: an endpoint, a column in
// `Integration.metadata`, and a seven-day expiry to stop a lapsed subscription
// being believed forever. All of that was machinery for keeping a COPY honest,
// and the copy bought nothing — the only client that generates is the one
// already holding the live value, read from the browser moments earlier. So the
// request carries it, and there is no copy to go stale.
//
// THE VALUE IS THEREFORE CLIENT-SUPPLIED, and treated as such: bounded at the
// DTO, re-checked here, and never trusted to widen anything beyond what X is
// known to grant. The blast radius of a wrong one is one wasted generation for
// the org that sent it — the same failure a stale stored copy produced, and the
// extension's own gate at publish time is the real backstop either way.
//
// THE TWO DIRECTIONS ARE NOT SYMMETRIC, and every default here follows from it:
//
//   too HIGH — the generated post fills the composer, X's Post button never
//     enables, and a tab plus a queue slot burn to produce advice that fails by
//     hand too. The generation is already paid for and the body is unusable.
//   too LOW — a shorter post than the customer could have had. Nothing fails.
//
// So: absent means 280, out-of-range means 280, unparseable means 280.

import { weightedLength } from '@gitroom/helpers/utils/count.length';

/** X's ceiling for an account with no subscription. Also the fallback, always. */
export const X_FREE_MAX_WEIGHTED = 280;

/** X's ceiling for a subscribed account (measured 2026-09-22). */
export const X_SUBSCRIBED_MAX_WEIGHTED = 25000;

/**
 * The ceiling to generate against, from whatever the request carried.
 *
 * Always answers a usable number, because the caller is about to spend a paid
 * generation and 280 is the ceiling every X account has. Anything outside the
 * range X is actually known to grant is not a more generous account — it is a
 * bug, a stale client, or a forged body — and is refused rather than honoured.
 *
 * Non-integers are floored rather than rejected: a client that computed a
 * ceiling from a percentage should get the conservative whole number, not a
 * silent fall back to the free tier.
 */
export function resolveRequestedXCeiling(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return X_FREE_MAX_WEIGHTED;
  }
  const floored = Math.floor(value);
  if (floored < X_FREE_MAX_WEIGHTED) return X_FREE_MAX_WEIGHTED;
  if (floored > X_SUBSCRIBED_MAX_WEIGHTED) return X_FREE_MAX_WEIGHTED;
  return floored;
}

/**
 * Does this account's ceiling allow a post longer than X's base 280?
 *
 * A named predicate rather than `> 280` at each call site: "is this a long-form
 * account" is the question the generation targets actually ask, and it keeps
 * the comparison from being re-derived (and re-argued) in three places.
 */
export function allowsLongForm(maxWeighted: number): boolean {
  return maxWeighted > X_FREE_MAX_WEIGHTED;
}

/**
 * Would X's Post button enable for this draft, on an account with this ceiling?
 *
 * Weighted, not `String.length` — X counts Chinese, Japanese, Korean and emoji
 * as 2 each, which is why a "short" Chinese post can be over a limit an English
 * one of the same character count clears. Inclusive: a draft exactly on the
 * ceiling still posts (measured at both 280 and 25000).
 */
export function fitsXCeiling(draft: string, maxWeighted: number): boolean {
  return weightedLength(draft) <= maxWeighted;
}

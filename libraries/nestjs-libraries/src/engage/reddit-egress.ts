// Whether this server can read Reddit at all, and a circuit breaker so it stops
// asking once it plainly cannot.
//
// Why this exists: every backend Reddit read rides redditPublicGet, whose only
// two routes are REDDIT_PROXY and a direct connection. Both can be dead at once,
// and in the incident that produced this file both WERE — the configured proxy
// reset every TLS connection (reddit.com and google.com alike, so not a Reddit
// block at all), and the direct route could not resolve reddit.com. Reddit
// itself was fine: the same request through a working egress returned 200.
//
// Without a breaker that failure is expensive rather than merely broken.
// redditPublicGet walks the full tier ladder on EVERY call — up to
// REDDIT_PROXY_MAX_RETRIES proxy attempts with a backoff between each, then a
// direct attempt, each with an 8s header timeout. One operation-plan generation
// resolving 20 Reddit posts therefore spends minutes discovering the same dead
// egress 20 times over. The breaker turns the second and later discoveries into
// a synchronous throw.
//
// It is also the signal that routes work to the browser extension. The extension
// reads Reddit with the user's own logged-in session, which has no egress
// problem to have, so "the backend cannot read Reddit" is precisely the
// condition under which a caller should hand the job to it instead. Callers ask
// isRedditBackendReadAvailable() BEFORE building a backend-shaped plan, rather
// than catching the throw afterwards.
//
// State is per-process and in memory. A shared (Redis) breaker was considered
// and rejected: the failure this models is a property of THIS process's egress,
// and the cost of each process learning separately is bounded at
// FAILURE_THRESHOLD wasted calls per open window.

/** Thrown by redditPublicGet when the breaker is open or reads are disabled. */
export class RedditEgressUnavailableError extends Error {
  constructor(public readonly reason: string) {
    super(`Reddit backend read unavailable: ${reason}`);
    this.name = 'RedditEgressUnavailableError';
  }
}

export type RedditEgressMode = 'auto' | 'backend' | 'extension';

/**
 * How the backend decides whether to attempt Reddit reads at all.
 *
 *   auto (default) — attempt them only when an egress proxy is configured, or
 *     REDDIT_DIRECT_READ=true says this host reaches reddit.com unaided. This
 *     encodes the deployment rule "no proxy configured ⇒ the extension is the
 *     only path", so an unconfigured install never burns a request discovering
 *     it has no route.
 *   backend — always attempt (the breaker still applies). For a host with clean
 *     egress that does not want to set REDDIT_DIRECT_READ.
 *   extension — never attempt. Every Reddit read is routed to the extension.
 */
export function redditEgressMode(): RedditEgressMode {
  const raw = (process.env.REDDIT_EGRESS_MODE || 'auto').trim().toLowerCase();
  return raw === 'backend' || raw === 'extension' ? raw : 'auto';
}

function hasConfiguredProxy(): boolean {
  return !!(
    process.env.REDDIT_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY
  );
}

function directReadAllowed(): boolean {
  return String(process.env.REDDIT_DIRECT_READ || '').toLowerCase() === 'true';
}

// Consecutive failures before the circuit opens. Three rather than one because a
// single failure is routinely transient (one flagged exit IP, one timeout) and
// opening on it would send work to the extension — which is slower and needs the
// user's browser awake — for a blip that would have cleared itself.
const FAILURE_THRESHOLD = Math.max(
  1,
  Number(process.env.REDDIT_EGRESS_FAILURE_THRESHOLD ?? 3)
);

// How long the circuit stays open before one probe is allowed through.
// Ten minutes trades a little staleness for a lot of latency: the failures this
// models (a dead proxy, a blocked IP, a DNS outage) are resolved by a human
// changing configuration, not by waiting, so probing often buys nothing.
const OPEN_MS = Math.max(
  1_000,
  Number(process.env.REDDIT_EGRESS_OPEN_MS ?? 10 * 60 * 1000)
);

interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
  lastReason: string | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}

const state: BreakerState = {
  consecutiveFailures: 0,
  openedAt: null,
  lastReason: null,
  lastFailureAt: null,
  lastSuccessAt: null,
};

/** The configuration-only half of the gate. Pure. */
function modeBlockedReason(): string | null {
  const mode = redditEgressMode();
  if (mode === 'extension') return 'REDDIT_EGRESS_MODE=extension';
  if (mode === 'auto' && !hasConfiguredProxy() && !directReadAllowed()) {
    return 'no REDDIT_PROXY configured and REDDIT_DIRECT_READ is not true';
  }
  return null;
}

/**
 * Why a backend read is refused right now, or null when one may be attempted.
 *
 * NOT pure: when the open window has elapsed this admits one caller and closes
 * the window as it does so, which is what makes the half-open probe exactly one
 * caller rather than every caller. Anything that only wants to LOOK at the
 * breaker must use redditEgressSnapshot, which does not consume that slot.
 */
export function redditBackendReadBlockedReason(
  now: number = Date.now()
): string | null {
  const mode = modeBlockedReason();
  if (mode) return mode;
  if (state.openedAt === null) return null;
  if (now - state.openedAt >= OPEN_MS) {
    // Half-open: let exactly one caller through to re-probe. Clearing openedAt
    // here (rather than on the probe's result) is what makes it exactly one —
    // the next caller sees a closed breaker with the failure count still at the
    // threshold, so a single further failure re-opens it immediately.
    state.openedAt = null;
    return null;
  }
  return state.lastReason ?? 'recent consecutive failures';
}

/** True when a backend Reddit read may be attempted right now. */
export function isRedditBackendReadAvailable(now: number = Date.now()): boolean {
  return redditBackendReadBlockedReason(now) === null;
}

/** A completed Reddit read. Closes the breaker and clears the failure run. */
export function recordRedditEgressSuccess(now: number = Date.now()): void {
  state.consecutiveFailures = 0;
  state.openedAt = null;
  state.lastReason = null;
  state.lastSuccessAt = now;
}

/**
 * A Reddit read that could not complete — a transport failure, or a response
 * that proves the egress is blocked rather than the resource missing.
 *
 * Deliberately NOT called for a 404: that is Reddit answering, which means the
 * egress works. Counting it would open the breaker on a run of deleted
 * subreddits and route healthy traffic to the extension.
 */
export function recordRedditEgressFailure(
  reason: string,
  now: number = Date.now()
): void {
  state.consecutiveFailures += 1;
  state.lastReason = reason;
  state.lastFailureAt = now;
  if (state.consecutiveFailures >= FAILURE_THRESHOLD && state.openedAt === null) {
    state.openedAt = now;
  }
}

/**
 * Diagnostics (admin endpoints, tests). Never used for control flow — and,
 * unlike the gate above, it does NOT consume the half-open probe slot. Reading
 * a dashboard must not change which caller gets to retry Reddit.
 */
export function redditEgressSnapshot(now: number = Date.now()) {
  const halfOpenDue = state.openedAt !== null && now - state.openedAt >= OPEN_MS;
  const blockedReason =
    modeBlockedReason() ??
    (state.openedAt === null || halfOpenDue
      ? null
      : state.lastReason ?? 'recent consecutive failures');
  return {
    mode: redditEgressMode(),
    proxyConfigured: hasConfiguredProxy(),
    directReadAllowed: directReadAllowed(),
    available: blockedReason === null,
    blockedReason,
    consecutiveFailures: state.consecutiveFailures,
    openUntil: state.openedAt === null ? null : new Date(state.openedAt + OPEN_MS).toISOString(),
    lastReason: state.lastReason,
    lastFailureAt: state.lastFailureAt ? new Date(state.lastFailureAt).toISOString() : null,
    lastSuccessAt: state.lastSuccessAt ? new Date(state.lastSuccessAt).toISOString() : null,
    failureThreshold: FAILURE_THRESHOLD,
    openMs: OPEN_MS,
  };
}

/** Tests only: forget every observation. */
export function resetRedditEgressBreaker(): void {
  state.consecutiveFailures = 0;
  state.openedAt = null;
  state.lastReason = null;
  state.lastFailureAt = null;
  state.lastSuccessAt = null;
}

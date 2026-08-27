// How fast the extension may touch ONE platform account, across every track.
//
// WHY THIS IS NOT PER-TRACK
// -------------------------
// A platform rate-limits by ACCOUNT. Hacker News answers "You're posting too
// fast" without caring whether the write was a story or a comment — "posting"
// covers both, and one throttle counts them together. The extension, however,
// had a gap per track: the publish queue spaced post→post, the reply runner
// spaced reply→reply, and nothing at all spaced post→reply or reply→post. Two
// tracks writing to the same account were treated as unrelated because they
// carry different labels, so the only thing between them was the write gate's
// 2s browser hand-off — and a queued story going out seconds after an engage
// reply is exactly what tripped HN's throttle.
//
// So the unit here is the PLATFORM ACCOUNT, not the track: one clock per
// platform per kind, shared by publish, reply, scan, backfill and session
// maintenance alike.
//
// READS AND WRITES ARE SEPARATE BUDGETS
// -------------------------------------
// Not one number for both: platforms police them very differently. HN's posting
// gate is minutes wide, while browsing pages is what every real reader does all
// day. Pacing a scan at write speed would stop scanning working at all — hence
// writes in MINUTES, reads in SECONDS.
//
// RANGES, NOT FIXED VALUES
// ------------------------
// A fixed interval is itself a machine signature: an account that writes at
// exactly 30-minute spacing reads as automation more clearly than one that
// writes often. Every delay in this codebase already carries jitter (segment
// gaps, reply gaps, scan page delays); these ranges are the same idea applied to
// the one gap that was missing. A value is drawn per operation — see
// `drawPacingGapMs`.
//
// GRANULARITY IS ONE OPERATION
// ----------------------------
// These pace operations against EACH OTHER, never the steps inside one. A scan
// unit that fetches five pages is one operation; the pauses between its pages
// are `engage_scan_pacing`'s job. A thread is one operation per segment sent;
// the pause between segments is `segment_gap`'s. Applying an operation-level
// gap inside an operation would make a five-page scan take half an hour.

/** `[min, max]`, inclusive. A value is drawn from it per operation. */
export type PacingRange = [number, number];

/** Which budget an operation draws from. Writes and reads never share a clock. */
export type PacingKind = 'write' | 'read';

export interface PlatformPacingEntry {
  /** Gap between two WRITES on this platform, in minutes. */
  write?: PacingRange;
  /** Gap between two READS on this platform, in seconds. */
  read?: PacingRange;
  /** Clock-time window writes are allowed in. Absent = unconstrained. */
  window?: PacingWindow;
}

export interface PlatformPacing {
  /**
   * Applied to any platform without its own entry, and to any missing kind.
   * `write` and `read` always resolve to something (the built-in bottoms them
   * out); `window` is optional here too, because "no window" is a valid — and
   * the default — answer.
   */
  default: Required<Pick<PlatformPacingEntry, 'write' | 'read'>> &
    Pick<PlatformPacingEntry, 'window'>;
  platforms: Record<string, PlatformPacingEntry>;
}

/**
 * The built-in floor, used when the backend has not sent one (or its config is
 * unreadable). Deliberately present as CODE and not only as remote config: this
 * is a circuit breaker, and a breaker that stops working when the network does
 * is not a breaker.
 *
 * Only the Hacker News write figure is grounded in an observed limit — it is the
 * platform that produced the incident. The rest are conservative guesses whose
 * job is to be obviously-safe rather than optimal; the backend override exists
 * precisely so they can be tuned from measurements without shipping a build.
 */
export const DEFAULT_PLATFORM_PACING: PlatformPacing = {
  default: { write: [10, 30], read: [15, 45] },
  platforms: {
    // The throttle this whole mechanism exists for. Stories and comments share
    // it, which is why it must never be split per track.
    hackernews: { write: [15, 45], read: [15, 45] },
    // Comparable strictness, and the highest cost of getting it wrong: a
    // rate-limited HN account recovers, a banned Reddit account does not.
    reddit: { write: [15, 45], read: [15, 45] },
    x: { write: [3, 10], read: [10, 30] },
    linkedin: { write: [5, 15], read: [15, 45] },
    // Long-form platforms: a person does not publish articles minutes apart, so
    // a wide gap here costs nothing and looks far more natural.
    medium: { write: [30, 60], read: [15, 45] },
    devto: { write: [30, 60], read: [15, 45] },
    quora: { write: [10, 30], read: [15, 45] },
  },
};

// WHY EVERY READ CEILING SITS BELOW 60 SECONDS
// --------------------------------------------
// The extension's scan runner already pauses `interUnit` (60s + up to 60s jitter) between
// two units of the same scan, and that pause happens BEFORE it reaches this
// floor. Give the read budget a ceiling above 60s and a scan that is pacing
// itself perfectly well would still be turned away here, ending its round early
// for no gain — the platform had already waited longer than we were about to
// ask for. Keeping the ceiling under interUnit's floor means back-to-back units
// never pay twice, while the gap still does its real job: catching a DIFFERENT
// track (a URL backfill, a session renewal) that arrives right behind a scan.

/** Hard ceiling on any resolved gap, so a bad config cannot park a track forever. */
export const MAX_PACING_GAP_MS = 6 * 60 * 60 * 1000;

function sanitizeRange(
  range: PacingRange | undefined,
  toMs: (v: number) => number
): [number, number] | null {
  if (!Array.isArray(range) || range.length !== 2) return null;
  const [rawLo, rawHi] = range;
  if (!Number.isFinite(rawLo) || !Number.isFinite(rawHi)) return null;
  const lo = Math.max(0, Math.min(toMs(rawLo), MAX_PACING_GAP_MS));
  const hi = Math.max(lo, Math.min(toMs(rawHi), MAX_PACING_GAP_MS));
  return [lo, hi];
}

/**
 * The gap range for one platform+kind, in milliseconds.
 *
 * Resolution falls through platform entry → kind default → built-in default, so
 * a backend config that only overrides one platform (or only writes) stays
 * valid: everything it does not mention keeps the shipped floor rather than
 * collapsing to zero. A malformed range is treated as absent for the same
 * reason — the failure direction is "keep the floor", never "remove it".
 */
export function resolvePacingRangeMs(
  pacing: PlatformPacing,
  platform: string,
  kind: PacingKind
): [number, number] {
  const toMs = kind === 'write' ? (v: number) => v * 60_000 : (v: number) => v * 1_000;
  return (
    sanitizeRange(pacing.platforms?.[platform]?.[kind], toMs) ??
    sanitizeRange(pacing.default?.[kind], toMs) ??
    sanitizeRange(DEFAULT_PLATFORM_PACING.default[kind], toMs) ??
    [0, 0]
  );
}

/**
 * Draw the pause to enforce before the NEXT operation of this kind.
 *
 * Called once per operation, at the moment the operation is recorded — not at
 * check time. Drawing on every check would let a track that polls often
 * re-roll until it got a short gap, which is the opposite of what the jitter is
 * for.
 */
export function drawPacingGapMs(
  pacing: PlatformPacing,
  platform: string,
  kind: PacingKind,
  random: () => number = Math.random
): number {
  const [lo, hi] = resolvePacingRangeMs(pacing, platform, kind);
  return Math.round(lo + random() * (hi - lo));
}

// ── Write window ─────────────────────────────────────────────────────────────
//
// WHEN writes are allowed at all, as opposed to how far apart they must be.
//
// ONE window, shared by posting and replying. There used to be two, and their
// split was the same mistake the gaps had: `extension_publish.time_window` bound
// posting (per platform, 'HH:MM' in a real timezone) while
// `engage_reply_pacing.activeHoursUtc` bound replying (one global pair of UTC
// hours). Two settings for one question — "is now a reasonable hour to write as
// this account?" — that could disagree, and only one of which could even express
// a timezone.
//
// WRITES ONLY. Reads deliberately have no window: nobody is judged for loading
// pages at 3am, and pausing the scan overnight would just bunch its work up in
// the morning. What looks unnatural is an ACCOUNT that posts while its audience
// sleeps, and that is a property of writing.

/**
 * 'HH:MM' bounds in `timezone`. A window that wraps past midnight is honoured.
 *
 * Field names match the two shapes this replaces — `PublishTimeWindow` and the
 * per-project reply policy — so the three are structurally identical and no
 * caller needs a translation step just to compare them.
 */
export interface PacingWindow {
  windowStart: string;
  windowEnd: string;
  /** IANA timezone; absent resolves to UTC. */
  timezone?: string;
}

/**
 * Is `now` inside this window?
 *
 * FAILS CLOSED on a malformed window (bad 'HH:MM', an unknown timezone, or
 * start === end): the caller's next action is a platform write, and writing at
 * the wrong hour because a config was mistyped is worse than not writing. An
 * ABSENT window is a different thing entirely and means unconstrained — that is
 * the out-of-the-box state.
 *
 * `toLocalMinutes` is injected because the two runtimes resolve timezones
 * differently (the backend has dayjs/timezone loaded; the extension does not
 * need this function at all). It returns minutes-since-midnight in the window's
 * timezone, or null when the zone is unusable.
 */
export function withinPacingWindow(
  window: PacingWindow | undefined | null,
  now: Date,
  toLocalMinutes: (at: Date, timezone: string | undefined) => number | null
): boolean {
  if (!window) return true;
  const toMinutes = (hhmm: string): number | null => {
    if (!/^\d{2}:\d{2}$/.test(hhmm)) return null;
    const [hours, minutes] = hhmm.split(':').map(Number);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  };
  const start = toMinutes(window.windowStart);
  const end = toMinutes(window.windowEnd);
  if (start === null || end === null || start === end) return false;
  const nowMinutes = toLocalMinutes(now, window.timezone);
  if (nowMinutes === null) return false;
  return start <= end
    ? nowMinutes >= start && nowMinutes < end
    : nowMinutes >= start || nowMinutes < end;
}

/**
 * The window for one platform: platform entry → global default → none.
 *
 * "None" is a real answer and the default one — an unconfigured platform writes
 * whenever it is scheduled to, so adding this setting changes nothing until
 * somebody opts a platform in.
 */
export function resolvePacingWindow(
  pacing: PlatformPacing,
  platform: string
): PacingWindow | undefined {
  const entry = pacing.platforms?.[platform]?.window;
  if (entry && typeof entry === 'object') return entry;
  const fallback = pacing.default?.window;
  return fallback && typeof fallback === 'object' ? fallback : undefined;
}

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import {
  DEFAULT_PLATFORM_PACING,
  MAX_PACING_GAP_MS,
  PacingWindow,
  PlatformPacing,
  PlatformPacingEntry,
  PacingKind,
  resolvePacingRangeMs,
  resolvePacingWindow,
  withinPacingWindow,
} from '@gitroom/helpers/extension/platform-pacing';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Minutes since midnight in `zone`, or null when the zone is unusable.
 *
 * The timezone resolver `withinPacingWindow` is given: it lives here rather than
 * in the shared contract because resolving IANA zones needs dayjs's timezone
 * plugin, which the extension has no reason to carry.
 */
function localMinutes(at: Date, zone: string | undefined): number | null {
  try {
    const local = zone ? dayjs(at).tz(zone) : dayjs.utc(at);
    if (!local.isValid()) return null;
    return local.hour() * 60 + local.minute();
  } catch {
    return null;
  }
}

/**
 * The FLOOR between two operations on one platform account, whichever track
 * performs them.
 *
 * WHY THIS EXISTS ALONGSIDE THE TWO GAPS WE ALREADY HAD
 * -----------------------------------------------------
 * `extension_publish.min_gap` spaces post→post. `engage_reply_pacing`'s
 * minGapMinutes spaces reply→reply. Both are keyed by TRACK, and a platform
 * rate-limits by ACCOUNT: Hacker News answers "You're posting too fast" without
 * caring whether the write was a story or a comment. So the two edges nobody
 * owned were post→reply and reply→post, and a queued story going out seconds
 * after an engage reply is what tripped that throttle in production.
 *
 * A FLOOR, NOT A CADENCE. The two settings above stay exactly what they are:
 * expressions of how often the user WANTS to publish or reply. This is the
 * safety limit underneath them, derived from what the platform tolerates rather
 * than from anyone's preference — which is why it resolves with `max`, never
 * with `??`. A cadence may always be slower than the floor; it may never be
 * faster.
 *
 * MIRRORED IN THE EXTENSION. The same defaults ship in the extension as a
 * hard-coded fallback (utils/executor/platform-throttle.ts) and are enforced
 * there per operation. A breaker that stops working when the network does is
 * not a breaker, so the extension never depends on this config arriving — this
 * key only TUNES it without a redeploy.
 */
export const PLATFORM_PACING_KEY = 'platform_pacing';

@Injectable()
export class PlatformPacingConfigService implements OnModuleInit {
  private readonly logger = new Logger(PlatformPacingConfigService.name);

  constructor(private readonly _settings: SettingsService) {}

  async onModuleInit(): Promise<void> {
    const existing = await this._settings.get(PLATFORM_PACING_KEY);
    if (existing !== null && existing !== undefined) return;
    await this._settings.set(PLATFORM_PACING_KEY, DEFAULT_PLATFORM_PACING, {
      type: 'object',
      description:
        'Minimum spacing between two operations on the SAME platform account, across every track (publish, engage reply, scan, backfill, session renewal): ' +
        '{ default: { write: [minMinutes, maxMinutes], read: [minSeconds, maxSeconds] }, platforms: { <platform>: { write: [...], read: [...] } } }. ' +
        'A value is drawn from the range per operation — a fixed interval is itself a bot signature. ' +
        'WRITES are minutes and cover posts AND replies together (platforms count them against one throttle); READS are seconds and cover scanning, URL backfill and session renewal. ' +
        'This is a FLOOR, not a cadence: it is combined with extension_publish.min_gap and engage_reply_pacing.minGapMinutes with max(), so a slower cadence always wins and no cadence can go under it. ' +
        'Keep every read range under 60s — the extension scan already pauses interUnit (60s+) between units, and a higher ceiling would turn away scans that had already waited longer. ' +
        'Each bound is capped at 6 hours. ' +
        'WRITE WINDOW: an optional `window: { windowStart: "HH:MM", windowEnd: "HH:MM", timezone?: "<IANA>" }` on `default` and/or any platform decides WHEN writes are allowed at all — one window shared by publishing and replying (it replaced extension_publish.time_window and engage_reply_pacing.activeHoursUtc). ' +
        'Omit it for no restriction, which is the default; a window that wraps past midnight (22:00-02:00) is honoured as a wrap; windowStart === windowEnd is rejected because it would block every write. An unparseable window or an unresolvable timezone is DROPPED, leaving that platform unconstrained. ' +
        'The extension ships these same values as a built-in fallback, so clearing this key weakens nothing.',
      defaultValue: DEFAULT_PLATFORM_PACING,
    });
    this.logger.log(`Seeded default ${PLATFORM_PACING_KEY}`);
  }

  /** The stored config resolved onto the built-in floor. */
  async getPlatformPacing(): Promise<PlatformPacing> {
    const stored = await this._settings.get<PlatformPacing>(PLATFORM_PACING_KEY);
    return sanitizePlatformPacing(stored);
  }

  /**
   * The write floor for one platform, in MINUTES — what the reply driver and the
   * publish allocator combine with their own cadence.
   *
   * The range's LOWER bound: this is the answer to "how close together may two
   * writes ever be", and using the upper bound would silently turn the floor
   * into the cadence. The jitter within the range is the extension's business,
   * applied per operation where the actual write happens.
   */
  async getWriteFloorMinutes(platform: string): Promise<number> {
    return this.writeFloorMinutesFor(await this.getPlatformPacing(), platform);
  }

  /** The clock-time window writes are allowed in, or undefined when unconstrained. */
  async getWriteWindow(platform: string): Promise<PacingWindow | undefined> {
    const pacing = await this.getPlatformPacing();
    return resolvePacingWindow(pacing, platform);
  }

  // ── Pure variants, for callers that resolve the config once ────────────────
  //
  // getPlatformPacing() is a settings query on every call, and the reply driver
  // consults the window and the floor per (project × platform) inside a nested
  // loop. Reading through the async methods there was an N+1 on a value that
  // changes on the order of weeks. A caller that already holds a PlatformPacing
  // uses these instead; the async methods above stay for one-shot callers.

  /** As {@link isWithinWriteWindow}, against an already-resolved config. */
  isWithinWriteWindowFor(
    pacing: PlatformPacing,
    platform: string,
    now: Date
  ): boolean {
    return withinPacingWindow(resolvePacingWindow(pacing, platform), now, localMinutes);
  }

  /** As {@link getWriteFloorMinutes}, against an already-resolved config. */
  writeFloorMinutesFor(pacing: PlatformPacing, platform: string): number {
    return Math.round(resolvePacingRangeMs(pacing, platform, 'write')[0] / 60_000);
  }

  /**
   * May this platform be WRITTEN to at `now`?
   *
   * One question with one answer, for posting and replying alike. It used to
   * have two: `extension_publish.time_window` bound posting per platform in a
   * real timezone while `engage_reply_pacing.activeHoursUtc` bound replying with
   * one global pair of UTC hours — two settings that could disagree about the
   * same account, only one of which could name a timezone.
   */
  async isWithinWriteWindow(platform: string, now: Date): Promise<boolean> {
    return this.isWithinWriteWindowFor(await this.getPlatformPacing(), platform, now);
  }
}

/**
 * Resolve a stored value onto the built-in floor.
 *
 * A stored config that is missing, malformed, or only partially filled in must
 * never REMOVE the floor — every tier falls through to the shipped default, the
 * same posture the segment-gap and min-gap settings already take. The one thing
 * an admin can do here is make the floor wider or narrower, never absent.
 */
export function sanitizePlatformPacing(stored: unknown): PlatformPacing {
  if (!stored || typeof stored !== 'object') return DEFAULT_PLATFORM_PACING;
  const raw = stored as Partial<PlatformPacing>;
  const platforms: Record<string, PlatformPacingEntry> = {};
  if (raw.platforms && typeof raw.platforms === 'object') {
    for (const [key, entry] of Object.entries(raw.platforms)) {
      if (!entry || typeof entry !== 'object') continue;
      const clean: PlatformPacingEntry = { ...(entry as PlatformPacingEntry) };
      // A malformed window must not survive: it reaches the PUBLISH allocator,
      // which reads `window.windowStart.split(':')` and `dayjs.tz(...)`
      // unguarded. Dropping it leaves the platform unconstrained — the same
      // failure direction the old resolvePublishTimeWindows took, and the same
      // one the reply side takes when withinPacingWindow fails closed.
      if (!pickWindow(clean.window)) delete clean.window;
      platforms[key] = clean;
    }
  }
  return {
    default: {
      write: pickRange(raw.default?.write, DEFAULT_PLATFORM_PACING.default.write),
      read: pickRange(raw.default?.read, DEFAULT_PLATFORM_PACING.default.read),
      // An unset window is a meaningful value ("unconstrained"), so it must
      // survive as absent — but a malformed one is dropped rather than passed
      // on, for the reason above.
      ...(pickWindow(raw.default?.window) ? { window: raw.default!.window } : {}),
    },
    platforms,
  };
}

/**
 * A window wins only when it is structurally usable: 'HH:MM' bounds inside real
 * clock ranges, a non-empty span, and — when present — a timezone the runtime
 * can actually resolve.
 *
 * This restores the check `resolvePublishTimeWindows`/`isValidWindow` used to
 * apply before the window moved here. Without it the publish allocator receives
 * whatever JSON an admin PUT: `{start,end}` (wrong field names) reaches
 * `window.windowStart.split(':')` as undefined, and an unresolvable zone reaches
 * `dayjs.tz` — a TypeError and a RangeError respectively, both thrown from plan
 * activation rather than being quietly ignored.
 *
 * The reply side needs no equivalent because `withinPacingWindow` already fails
 * closed; dropping the value here makes the two sides agree on "unusable window
 * = no window" instead of one refusing and the other throwing.
 */
function pickWindow(candidate: unknown): candidate is PacingWindow {
  if (!candidate || typeof candidate !== 'object') return false;
  const w = candidate as Partial<PacingWindow>;
  const toMinutes = (v: unknown): number | null => {
    if (typeof v !== 'string' || !/^\d{2}:\d{2}$/.test(v)) return null;
    const [hours, minutes] = v.split(':').map(Number);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  };
  const start = toMinutes(w.windowStart);
  const end = toMinutes(w.windowEnd);
  // start === end is how an empty window is spelled — it would block every
  // write, so it is treated as unusable rather than honoured.
  if (start === null || end === null || start === end) return false;
  if (w.timezone === undefined) return true;
  if (typeof w.timezone !== 'string' || !w.timezone) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: w.timezone });
    return true;
  } catch {
    return false;
  }
}

/** A range wins only when both bounds are finite, ordered and non-negative. */
function pickRange(
  candidate: unknown,
  fallback: [number, number]
): [number, number] {
  if (!Array.isArray(candidate) || candidate.length !== 2) return fallback;
  const [lo, hi] = candidate as [unknown, unknown];
  if (typeof lo !== 'number' || typeof hi !== 'number') return fallback;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return fallback;
  if (lo < 0 || hi < lo) return fallback;
  return [lo, hi];
}

export { MAX_PACING_GAP_MS, type PacingKind, type PacingWindow, type PlatformPacing };

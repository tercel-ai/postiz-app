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
  PacingKind,
  resolvePacingRangeMs,
  resolvePacingWindow,
  withinPacingWindow,
} from '@gitroom/helpers/extension/platform-pacing';

import { sanitizePlatformPacing } from './platform-pacing-policy';

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

export { sanitizePlatformPacing } from './platform-pacing-policy';
export { MAX_PACING_GAP_MS, type PacingKind, type PacingWindow, type PlatformPacing };

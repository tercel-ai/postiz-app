import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHANNEL_DAILY_LIMIT,
  DEFAULT_REPLY_ACTIVE_HOURS,
  DEFAULT_REPLY_DAILY_LIMIT,
  DEFAULT_REPLY_WARMUP_TIERS,
  MAX_REPLY_DAILY_CEILING,
  PLATFORM_REPLY_RISK_CEILING,
  OPERATION_PLAN_REPLY_VOLUME,
  clockTimeToMinutes,
  localDayRange,
  resolveChannelDailyLimits,
  resolveReplyDailyCeilings,
  resolveReplyDailyLimit,
  jitterFactor,
  minutesLeftInWindow,
  replyGapMinutes,
  resolveReplySchedule,
  resolveReplyWarmupTiers,
  warmupFactorForDays,
  daysSince,
  windowMinutes,
} from '../engage-reply-schedule';

// The Automation page's reply schedule: ACTIVE HOURS plus a DAILY LIMIT, with
// the spacing between two replies derived from the pair rather than stored
// beside them.

describe('resolveReplySchedule', () => {
  it('fills in the default hours and limit for an unconfigured platform', () => {
    const schedule = resolveReplySchedule(undefined, 'x');

    expect(schedule.windowStart).toBe(DEFAULT_REPLY_ACTIVE_HOURS.start);
    expect(schedule.windowEnd).toBe(DEFAULT_REPLY_ACTIVE_HOURS.end);
    expect(schedule.dailyReplyLimit).toBe(DEFAULT_REPLY_DAILY_LIMIT);
  });

  it('keeps the configured hours and limit', () => {
    const schedule = resolveReplySchedule(
      { windowStart: '09:00', windowEnd: '17:00', dailyReplyLimit: 4 },
      'x'
    );

    expect(schedule.windowStart).toBe('09:00');
    expect(schedule.windowEnd).toBe('17:00');
    expect(schedule.dailyReplyLimit).toBe(4);
  });

  // Half a window is not a window: pairing a stored bound with a defaulted one
  // would invent hours nobody chose (08:00 against a stored 02:00 end reads as
  // an 18-hour working day).
  it('ignores a window that names only one side', () => {
    const schedule = resolveReplySchedule({ windowStart: '02:00' }, 'x');

    expect(schedule.windowStart).toBe('08:00');
    expect(schedule.windowEnd).toBe('18:00');
  });

  it('ignores a malformed clock time the same way', () => {
    const schedule = resolveReplySchedule(
      { windowStart: '9am', windowEnd: '17:00' },
      'x'
    );

    expect(schedule.windowStart).toBe('08:00');
    expect(schedule.windowEnd).toBe('18:00');
  });

  it('resolves the limit against an ADMIN ceiling when one is passed', () => {
    const schedule = resolveReplySchedule({ dailyReplyLimit: 20 }, 'x', {
      ceilings: { x: 6 },
    });

    expect(schedule.dailyReplyLimit).toBe(6);
  });

  it('keeps a window that wraps past midnight as a wrap, not as empty', () => {
    const schedule = resolveReplySchedule(
      { windowStart: '22:00', windowEnd: '02:00', dailyReplyLimit: 2 },
      'x'
    );

    // Four hours across two replies, not "a negative window".
    expect(windowMinutes(schedule.windowStart, schedule.windowEnd)).toBe(240);
    expect(replyGapMinutes(schedule, new Date('2026-08-18T22:00:00Z'))).toBe(120);
  });

  it('drops a timezone that is not a string', () => {
    // The policy comes off a JSON column, and a non-string reaching dayjs.tz
    // throws inside every gate that reads the schedule.
    const schedule = resolveReplySchedule(
      { timezone: 8 as unknown as string },
      'x'
    );

    expect(schedule.timezone).toBeUndefined();
  });

  it('never divides by a zero limit', () => {
    const schedule = resolveReplySchedule({ dailyReplyLimit: 0 }, 'x');

    expect(schedule.dailyReplyLimit).toBe(0);
    expect(
      Number.isFinite(replyGapMinutes(schedule, new Date('2026-08-18T12:00:00Z')))
    ).toBe(true);
  });
});

describe('resolveReplyDailyLimit', () => {
  it('clamps to the platform SAFETY ceiling rather than rejecting', () => {
    expect(resolveReplyDailyLimit(99, 'reddit')).toBe(PLATFORM_REPLY_RISK_CEILING.reddit);
    expect(resolveReplyDailyLimit(99, 'hackernews')).toBe(
      PLATFORM_REPLY_RISK_CEILING.hackernews
    );
  });

  // The two ceilings answer different questions and must not be merged again:
  // the editorial volume (x = 4) is what an operation plan is generated
  // against; a user deliberately asking for 10 a day on x is asking about rate,
  // and used to be silently given 4.
  it('does NOT clamp to the editorial reply volume', () => {
    expect(OPERATION_PLAN_REPLY_VOLUME.x.max).toBe(4);
    expect(resolveReplyDailyLimit(10, 'x')).toBe(10);
  });

  it('honours a request under the ceiling', () => {
    expect(resolveReplyDailyLimit(1, 'x')).toBe(1);
  });

  it('uses an admin ceiling in place of the built-in when given one', () => {
    expect(resolveReplyDailyLimit(99, 'x', { x: 12 })).toBe(12);
  });

  // 0 is a setting ("configured, and off for now"), not an absent field asking
  // for the default — `??` would have read the two the same way.
  it('honours a limit of zero', () => {
    expect(resolveReplyDailyLimit(0, 'x')).toBe(0);
  });

  it('falls back to the default for a missing or unusable value', () => {
    expect(resolveReplyDailyLimit(undefined, 'x')).toBe(DEFAULT_REPLY_DAILY_LIMIT);
    expect(resolveReplyDailyLimit(-3, 'x')).toBe(DEFAULT_REPLY_DAILY_LIMIT);
    expect(resolveReplyDailyLimit('4' as unknown as number, 'x')).toBe(
      DEFAULT_REPLY_DAILY_LIMIT
    );
  });

  it('is case-insensitive about the platform key', () => {
    // Nothing enforces the casing of a replyPolicies KEY at the API boundary.
    expect(resolveReplyDailyLimit(99, 'Reddit')).toBe(
      PLATFORM_REPLY_RISK_CEILING.reddit
    );
  });

  // A platform outside the engage capability list has no scanner, therefore no
  // opportunity and no reply path — there is nothing to clamp against.
  it('leaves a platform with no ceiling alone', () => {
    expect(resolveReplyDailyLimit(9, 'instagram')).toBe(9);
  });
});

// The admin override of the built-in ceilings (`engage_reply_daily_ceiling`).
describe('resolveReplyDailyCeilings', () => {
  it('returns the built-ins when nothing is stored', () => {
    expect(resolveReplyDailyCeilings()).toEqual({ ...PLATFORM_REPLY_RISK_CEILING });
    expect(resolveReplyDailyCeilings(null)).toEqual({ ...PLATFORM_REPLY_RISK_CEILING });
  });

  // MERGED, not replaced: an admin raising x alone must not silently drop the
  // other six platforms to "unbounded".
  it('folds a partial setting onto the built-ins', () => {
    const resolved = resolveReplyDailyCeilings({ x: 12 });

    expect(resolved.x).toBe(12);
    expect(resolved.reddit).toBe(PLATFORM_REPLY_RISK_CEILING.reddit);
  });

  it('ignores entries it cannot use', () => {
    const resolved = resolveReplyDailyCeilings({
      x: 'lots',
      reddit: -4,
      linkedin: 2.5,
    });

    expect(resolved.x).toBe(PLATFORM_REPLY_RISK_CEILING.x);
    expect(resolved.reddit).toBe(PLATFORM_REPLY_RISK_CEILING.reddit);
    expect(resolved.linkedin).toBe(PLATFORM_REPLY_RISK_CEILING.linkedin);
  });

  // A ceiling is the last thing between an automation and a banned account, so
  // a mistyped 3000 must not be able to remove it.
  it('caps any configured ceiling at the absolute maximum', () => {
    expect(resolveReplyDailyCeilings({ x: 3000 }).x).toBe(MAX_REPLY_DAILY_CEILING);
  });

  it('lowers a ceiling as readily as it raises one, and accepts 0', () => {
    expect(resolveReplyDailyCeilings({ x: 3 }).x).toBe(3);
    expect(resolveReplyDailyCeilings({ hackernews: 0 }).hackernews).toBe(0);
  });

  it('normalizes the platform key', () => {
    expect(resolveReplyDailyCeilings({ Reddit: 9 }).reddit).toBe(9);
  });

  it('accepts a platform the built-ins do not know', () => {
    expect(resolveReplyDailyCeilings({ mastodon: 5 }).mastodon).toBe(5);
  });
});

describe('localDayRange', () => {
  it('bounds the local day, not the UTC one', () => {
    const { since, until } = localDayRange(
      'Asia/Shanghai',
      new Date('2026-08-18T12:00:00Z')
    );

    expect(since.toISOString()).toBe('2026-08-17T16:00:00.000Z');
    expect(until.toISOString()).toBe('2026-08-18T16:00:00.000Z');
  });

  it('falls back to UTC for an unusable zone instead of throwing', () => {
    const { since, until } = localDayRange(
      'Not/A_Timezone',
      new Date('2026-08-18T12:00:00Z')
    );

    expect(since.toISOString()).toBe('2026-08-18T00:00:00.000Z');
    expect(until.toISOString()).toBe('2026-08-19T00:00:00.000Z');
  });
});

describe('windowMinutes / clockTimeToMinutes', () => {
  it('measures a plain window and a wrapping one', () => {
    expect(windowMinutes('08:00', '18:00')).toBe(600);
    expect(windowMinutes('22:00', '02:00')).toBe(240);
  });

  // The gate (`withinLocalWindow`) fails closed on these; here the safe side is
  // the direction of MORE spacing, so an unusable window reads as a full day.
  it('reads an unusable window as a full day', () => {
    expect(windowMinutes('08:00', '08:00')).toBe(1440);
    expect(windowMinutes('nope', '18:00')).toBe(1440);
  });

  it('rejects clock times that are not clock times', () => {
    expect(clockTimeToMinutes('08:30')).toBe(510);
    expect(clockTimeToMinutes('24:00')).toBeNull();
    expect(clockTimeToMinutes('08:60')).toBeNull();
    expect(clockTimeToMinutes('8:00')).toBeNull();
    expect(clockTimeToMinutes(undefined)).toBeNull();
  });
});

// WARM-UP: the fraction of a platform's ceiling an account may use, as a
// function of how long this automation has been replying as it. Not the
// platform account's age — that is never visible from a browser session — but
// the variable actually worth controlling.
describe('warmupFactorForDays', () => {
  it('walks the built-in ladder', () => {
    expect(warmupFactorForDays(0)).toBe(0.3);
    expect(warmupFactorForDays(6)).toBe(0.3);
    expect(warmupFactorForDays(7)).toBe(0.6);
    expect(warmupFactorForDays(29)).toBe(0.6);
    expect(warmupFactorForDays(30)).toBe(1);
    expect(warmupFactorForDays(400)).toBe(1);
  });

  // "We have never driven this account" is the slowest tier, not a free pass:
  // reading unknown as "fully warmed up" would skip warm-up for exactly the
  // accounts it exists for.
  it('reads null as day zero', () => {
    expect(warmupFactorForDays(null)).toBe(DEFAULT_REPLY_WARMUP_TIERS[0].factor);
    expect(warmupFactorForDays(undefined)).toBe(DEFAULT_REPLY_WARMUP_TIERS[0].factor);
    expect(warmupFactorForDays(-5)).toBe(DEFAULT_REPLY_WARMUP_TIERS[0].factor);
  });

  it('follows a custom ladder', () => {
    const tiers = [
      { days: 0, factor: 0.5 },
      { days: 14, factor: 1 },
    ];
    expect(warmupFactorForDays(13, tiers)).toBe(0.5);
    expect(warmupFactorForDays(14, tiers)).toBe(1);
  });

  // `resolveReplyWarmupTiers` rejects a ladder whose lowest rung is above day 0,
  // so this is the direction a DIRECT caller falls in — and the safe side of
  // that fall is "slower", never "unrestricted".
  it('falls to the slowest rung when an account is younger than the whole ladder', () => {
    expect(warmupFactorForDays(2, [{ days: 7, factor: 0.6 }])).toBe(0.6);
  });

  it('applies no discount when there is no ladder at all', () => {
    expect(warmupFactorForDays(2, [])).toBe(1);
  });
});

describe('daysSince', () => {
  it('counts whole elapsed days', () => {
    const now = new Date('2026-08-18T12:00:00Z');
    expect(daysSince(new Date('2026-08-16T12:00:00Z'), now)).toBe(2);
    // Same day, hours earlier — not yet a day.
    expect(daysSince(new Date('2026-08-18T01:00:00Z'), now)).toBe(0);
    expect(daysSince(null, now)).toBeNull();
  });

  // A clock skew that puts the first reply in the future must read as day 0,
  // never as a negative age that would walk off the bottom of the ladder.
  it('never goes negative', () => {
    expect(
      daysSince(new Date('2026-08-20T00:00:00Z'), new Date('2026-08-18T12:00:00Z'))
    ).toBe(0);
  });
});

describe('resolveReplyWarmupTiers', () => {
  it('returns the built-in ladder when nothing is stored', () => {
    expect(resolveReplyWarmupTiers()).toEqual([...DEFAULT_REPLY_WARMUP_TIERS]);
    expect(resolveReplyWarmupTiers([])).toEqual([...DEFAULT_REPLY_WARMUP_TIERS]);
  });

  it('accepts an operator ladder and sorts it', () => {
    expect(
      resolveReplyWarmupTiers([
        { days: 14, factor: 1 },
        { days: 0, factor: 0.5 },
      ])
    ).toEqual([
      { days: 0, factor: 0.5 },
      { days: 14, factor: 1 },
    ]);
  });

  // Taken WHOLE: a ladder is only meaningful as a curve, so half of one is
  // worse than none. Any unusable rung discards the stored value.
  it('discards the whole ladder when a rung is unusable', () => {
    expect(
      resolveReplyWarmupTiers([
        { days: 0, factor: 0.3 },
        { days: 'soon', factor: 1 },
      ])
    ).toEqual([...DEFAULT_REPLY_WARMUP_TIERS]);
    expect(resolveReplyWarmupTiers([{ days: -1, factor: 1 }])).toEqual([
      ...DEFAULT_REPLY_WARMUP_TIERS,
    ]);
  });

  // A ladder that does not start at day 0 leaves the riskiest days with no
  // rung, which reads as "no warm-up" — the opposite of what writing one means.
  it('rejects a ladder that does not start at day zero', () => {
    expect(resolveReplyWarmupTiers([{ days: 7, factor: 0.5 }])).toEqual([
      ...DEFAULT_REPLY_WARMUP_TIERS,
    ]);
  });

  // Warm-up only ever approaches the ceiling from below; it must never raise
  // one.
  it('clamps a factor into 0..1', () => {
    expect(resolveReplyWarmupTiers([{ days: 0, factor: 3 }])[0].factor).toBe(1);
    expect(resolveReplyWarmupTiers([{ days: 0, factor: -2 }])[0].factor).toBe(0);
  });
});

describe('resolveReplySchedule — warm-up', () => {
  // Absent vs null: a caller that never asks for warm-up must not be held to
  // 30% of the ceiling behind its back, while a caller that LOOKED and found no
  // history is reporting day 0 — the slowest tier.
  it('applies no discount when the caller states no warm-up clock', () => {
    const schedule = resolveReplySchedule({ dailyReplyLimit: 30 }, 'x');

    expect(schedule.warmupFactor).toBe(1);
    expect(schedule.dailyReplyLimit).toBe(30);
  });

  it('applies the slowest tier when the caller found no history', () => {
    const schedule = resolveReplySchedule({ dailyReplyLimit: 30 }, 'x', {
      warmupDays: null,
    });

    expect(schedule.warmupFactor).toBe(0.3);
    expect(schedule.dailyReplyLimit).toBe(9);
  });

  it('discounts the ceiling by the warm-up factor', () => {
    const schedule = resolveReplySchedule({ dailyReplyLimit: 30 }, 'x', {
      warmupDays: 2,
    });

    expect(schedule.dailyReplyLimit).toBe(9); // 30 × 0.3
    expect(schedule.warmupFactor).toBe(0.3);
  });

  // The discount bounds the CEILING, so a project asking for less than the
  // discounted number keeps what it asked for.
  it('leaves a modest request alone', () => {
    const schedule = resolveReplySchedule({ dailyReplyLimit: 4 }, 'x', {
      warmupDays: 2,
    });

    expect(schedule.dailyReplyLimit).toBe(4);
  });

  it('never discounts below one reply a day', () => {
    const schedule = resolveReplySchedule(undefined, 'hackernews', {
      warmupDays: 0,
      warmupTiers: [{ days: 0, factor: 0.01 }],
    });

    expect(schedule.dailyReplyLimit).toBe(1);
  });

  // A deliberate "off" survives warm-up: the floor lifts a discounted ceiling,
  // never a limit the user set to zero.
  it('still honours a limit of zero', () => {
    const schedule = resolveReplySchedule({ dailyReplyLimit: 0 }, 'x', {
      warmupDays: 0,
    });

    expect(schedule.dailyReplyLimit).toBe(0);
  });
});

describe('resolveChannelDailyLimits', () => {
  it('caps reddit and leaves the other platforms alone by default', () => {
    const limits = resolveChannelDailyLimits();

    expect(limits.reddit).toBe(DEFAULT_CHANNEL_DAILY_LIMIT.reddit);
    expect(limits.x).toBeUndefined();
  });

  it('folds an admin map onto the built-ins', () => {
    const limits = resolveChannelDailyLimits({ reddit: 1, linkedin: 2 });

    expect(limits.reddit).toBe(1);
    expect(limits.linkedin).toBe(2);
  });

  it('ignores entries it cannot use', () => {
    const limits = resolveChannelDailyLimits({ reddit: 'one', x: -1 });

    expect(limits.reddit).toBe(DEFAULT_CHANNEL_DAILY_LIMIT.reddit);
    expect(limits.x).toBeUndefined();
  });

  // 0 reads like "no channel may receive a reply", but the gate works by
  // EXCLUDING channels that already have replies today — a channel with none is
  // not in that set, so a 0 would have silently behaved as 1. "This platform
  // does not reply" is what the platform switch already says exactly.
  it('refuses a cap of zero rather than honouring it as one', () => {
    expect(resolveChannelDailyLimits({ reddit: 0 }).reddit).toBe(
      DEFAULT_CHANNEL_DAILY_LIMIT.reddit
    );
    expect(resolveChannelDailyLimits({ x: 0 }).x).toBeUndefined();
  });

  it('surfaces the cap on the resolved schedule', () => {
    expect(resolveReplySchedule(undefined, 'reddit').channelDailyLimit).toBe(
      DEFAULT_CHANNEL_DAILY_LIMIT.reddit
    );
    expect(resolveReplySchedule(undefined, 'x').channelDailyLimit).toBeUndefined();
  });
});

// The gap is BUDGET-based: what is LEFT of the active hours divided by what is
// still OWED today. The old formula divided the WHOLE window by the WHOLE limit
// once and never looked again — a floor, so any reply the day failed to place
// was lost for good and the account finished under its limit with hours of
// window unused.
describe('replyGapMinutes', () => {
  const schedule = (over: Record<string, unknown> = {}) =>
    resolveReplySchedule(
      { windowStart: '09:00', windowEnd: '17:00', dailyReplyLimit: 4, ...over },
      'x'
    );
  const at = (hhmm: string) => new Date(`2026-08-18T${hhmm}:00.000Z`);

  it('divides the REMAINING window by the REMAINING budget', () => {
    // 09:00, nothing sent: 480 minutes across 4 replies.
    expect(replyGapMinutes(schedule(), at('09:00'), { sentToday: 0 })).toBe(120);
    // 13:00, two sent: 240 minutes across the 2 still owed.
    expect(replyGapMinutes(schedule(), at('13:00'), { sentToday: 2 })).toBe(120);
  });

  // The self-correction the whole change exists for.
  it('tightens the gap for a day that has fallen behind', () => {
    // 15:00 with nothing sent: 120 minutes left, still 4 owed.
    expect(replyGapMinutes(schedule(), at('15:00'), { sentToday: 0 })).toBe(30);
  });

  it('stretches the gap for a day that is running ahead', () => {
    // 10:00 and 3 of 4 already sent: 420 minutes left for the last one.
    expect(replyGapMinutes(schedule(), at('10:00'), { sentToday: 3 })).toBe(420);
  });

  // Never longer than the window has left, or the last reply of the day is
  // parked past closing time by a gap drawn at 16:50.
  it('never reaches past the end of the window', () => {
    const gap = replyGapMinutes(schedule(), at('16:50'), { sentToday: 3 });

    expect(gap).toBeLessThanOrEqual(10);
    expect(gap).toBeGreaterThanOrEqual(1);
  });

  it('falls back to the flat window/limit when the day is unknown', () => {
    expect(replyGapMinutes(schedule(), at('09:00'))).toBe(120);
  });

  it('falls back to the flat window/limit outside the window', () => {
    // The window gate has already refused; this number only feeds a projection.
    expect(replyGapMinutes(schedule(), at('20:00'), { sentToday: 0 })).toBe(120);
  });

  it('honours the org-wide floor', () => {
    expect(
      replyGapMinutes(schedule(), at('15:00'), { sentToday: 0, minGapMinutes: 60 })
    ).toBe(60);
  });

  it('treats a spent day as having no pace to compute', () => {
    expect(replyGapMinutes(schedule(), at('13:00'), { sentToday: 4 })).toBe(120);
  });

  describe('jitter', () => {
    const lastAt = (iso: string) => new Date(iso);

    // A reply every 120 minutes on the dot is the bot signature this product
    // spends platform_pacing avoiding.
    it('varies the gap around the pace', () => {
      const gaps = new Set(
        ['09:01', '09:07', '09:23', '09:41', '10:05', '11:13'].map((hhmm) =>
          replyGapMinutes(schedule(), at('09:00'), {
            sentToday: 0,
            lastAt: lastAt(`2026-08-18T${hhmm}:00.000Z`),
          })
        )
      );

      expect(gaps.size).toBeGreaterThan(3);
      for (const gap of gaps) {
        expect(gap).toBeGreaterThanOrEqual(90);
        expect(gap).toBeLessThanOrEqual(150);
      }
    });

    // DETERMINISTIC, and that is the point: the gate is re-evaluated every five
    // minutes, and a factor DRAWN per check would let it re-roll until it got a
    // short gap — the opposite of what the jitter is for. The factor is derived
    // from the last reply's timestamp instead, so it is fixed for a cycle and
    // polling more often cannot change it.
    it('draws the same factor for a whole cycle, however often it is asked', () => {
      const seed = lastAt('2026-08-18T09:07:00.000Z').getTime();

      expect(jitterFactor(seed)).toBe(jitterFactor(seed));
      expect(jitterFactor(seed)).not.toBe(
        jitterFactor(lastAt('2026-08-18T09:12:00.000Z').getTime())
      );
    });

    // The gap DOES move within a cycle — the window is draining, so the pace
    // tightens. What matters is that it only ever moves one way: a number that
    // bounced up and down between polls would be a re-roll wearing a disguise,
    // and `nextCheckAt` would jitter around in front of the user.
    it('only ever tightens as the window drains, never bounces', () => {
      const seed = lastAt('2026-08-18T09:07:00.000Z');
      const gaps = ['09:10', '09:30', '09:50', '10:30', '11:30', '13:00'].map((hhmm) =>
        replyGapMinutes(schedule(), at(hhmm), { sentToday: 0, lastAt: seed })
      );

      for (let i = 1; i < gaps.length; i += 1) {
        expect(gaps[i]).toBeLessThanOrEqual(gaps[i - 1]);
      }
    });

    it('applies no jitter when there is no last reply to seed from', () => {
      expect(
        replyGapMinutes(schedule(), at('09:00'), { sentToday: 0, lastAt: null })
      ).toBe(120);
    });
  });
});

describe('minutesLeftInWindow', () => {
  const at = (hhmm: string) => new Date(`2026-08-18T${hhmm}:00.000Z`);

  it('measures to the end of a plain window', () => {
    const s = resolveReplySchedule({ windowStart: '09:00', windowEnd: '17:00' }, 'x');

    expect(minutesLeftInWindow(s, at('09:00'))).toBe(480);
    expect(minutesLeftInWindow(s, at('16:30'))).toBe(30);
    expect(minutesLeftInWindow(s, at('17:00'))).toBe(0);
    expect(minutesLeftInWindow(s, at('08:59'))).toBe(0);
  });

  it('measures through a window that wraps past midnight', () => {
    const s = resolveReplySchedule({ windowStart: '22:00', windowEnd: '02:00' }, 'x');

    expect(minutesLeftInWindow(s, at('23:00'))).toBe(180);
    expect(minutesLeftInWindow(s, at('01:00'))).toBe(60);
    expect(minutesLeftInWindow(s, at('12:00'))).toBe(0);
  });

  it('reads the window in the policy timezone', () => {
    const s = resolveReplySchedule(
      { windowStart: '09:00', windowEnd: '17:00', timezone: 'Asia/Shanghai' },
      'x'
    );

    // 02:00 UTC = 10:00 Shanghai — seven hours of the working day left.
    expect(minutesLeftInWindow(s, at('02:00'))).toBe(420);
  });

  it('fails closed on an unusable timezone', () => {
    const s = resolveReplySchedule(
      { windowStart: '09:00', windowEnd: '17:00', timezone: 'Not/A_Timezone' },
      'x'
    );

    expect(minutesLeftInWindow(s, at('12:00'))).toBe(0);
  });
});

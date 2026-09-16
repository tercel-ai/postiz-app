import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import type { ScanPlatform } from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * How often a project replies on one platform, expressed the way the Automation
 * page now asks for it: ACTIVE HOURS plus a DAILY LIMIT.
 *
 * It replaces a single "check every N hours" interval
 * (`EngagePlatformPolicy.checkIntervalMinutes`, kept only for reading old rows).
 * The interval was the wrong unit for the two questions a user actually has —
 * "when may this account be seen replying" and "how many replies a day is still
 * a person" — and it could only answer them by accident, since both depend on
 * how many hours the window is open. Spacing is now DERIVED from the pair
 * instead of configured beside them, so it can never contradict them: a 4/day
 * limit across a 10-hour window is one reply every 150 minutes, and the two
 * numbers cannot drift apart because only one of them is stored.
 */

/**
 * Active hours for a platform that has never set its own — 8 AM to 6 PM, in the
 * policy's timezone (UTC when it names none, the same convention
 * `withinLocalWindow` and `platform_pacing` already use).
 *
 * A DEFAULT, not a floor: this is the shape of an ordinary working day, and
 * replying inside it is what makes an account read as a person rather than a
 * scheduler. A project that wants different hours states them and this is never
 * consulted; the platform-level window in `platform_pacing` is the separate,
 * wider constraint that a project window may only ever narrow.
 */
export const DEFAULT_REPLY_ACTIVE_HOURS = { start: '08:00', end: '18:00' } as const;

/**
 * Replies per LOCAL day for a platform that has never set its own.
 *
 * Deliberately far below every platform's RISK ceiling: a project that has
 * configured nothing should run at a rate nobody has to think about, and the
 * ceiling exists to bound what a user may raise it TO, not to describe normal
 * use. See PLATFORM_REPLY_RISK_CEILING for why the two are different numbers.
 */
export const DEFAULT_REPLY_DAILY_LIMIT = 4;

/**
 * The account-SAFETY ceiling: the most replies a day we will let a project
 * configure on a platform, whatever it asks for.
 *
 * NOT the same question as `OPERATION_PLAN_REPLY_VOLUME.max` below, and the two
 * must never be merged again:
 *
 *   OPERATION_PLAN_REPLY_VOLUME.max
 *       "how many replies a day reads as a person with something to say" — a
 *       CONTENT judgement, and the ceiling an operation plan's
 *       `targetRepliesPerDay` is generated and clamped against. x is 4 there,
 *       and nothing at send time reads it.
 *
 *   this table
 *       "how many replies a day before the PLATFORM starts limiting, filtering
 *       or banning the account" — several times higher. x is 30 here, and this
 *       is what a project's configured `dailyReplyLimit` is clamped to.
 *
 * Using the plan's number as the safety cap is what this table fixes: a user
 * deliberately asking for 10 replies a day on x was silently given 4, because a
 * content-quality suggestion was standing in for a rate limit.
 *
 * WHERE THE NUMBERS COME FROM. No platform publishes a reply-rate ban
 * threshold; the only published figures are API rate limits (which do not apply
 * — engage replies go out through the extension's own browser session) and
 * Forem's 30-second comment interval. These are therefore engineering judgement
 * about each platform's THROTTLING MECHANISM, not quoted rules, and live
 * numbers from our own accounts should replace them:
 *
 *   · x (30)          — account-level hard limits sit in the thousands of posts
 *                        a day; what actually gets an account limited is content
 *                        similarity, @-mentions of strangers and link ratio.
 *   · reddit (25)      — site- and subreddit-level spam filters. The number that
 *                        matters is per-SUBREDDIT concentration, not the daily
 *                        total; low-karma accounts also meet a ~10-minute
 *                        soft limit between comments.
 *   · linkedin (25)    — actively probes for automation (it fingerprints the
 *                        extension). The working rule is under ~100 actions of
 *                        ALL kinds per day, of which comments are a fraction.
 *   · devto (15)       — Forem enforces 30s between comments; the community is
 *                        small enough that moderators notice volume directly.
 *   · quora (15)       — punishes by COLLAPSING answers rather than banning, and
 *                        promotional answers collapse fastest.
 *   · medium (10)      — responses carrying links are the main suspension cause.
 *   · hackernews (10)  — the harshest on anything reading as promotion, the
 *                        hardest to appeal, and it rate-limits explicitly
 *                        ("You're posting too fast").
 *
 * NOT age-aware, and that is the biggest gap. Every platform here throttles a
 * new account far harder than an established one, so a 3-day-old account run at
 * these numbers is the likeliest way to lose one. There is no account-age
 * signal in the model yet; when there is, these should scale with it.
 */
export const PLATFORM_REPLY_RISK_CEILING: Record<ScanPlatform, number> = {
  x: 30,
  reddit: 25,
  linkedin: 25,
  devto: 15,
  quora: 15,
  medium: 10,
  hackernews: 10,
};

/** Admin-tunable override of PLATFORM_REPLY_RISK_CEILING, as `{ platform: n }`. */
export const ENGAGE_REPLY_DAILY_CEILING_KEY = 'engage_reply_daily_ceiling';

/**
 * WARM-UP: the fraction of a platform's ceiling an account may use, as a
 * function of how long this automation has been replying as it.
 *
 * WHAT THIS IS NOT. It is not the platform account's AGE, and cannot be: engage
 * replies go out through the extension's own browser session, so no code here
 * ever sees a registration date, and none of the scanners reads one. What IS
 * observable is how long WE have been driving the account — the timestamp of
 * the first reply we ever sent as it — and that is the variable actually worth
 * controlling: an account that has been in the product for a day and is already
 * running at its ceiling is the exact pattern that gets one limited.
 *
 * The proxy's known blind spot: an org that swaps in a NEW platform account
 * keeps the old account's first-reply date, so the new one skips its warm-up.
 * `Integration.createdAt` would catch some of those, but only the platforms
 * that HAVE an integration (x does, the extension-session platforms often do
 * not), so it is a refinement to fold in when that attribution is complete,
 * not a replacement.
 *
 * `days` is the INCLUSIVE lower bound, so the tiers below read as
 * 0-6 -> 0.3, 7-29 -> 0.6, 30+ -> 1.
 */
export interface ReplyWarmupTier {
  days: number;
  factor: number;
}

export const DEFAULT_REPLY_WARMUP_TIERS: readonly ReplyWarmupTier[] = [
  { days: 0, factor: 0.3 },
  { days: 7, factor: 0.6 },
  { days: 30, factor: 1 },
];

/** Admin-tunable override of DEFAULT_REPLY_WARMUP_TIERS, as `[{ days, factor }]`. */
export const ENGAGE_REPLY_WARMUP_KEY = 'engage_reply_warmup';

/**
 * Per-platform cap on replies to the SAME channel in one day — one subreddit,
 * one publication, one tag feed.
 *
 * A daily total says nothing about spread, and spread is what the platform
 * actually reads: three comments across three subreddits is three people
 * having a day; three in one subreddit is a campaign, and reddit's own spam
 * filter is tuned for exactly that shape. This is the constraint the total
 * cannot express.
 *
 * Only reddit by default, because it is the only platform where `channelId` is
 * both populated and meaningful as a COMMUNITY (x has none at all; the
 * article platforms set it to a publication or tag, where concentration means
 * much less). A platform with no entry is unconstrained, and an operator can
 * give one an entry through the setting below.
 */
export const DEFAULT_CHANNEL_DAILY_LIMIT: Record<string, number> = {
  reddit: 2,
};

/** Admin-tunable override of DEFAULT_CHANNEL_DAILY_LIMIT, as `{ platform: n }`. */
export const ENGAGE_REPLY_CHANNEL_LIMIT_KEY = 'engage_reply_channel_daily_limit';

/**
 * Absolute bound on any ceiling, however it was configured.
 *
 * A ceiling is the last thing between an automation and a banned account, so a
 * mistyped `3000` must not be able to remove it. 100 is far above any number
 * this table would defensibly hold, so it never binds a deliberate decision —
 * it only catches the typo. Same role as `MAX_PACING_GAP_MS` on platform_pacing.
 */
export const MAX_REPLY_DAILY_CEILING = 100;

// Per-platform reply volume for OPERATION PLAN GENERATION. The sibling of
// operation-plan's DEFAULT_PLATFORM_CADENCE: cadence steers how much a plan
// POSTS, this steers how much it REPLIES.
//
// One consumer, and only one: `OperationPlanService` states each platform's
// `typical`/`max` in the generation prompt and then clamps the model's
// `targetRepliesPerDay` to `max` in code (a prompt is guidance; the clamp is
// not). Nothing at SEND time reads it.
//
// NOT a rate limit. `max` answers "how many replies a day still reads as a
// person with something to say" — a question about CONTENT, answered for a
// plan being written. The question "how many before the platform limits the
// account" is PLATFORM_REPLY_RISK_CEILING above, and its numbers are several
// times higher.
//
// It lives HERE, in engage, rather than beside the plan generator that first
// needed it, because the ceiling is now enforced on two independent paths —
// plan generation clamps `targetRepliesPerDay` to it, and the Automation reply
// limit below clamps to it too. Two copies of a safety ceiling is how one of
// them quietly becomes wrong; operation-plan imports this one (the dependency
// only runs that way — engage must never import from operation-plan, see the
// note in engage-scan-config.service.ts).
//
// Keyed by ScanPlatform (the engage CAPABILITY list) and declared as a total
// Record, not a partial map: adding a platform there fails the build here until
// it is given a reply volume, instead of silently letting that platform reply
// without a bound. A platform outside the union has no scanner, therefore no
// opportunities and no reply path at all — it gets no entry.
//
// The numbers are a gradient over two things — what ONE reply COSTS to write,
// and how much genuinely relevant SUPPLY that platform surfaces in a day — NOT
// over how much we would like to post:
//
//   · x (3-4): short replies against the deepest daily pool. Still bounded:
//     the account has to read as a person, not a reply bot.
//   · reddit / linkedin (2-3): short replies too, but a thinner daily pool of
//     threads worth entering, and reddit filters volume fastest of the three.
//   · devto / quora (1-2): long-form, yet fed by feeds that genuinely refresh
//     every day (dev.to tag feeds, new Quora questions), so a second one is
//     often real rather than padding.
//   · medium / hackernews (1): long-form against the THINNEST supply — Medium
//     stories move slowly, and few HN threads are truly on-topic for one
//     project's keywords. A second reply here is almost always manufactured,
//     on the communities least tolerant of that.
//
// The long-form half also costs more credits: reply price scales with length
// (EngageReplyCredits multipliers), so a Quora answer is not a cheap unit.
//
// `max` is a ceiling on a HUMAN-plausible rate, never a goal — and it IS the cap
// the plan gate enforces on `targetRepliesPerDay`, so a loose number here has
// nothing downstream to catch it.
export type ReplyVolume = { typical: string; max: number; why: string };
export const OPERATION_PLAN_REPLY_VOLUME: Record<ScanPlatform, ReplyVolume> = {
  x: {
    typical: '3-4',
    max: 4,
    why: 'short conversational replies against the deepest daily supply — but 4/day is the ceiling for an account that should read as a person, not a reply bot',
  },
  reddit: {
    typical: '2-3',
    max: 3,
    why: 'comments in live threads; high citation value, and the fastest place to get filtered for volume — spread them across subreddits, never stack them in one',
  },
  linkedin: {
    typical: '2-3',
    max: 3,
    why: 'comments on posts from others; a couple of substantive ones beat a row of one-liners',
  },
  devto: {
    typical: '1-2',
    max: 2,
    why: 'article comments are a written paragraph each, but the tag feeds genuinely refresh daily, so a second one is usually a real article rather than a manufactured excuse',
  },
  hackernews: {
    typical: '1',
    max: 1,
    why: 'thread comments; few threads a day are truly on-topic for one project, and HN punishes anything that reads as promotion or padding harder than anywhere else — reply only where there is something real to add',
  },
  medium: {
    typical: '1',
    max: 1,
    why: 'responses on long-form stories — the slowest-moving supply of all, and a response is expected to be a paragraph, not a reaction; a second one in a day means you went looking for a pretext',
  },
  quora: {
    typical: '1-2',
    max: 2,
    why: 'an answer is long-form and IS the unit of value on Quora, so two good ones is a full day — one good answer still outperforms three thin ones',
  },
};

/** 'HH:MM' as minutes since midnight, or null when it is not a clock time. */
export function clockTimeToMinutes(value: string | undefined): number | null {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hours, minutes] = value.split(':').map(Number);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** The reply-schedule keys of a stored policy, as they come off a JSON column. */
export interface ReplyScheduleInput {
  windowStart?: string;
  windowEnd?: string;
  timezone?: string;
  dailyReplyLimit?: number;
}

/** Active hours and daily limit as the driver enforces them. */
export interface ResolvedReplySchedule {
  /** Local-time window, 'HH:MM'. Always present — the default fills it in. */
  windowStart: string;
  windowEnd: string;
  /** IANA zone the window is read in; absent = UTC. */
  timezone?: string;
  /**
   * Replies allowed per local day on this platform, after the safety clamp AND
   * the warm-up discount — the number the driver actually counts against.
   */
  dailyReplyLimit: number;
  /** The warm-up fraction applied to the ceiling (1 = fully warmed up). */
  warmupFactor: number;
  /**
   * Replies allowed to ONE channel (subreddit, publication…) per local day, or
   * undefined where the platform is unconstrained.
   */
  channelDailyLimit?: number;
  /**
   * Minutes between two replies, DERIVED from the two settings above — the
   * window spread evenly across the limit. Never stored: it is a consequence of
   * the schedule, and storing it beside the schedule is what let a cadence and
   * a daily limit describe two different rates at once.
   */
  cadenceMinutes: number;
}

/** Minutes the window is open for, honouring a window that wraps past midnight. */
export function windowMinutes(start: string, end: string): number {
  const from = clockTimeToMinutes(start);
  const to = clockTimeToMinutes(end);
  // Malformed or empty (start === end) windows are the caller's problem — they
  // are rejected at the gate by `withinLocalWindow`, which fails closed. A full
  // day here only affects the derived cadence, and being wrong in the direction
  // of MORE spacing is the safe side.
  if (from === null || to === null || from === to) return 24 * 60;
  return to > from ? to - from : 24 * 60 - from + to;
}

/**
 * The per-platform ceilings in force: the built-in table with an admin's
 * `engage_reply_daily_ceiling` folded onto it.
 *
 * MERGED per platform, not replaced wholesale: an admin raising x alone must not
 * silently drop the other six to "unbounded", which is exactly what a
 * replace-the-whole-object read would do to a partial setting. Anything
 * unusable in the stored value — a non-object, a non-integer, a negative, a
 * platform key nobody knows — is ignored in favour of the built-in, because the
 * safe side of a malformed ceiling is the one we shipped.
 */
export function resolveReplyDailyCeilings(
  stored?: unknown
): Record<string, number> {
  const out: Record<string, number> = { ...PLATFORM_REPLY_RISK_CEILING };
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
  for (const [platform, value] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) continue;
    out[platform.toLowerCase()] = Math.min(value, MAX_REPLY_DAILY_CEILING);
  }
  return out;
}

/**
 * The warm-up tiers in force: the built-ins unless the admin setting supplies a
 * usable ladder.
 *
 * REPLACED wholesale rather than merged, unlike the per-platform maps: a ladder
 * is only meaningful as a whole (its rungs have to cover from day 0 upward in
 * order), and folding one rung of an operator's ladder onto two of ours would
 * produce a curve neither of them wrote. A stored ladder therefore has to stand
 * on its own — and if any rung is unusable, the whole thing is discarded for
 * the built-in rather than half-applied.
 */
export function resolveReplyWarmupTiers(stored?: unknown): ReplyWarmupTier[] {
  const builtin = DEFAULT_REPLY_WARMUP_TIERS.map((tier) => ({ ...tier }));
  if (!Array.isArray(stored) || !stored.length) return builtin;
  const tiers: ReplyWarmupTier[] = [];
  for (const entry of stored) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return builtin;
    const { days, factor } = entry as Record<string, unknown>;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 0) return builtin;
    if (typeof factor !== 'number' || !Number.isFinite(factor)) return builtin;
    // Above 1 would make warm-up RAISE a ceiling, which is the one thing it
    // must never do: the ceiling is the safety limit, this only ever approaches
    // it from below.
    tiers.push({ days, factor: Math.min(Math.max(factor, 0), 1) });
  }
  tiers.sort((a, b) => a.days - b.days);
  // A ladder that does not start at day 0 leaves the riskiest days — a brand
  // new account's — with no rung at all, which `warmupFactorForDays` would read
  // as "no warm-up". That is the opposite of what an operator writing a ladder
  // means, so it is treated as malformed.
  return tiers[0].days === 0 ? tiers : builtin;
}

/**
 * The fraction of the ceiling an account that has been driven for `days` may
 * use — the LAST tier whose `days` it has reached.
 *
 * `null` days (this account has never replied) is day 0, deliberately: an
 * account we have never driven is the one to start slowest on, and reading
 * "unknown" as "fully warmed up" would skip warm-up for precisely the accounts
 * it exists for.
 */
export function warmupFactorForDays(
  days: number | null | undefined,
  tiers: readonly ReplyWarmupTier[] = DEFAULT_REPLY_WARMUP_TIERS
): number {
  const elapsed = typeof days === 'number' && Number.isFinite(days) && days > 0 ? days : 0;
  if (!tiers.length) return 1;
  // Seeded with the FIRST rung rather than with 1, so a ladder whose lowest rung
  // starts above day 0 discounts a younger account instead of waving it through.
  // `resolveReplyWarmupTiers` rejects such a ladder, and the built-in starts at
  // 0 — this is the direction a DIRECT caller falls in when neither applies, and
  // the safe side of that fall is "slower", never "unrestricted".
  let factor = tiers[0].factor;
  for (const tier of tiers) {
    if (elapsed >= tier.days) factor = tier.factor;
    else break;
  }
  return factor;
}

/** Whole days between `since` and `now`; null when there is no `since`. */
export function daysSince(since: Date | null | undefined, now: Date): number | null {
  if (!since) return null;
  const elapsed = now.getTime() - since.getTime();
  if (!Number.isFinite(elapsed)) return null;
  return Math.max(0, Math.floor(elapsed / 86_400_000));
}

/**
 * The per-platform same-channel daily caps in force: the built-ins with the
 * admin setting folded on, per platform, for the same reason
 * `resolveReplyDailyCeilings` merges.
 *
 * At least 1 — a stored 0 falls back to the built-in rather than being honoured.
 * It reads like "no channel may receive a reply", but the gate it feeds works by
 * EXCLUDING channels that already have replies today, and a channel with none
 * is not in that set: a 0 would therefore have silently behaved as 1, which is
 * the worst of both readings. "This platform does not reply" is a decision the
 * platform switch (`autoReplyEnabled`) already expresses exactly, so there is
 * nothing lost in refusing to spell it a second way here.
 */
export function resolveChannelDailyLimits(
  stored?: unknown
): Record<string, number> {
  const out: Record<string, number> = { ...DEFAULT_CHANNEL_DAILY_LIMIT };
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
  for (const [platform, value] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) continue;
    out[platform.toLowerCase()] = Math.min(value, MAX_REPLY_DAILY_CEILING);
  }
  return out;
}

/**
 * The daily reply limit for one platform: what the policy asks for, bounded by
 * the account-SAFETY ceiling (PLATFORM_REPLY_RISK_CEILING, or the admin's
 * override of it) — never by `OPERATION_PLAN_REPLY_VOLUME.max`, which belongs to
 * plan generation and would cap a deliberate 10-a-day on x at 4.
 *
 * Clamped rather than rejected, for the same reason plan generation clamps
 * `targetRepliesPerDay`: a caller asking for more is not making an ambitious
 * configuration, it is removing a guardrail that nothing downstream would catch,
 * and failing the save instead would only push them to turn the platform off.
 *
 * A platform with no ceiling has no engage reply path at all (nothing scans it,
 * so it never yields an opportunity), so there is nothing to clamp against and
 * the requested number stands.
 *
 * A stored 0 is honoured as zero — "configured off for today" is a real
 * setting, and `??` would have read it as "unset" and handed back the default.
 */
export function resolveReplyDailyLimit(
  requested: number | undefined,
  platform: string,
  ceilings: Record<string, number> = PLATFORM_REPLY_RISK_CEILING,
  warmupFactor = 1
): number {
  const ceiling = ceilings[platform.toLowerCase()];
  const asked =
    typeof requested === 'number' && Number.isFinite(requested) && requested >= 0
      ? Math.floor(requested)
      : DEFAULT_REPLY_DAILY_LIMIT;
  if (ceiling === undefined) return asked;
  // Floored at 1 while the ceiling itself is above 0: warm-up is meant to slow
  // an account down, never to stop it — a platform that may not reply at all
  // for its first week only looks abandoned, and the operator who wanted that
  // has `dailyReplyLimit: 0` (or the platform switch) to say so explicitly.
  const warmed =
    ceiling > 0 ? Math.max(1, Math.floor(ceiling * warmupFactor)) : 0;
  return Math.min(asked, warmed);
}

/** Everything a schedule needs that does NOT come from the policy itself. */
export interface ReplyScheduleOptions {
  /**
   * The org-wide minimum spacing (`engage_reply_pacing.minGapMinutes`), applied
   * as a FLOOR under the derived cadence and never as a default beside it: an
   * operator who slows every project down must not be undercut by a project
   * that divides a wide window by a big limit.
   */
  minGapMinutes?: number;
  /** Ceilings in force, from `resolveReplyDailyCeilings`. Omit for the built-ins. */
  ceilings?: Record<string, number>;
  /**
   * Days this automation has been replying on this platform's account — the age
   * of the org's FIRST reply there — which drives the warm-up discount.
   *
   * THREE states, and the difference matters:
   *   a number   that many days of driving history; the ladder decides.
   *   null       the caller LOOKED and found none. Day 0, the slowest tier: an
   *              account we have never driven is the one to start slowest on.
   *   absent     the caller is not applying warm-up at all (a preview, a test,
   *              a caller with no access to the clock). No discount.
   *
   * Reading `absent` as day 0 would quietly hold every such caller to 30% of
   * the ceiling and report numbers no gate is enforcing; reading `null` as
   * "no discount" would skip warm-up for exactly the accounts it exists for.
   * Both real gates — the driver and the Automation overview — pass a value.
   */
  warmupDays?: number | null;
  /** Warm-up ladder in force, from `resolveReplyWarmupTiers`. */
  warmupTiers?: readonly ReplyWarmupTier[];
  /** Same-channel daily caps, from `resolveChannelDailyLimits`. */
  channelDailyLimits?: Record<string, number>;
}

/**
 * One platform's effective reply schedule: stored values where the policy has
 * them, defaults where it does not, and the cadence derived from both.
 */
export function resolveReplySchedule(
  policy: ReplyScheduleInput | null | undefined,
  platform: string,
  {
    minGapMinutes = 0,
    ceilings,
    warmupDays,
    warmupTiers,
    channelDailyLimits = DEFAULT_CHANNEL_DAILY_LIMIT,
  }: ReplyScheduleOptions = {}
): ResolvedReplySchedule {
  // Both bounds or neither: a policy that names only one side has not stated a
  // window, and pairing a stored bound with a defaulted one would invent hours
  // nobody chose — 08:00 against a stored 02:00 end is a 18-hour window read as
  // a working day.
  const hasWindow =
    clockTimeToMinutes(policy?.windowStart) !== null &&
    clockTimeToMinutes(policy?.windowEnd) !== null;
  const windowStart = hasWindow ? policy!.windowStart! : DEFAULT_REPLY_ACTIVE_HOURS.start;
  const windowEnd = hasWindow ? policy!.windowEnd! : DEFAULT_REPLY_ACTIVE_HOURS.end;
  const warmupFactor =
    warmupDays === undefined ? 1 : warmupFactorForDays(warmupDays, warmupTiers);
  const dailyReplyLimit = resolveReplyDailyLimit(
    policy?.dailyReplyLimit,
    platform,
    ceilings,
    warmupFactor
  );
  const channelDailyLimit = channelDailyLimits[platform.toLowerCase()];

  // A zero limit replies never, so there is no spacing to compute — the whole
  // window is the gap. Guarded explicitly because the division below would
  // otherwise return Infinity and every comparison against it would pass.
  const derived =
    dailyReplyLimit > 0
      ? Math.max(1, Math.floor(windowMinutes(windowStart, windowEnd) / dailyReplyLimit))
      : windowMinutes(windowStart, windowEnd);

  // Typed as a string, but this comes off a JSON column: a non-string here
  // would reach dayjs.tz and throw inside every gate that reads the schedule.
  const zone = typeof policy?.timezone === 'string' ? policy.timezone : '';

  return {
    windowStart,
    windowEnd,
    ...(zone ? { timezone: zone } : {}),
    dailyReplyLimit,
    warmupFactor,
    ...(channelDailyLimit !== undefined ? { channelDailyLimit } : {}),
    cadenceMinutes: Math.max(derived, minGapMinutes),
  };
}

/**
 * The UTC instants bounding the LOCAL day `now` falls in, for counting a day's
 * replies against the limit.
 *
 * Local, not UTC, because the limit is stated alongside local active hours: a
 * day that rolled over at midnight UTC would reset the count in the middle of a
 * UTC+8 afternoon, handing that project a second day's replies inside one of
 * its own. An unusable zone falls back to UTC rather than throwing — a bad
 * timezone string must not stop the gate from counting at all.
 */
export function localDayRange(
  zone: string | undefined,
  now: Date
): { since: Date; until: Date } {
  let local: dayjs.Dayjs;
  try {
    local = zone ? dayjs(now).tz(zone) : dayjs.utc(now);
    if (!local.isValid()) local = dayjs.utc(now);
  } catch {
    local = dayjs.utc(now);
  }
  const start = local.startOf('day');
  return { since: start.toDate(), until: start.add(1, 'day').toDate() };
}

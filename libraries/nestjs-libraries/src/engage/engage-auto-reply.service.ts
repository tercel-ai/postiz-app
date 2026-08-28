import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import dayjs from 'dayjs';
import { randomUUID } from 'crypto';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { Organization } from '@prisma/client';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';
import {
  EngageService,
  type EngageReplyPolicy,
} from '@gitroom/nestjs-libraries/engage/engage.service';
import { EngageDraftService } from '@gitroom/nestjs-libraries/engage/engage-draft.service';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import {
  assertDraftWithinPlatformLimit,
  outputLengthForLength,
} from '@gitroom/nestjs-libraries/engage/engage-draft-length';
import { PlatformPacingConfigService } from '@gitroom/nestjs-libraries/engage/platform-pacing-config.service';

dayjs.extend(utc);
dayjs.extend(timezone);

export const ENGAGE_REPLY_PACING_KEY = 'engage_reply_pacing';

/**
 * Whether the unattended driver still gates on the operation plan's daily
 * reply budget (`EngageService.getReplyBudget` — `targetRepliesPerDay` /
 * `dailyHardCap` / `keywordTargets`). OFF by default: the driver's day-to-day
 * job is spacing (active hours + `checkIntervalMinutes`), and most projects
 * running Automation never generate an operation plan at all — gating on one
 * by default silently produced zero replies for them. Set to `'true'` to
 * restore the stricter behaviour, where a project with no active plan (or an
 * exhausted daily target) is skipped entirely by the driver rather than
 * spaced only by interval.
 */
function isReplyBudgetGateEnabled(): boolean {
  return process.env.ENGAGE_REPLY_BUDGET_GATE_ENABLED === 'true';
}

/**
 * Whether `now` falls inside the policy's LOCAL-time window. Absent bounds mean
 * no restriction.
 *
 * Local rather than UTC because a window is a human statement ("office hours").
 * The account-level window in platform_pacing is the separate, wider constraint
 * that this project-level one narrows. A window that wraps past midnight
 * (22:00–02:00) is honoured as a wrap, not treated as empty.
 */
export function withinLocalWindow(
  policy: { windowStart?: string; windowEnd?: string; timezone?: string },
  now: Date
): boolean {
  const { windowStart, windowEnd } = policy;
  if (!windowStart || !windowEnd) return true;
  const toMinutes = (hhmm: string) => {
    if (!/^\d{2}:\d{2}$/.test(hhmm)) return null;
    const [hours, minutes] = hhmm.split(':').map(Number);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  };
  const start = toMinutes(windowStart);
  const end = toMinutes(windowEnd);
  if (start === null || end === null || start === end) return false;
  let local: dayjs.Dayjs;
  try {
    local = policy.timezone ? dayjs(now).tz(policy.timezone) : dayjs.utc(now);
  } catch {
    return false;
  }
  const minutes = local.hour() * 60 + local.minute();
  return start <= end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

/**
 * Pacing for the unattended reply driver. Replying with a real account's session
 * carries far more platform risk than reading does — an earlier X scan run on a
 * personal session got the account temporarily limited — so the driver hands out
 * a trickle, never a day's budget at once.
 */
export interface EngageReplyPacing {
  /**
   * Max drafts one poll may hand out FOR EACH PLATFORM, across all projects
   * running that platform. Counted per platform, not as one shared total — a
   * poll that drafts one reddit reply may still draft one x reply in the same
   * call.
   */
  maxPerPoll: number;
  /** Minimum spacing between two replies for the SAME project+platform. */
  minGapMinutes: number;
  /**
   * REMOVED — the write window now lives in `platform_pacing`, per platform and
   * in a real timezone. This field used to hold one global pair of UTC hours
   * while publishing had its own, separate, per-platform window: two settings
   * answering the same question about the same account, able to disagree, and
   * only one of them able to name a timezone.
   *
   * Left declared as optional purely so a stored config written before the
   * migration still type-checks on read. Nothing consults it.
   *
   * @deprecated migrated to platform_pacing[platform].window
   */
  activeHoursUtc?: [number, number];
  /**
   * Opportunities below this score are never auto-replied to.
   *
   * Defaults to 0 — NO filtering of its own. The authoritative quality line is
   * the INGEST gate (ENGAGE_MIN_SCORE, see engage-scan-ingest.service.ts): a
   * post below it never becomes an opportunity at all, so everything reaching
   * this driver has already cleared it. Two gates on the same score shipping
   * two different defaults is how a value here silently overrides a tuned
   * ENGAGE_MIN_SCORE — with nothing in the env to show it, since this one lives
   * in the `engage_reply_pacing` setting.
   *
   * Raise it to tighten reply quality WITHOUT losing data: this gate is
   * reversible (the opportunities stay in the DB, so lowering it again brings
   * them straight back), whereas raising the ingest gate discards everything
   * below it permanently.
   */
  minScore: number;
  /**
   * How long a claimed reply stays SPOKEN FOR before it is offered again.
   *
   * Must exceed the extension's poll interval with room to spare, or a reply
   * still being posted is handed to a second client — the one failure this must
   * never introduce. 15-minute alarm, 30 to be safe.
   *
   * The same idea as `EXTENSION_PUBLISH_LEASE_MINUTES` on the publish path, and
   * for the same reason; a separate knob only because replies poll on their own
   * cadence and inherit no benefit from being forced to share a number.
   */
  claimLeaseMinutes: number;
}

export const DEFAULT_REPLY_PACING: EngageReplyPacing = {
  maxPerPoll: 1,
  minGapMinutes: 25,
  // No activeHoursUtc: the write window moved to platform_pacing. Seeding it
  // here again would re-create the second source of truth this removed.
  // 0 = defer to the ingest gate; see the field doc above.
  minScore: 0,
  claimLeaseMinutes: 30,
};

/** One draft the extension (or the Awaiting-review UI) can act on. */
export interface DueReply {
  sentReplyId: string;
  opportunityId: string;
  projectId: string;
  platform: string;
  /** Permalink of the post being replied to. */
  url: string;
  /** The generated reply text. */
  text: string;
}

/** Read-only status for one (project, platform) pair — see getReplyQueueStatus. */
export interface ReplyQueueStatusRow {
  projectId: string;
  platform: string;
  /** The platform-level managed-replies switch (replyPolicies[platform].autoReplyEnabled). */
  policyEnabled: boolean;
  /** Already generated, sitting in QUEUE, waiting for the extension to send it. */
  queuedCount: number;
  /** NEW opportunities that could still become a queued reply. */
  eligibleCount: number;
  /** The pacing setting's UTC active-hours window. */
  withinActiveHours: boolean;
  /** This policy's own local-time window (windowStart/windowEnd/timezone). */
  withinLocalWindow: boolean;
  /** Human-like spacing since this project+platform's last sent reply. */
  withinMinGap: boolean;
  minGapMinutes: number;
  lastSentReplyAt: string | null;
  /** ISO timestamp of when the min-gap gate next opens; null when not gated by it. */
  nextEligibleAt: string | null;
}

/**
 * The unattended reply DRIVER: paces auto-replies by active hours and
 * per-project/platform interval, optionally against an operation plan's daily
 * reply targets.
 *
 * The pacing gate in EngageService is a BRAKE — it runs at send time and refuses
 * a reply that would exceed the plan. This service is the ACCELERATOR: no other
 * code decides "this project owes a reply now, here is the post". When
 * `ENGAGE_REPLY_BUDGET_GATE_ENABLED=true`, both read the same budget
 * (EngageService.getReplyBudget), so what is handed out can never exceed what
 * would be let through — with the gate at its default (off), this driver is
 * paced by interval alone and does not require an active plan.
 *
 * Backend = scheduler, extension = executor — the same split as publish-due and
 * the scan loop. This service makes NO platform call; it only decides and drafts.
 */
@Injectable()
export class EngageAutoReplyService implements OnModuleInit {
  private readonly logger = new Logger(EngageAutoReplyService.name);

  constructor(
    private _engageRepository: EngageRepository,
    private _engageService: EngageService,
    private _engageDraftService: EngageDraftService,
    private _settingsService: SettingsService,
    private _platformPacing: PlatformPacingConfigService
  ) {}

  /**
   * Seed the pacing setting so it is visible/editable in the admin Settings UI.
   * Only writes when absent — an operator's tuning is never overwritten.
   */
  async onModuleInit(): Promise<void> {
    try {
      const existing = await this._settingsService.get(ENGAGE_REPLY_PACING_KEY);
      if (existing === null || existing === undefined) {
        await this._settingsService.set(
          ENGAGE_REPLY_PACING_KEY,
          DEFAULT_REPLY_PACING,
          {
            type: 'json',
            description:
              'Unattended engage-reply pacing: how many drafts one poll may hand out PER ' +
              'PLATFORM, minimum spacing per project+platform, the minimum opportunity ' +
              'score, and the claim lease (how long a reply handed to a browser stays ' +
              'spoken for before it is offered again). The WRITE WINDOW is not here: it ' +
              'moved to platform_pacing[*].window, shared with publishing.',
            defaultValue: DEFAULT_REPLY_PACING,
          }
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to seed default setting ${ENGAGE_REPLY_PACING_KEY}:`,
        err
      );
    }
  }

  /** Effective pacing: the stored setting merged onto the defaults. */
  async getPacing(): Promise<EngageReplyPacing> {
    try {
      const stored = await this._settingsService.get<Partial<EngageReplyPacing>>(
        ENGAGE_REPLY_PACING_KEY
      );
      return { ...DEFAULT_REPLY_PACING, ...(stored ?? {}) };
    } catch {
      // A settings hiccup must not silently disable pacing — fall back to the
      // (conservative) defaults rather than to "no limits".
      return DEFAULT_REPLY_PACING;
    }
  }

  /**
   * Drafts due for this org right now, newest budget first.
   *
   * Returns at most `maxPerPoll` FOR EACH PLATFORM (summed across all projects
   * running that platform, not shared with other platforms): the caller polls
   * on a short cadence, so a trickle per poll spreads a day's target across the
   * day by construction — no separate scheduling clock needed.
   */
  async getDueReplies(org: Organization, now = new Date()): Promise<DueReply[]> {
    // Both resolved ONCE. The window and the floor are consulted per
    // (project × platform) below, and getPlatformPacing is a settings query on
    // every call — reading it inside the loop was an N+1 on a global admin value.
    const [pacing, pacingConfig] = await Promise.all([
      this.getPacing(),
      this._platformPacing.getPlatformPacing(),
    ]);
    // The write window is checked PER PLATFORM further down, not once here.
    // It used to be one global pair of UTC hours (`activeHoursUtc`), which could
    // neither name a timezone nor differ between platforms — and posting had its
    // own, separate, per-platform window that could disagree with it. One
    // question ("is now a reasonable hour to write as this account?") now has one
    // answer, and it is a property of the platform, so it belongs in the loop.
    const configs = await this._engageRepository.getAutoReplyConfigs(org.id);
    if (!configs.length) {
      // The widest blind spot on this path: no config means the whole org is
      // skipped before a single gate runs, and the poll returns {due: []} —
      // indistinguishable from "everything was gated" without this line.
      this.logger.debug(
        `[reply-gate] org ${org.id} SKIP no-auto-reply-config (no project has ` +
          `enabled=true + replies active)`
      );
      return [];
    }

    const due: DueReply[] = [];
    // Counted per PLATFORM, not globally: `maxPerPoll` caps each platform's own
    // rate-limit risk independently, so a busy reddit slate must not starve x
    // (or vice versa) within the same poll.
    const perPlatformCount = new Map<string, number>();

    // Both lanes below share this cutoff: a reply claimed more recently than
    // this may still be posting in someone's browser.
    const leaseCutoff = dayjs
      .utc(now)
      .subtract(pacing.claimLeaseMinutes, 'minute')
      .toDate();

    for (const config of configs) {
      const projectId = config.projectId!;
      const policies = (config.replyPolicies ?? {}) as Record<string, EngageReplyPolicy>;

      // Data-driven: whichever platforms this project actually configured a
      // policy for, not a hardcoded pair. A platform absent from the map is
      // already excluded by the autoReplyEnabled check below, so iterating only
      // the configured keys (rather than every SCANNABLE_PLATFORMS) is purely an
      // efficiency choice, not a correctness one — and it means a newly
      // supported platform needs no change here, only a policy entry.
      //
      // Normalized to lowercase: getReplyBudget -> _resolveEngagePolicy matches
      // the plan's engagePolicies[].platform with a case-SENSITIVE `===`, and
      // that field is always written lowercase by plan generation. Nothing
      // enforces the casing of a replyPolicies KEY at the API boundary
      // (SaveEngageConfigDto validates values, not key casing), so an
      // "X"-keyed policy would otherwise silently resolve budget.cap to null
      // and get skipped — not rejected, not logged, just quietly never driven.
      for (const rawPlatform of Object.keys(policies)) {
        const platform = rawPlatform.toLowerCase();
        if ((perPlatformCount.get(platform) ?? 0) >= pacing.maxPerPoll) continue;

        // Per-platform policy refines the project-level switch. Absent = the
        // platform was never configured, and an unconfigured platform must not
        // start replying on its own — this is the one gate where "no setting"
        // has to mean OFF rather than "inherit". Looked up by the ORIGINAL raw
        // key — `policies` is keyed however the caller wrote it, not by the
        // normalized `platform` used below for the budget/pacing comparisons.
        const policy = policies[rawPlatform];
        if (!policy?.autoReplyEnabled) {
          this.logger.debug(
            `[reply-gate] ${projectId}/${platform} SKIP policy-disabled`
          );
          continue;
        }

        // ── Gates that apply to EVERY reply handed out, queued or fresh ──────
        //
        // These decide WHEN a reply may leave, so a queued one has to pass them
        // too. It was generated at some earlier moment under conditions that no
        // longer hold: handing it over now without re-checking would post
        // outside the hours the project set, or in a burst the gap exists to
        // prevent — and a reply that failed to send once is exactly the one most
        // likely to be re-offered at 3am.
        if (!withinLocalWindow(policy, now)) {
          this.logger.debug(
            `[reply-gate] ${projectId}/${platform} SKIP project-local-window ` +
              `(${policy.windowStart ?? '-'}..${policy.windowEnd ?? '-'} ${
                policy.timezone ?? 'UTC'
              })`
          );
          continue;
        }

        // The platform's own write window, shared with publishing. The project
        // window above is the user's preference; this is the account-level one,
        // and both must hold — a project may narrow the platform's hours, never
        // widen them.
        if (!this._platformPacing.isWithinWriteWindowFor(pacingConfig, platform, now)) {
          this.logger.debug(
            `[reply-gate] ${projectId}/${platform} SKIP platform-write-window`
          );
          continue;
        }

        // Human-like spacing, per project+platform: without it a poll loop would
        // empty a day's budget into one burst the moment the window opened.
        //
        // TWO clocks, and they answer different questions.
        //
        // `lastAt` is this project+platform's own last reply — the CADENCE the
        // user configured ("every 4-6 hours for this project").
        //
        // `lastWriteAt` is the last time ANY track wrote to this platform for
        // the whole org: another project's reply, or a post the extension took
        // to publish. That is the FLOOR, because a platform throttles by account
        // and cannot see our project boundaries. Hacker News says "You're
        // posting too fast" about stories and comments alike, and a queued story
        // going out seconds after a reply is exactly what tripped it.
        const [lastAt, lastWriteAt] = await Promise.all([
          this._engageRepository.getLastSentReplyAt(org.id, projectId, platform),
          this._engageRepository.getLastPlatformWriteAt(org.id, platform),
        ]);
        // `??`, deliberately: minGapMinutes is the DEFAULT cadence for a project
        // that set none, not a floor. A project asking for a tighter interval is
        // stating a preference, and preferences are allowed to be tighter than
        // other preferences. What a preference may NOT undercut is the platform
        // floor below — which is why that is a separate setting rather than an
        // attempt to make this one mean two things.
        const cadenceMinutes = policy.checkIntervalMinutes ?? pacing.minGapMinutes;
        if (
          lastAt &&
          dayjs.utc(now).diff(dayjs.utc(lastAt), 'minute') < cadenceMinutes
        ) {
          this.logger.debug(
            `[reply-gate] ${projectId}/${platform} SKIP cadence — lastAt=${dayjs
              .utc(lastAt)
              .toISOString()} elapsed=${dayjs
              .utc(now)
              .diff(dayjs.utc(lastAt), 'minute')}m < ${cadenceMinutes}m`
          );
          continue;
        }
        // The platform floor applies to the org-wide clock and is never
        // negotiable by a cadence — a cadence may only ever be SLOWER than it.
        const floorMinutes = this._platformPacing.writeFloorMinutesFor(
          pacingConfig,
          platform
        );
        if (
          lastWriteAt &&
          dayjs.utc(now).diff(dayjs.utc(lastWriteAt), 'minute') < floorMinutes
        ) {
          this.logger.debug(
            `[reply-gate] ${projectId}/${platform} SKIP platform-floor — ` +
              `lastWriteAt=${dayjs.utc(lastWriteAt).toISOString()} elapsed=${dayjs
                .utc(now)
                .diff(dayjs.utc(lastWriteAt), 'minute')}m < ${floorMinutes}m`
          );
          continue;
        }

        // ── Queued first ────────────────────────────────────────────────────
        //
        // A reply already in QUEUE is claimed before anything new is generated.
        // Cost: it was generated and paid for on an earlier poll, so re-offering
        // it is free, while generating alongside it spends twice for one reply.
        // Debt: otherwise new work permanently outranks the replies waiting to
        // go out, which is how a queue only grows.
        //
        // ONE per (project, platform) per poll, mirroring `_draftOne` — the
        // spacing above is the point, and draining a backlog in one burst is
        // precisely what gets an account rate-limited. A backlog therefore
        // clears at the configured pace, deliberately.
        const claimed = await this._engageRepository.claimDueEngageReplies(
          org.id,
          projectId,
          platform,
          { limit: 1, leaseToken: `claim_${randomUUID()}`, leaseCutoff, now }
        );
        if (claimed.length) {
          for (const row of claimed) {
            due.push({
              sentReplyId: row.id,
              opportunityId: row.opportunityId,
              projectId: row.projectId ?? projectId,
              platform: row.platform,
              url: row.url,
              text: row.content,
            });
            perPlatformCount.set(platform, (perPlatformCount.get(platform) ?? 0) + 1);
          }
          continue;
        }

        // ── Gate that applies to GENERATION only ─────────────────────────────
        //
        // The plan budget bounds how much is PRODUCED. A queued reply was
        // counted against it when it was generated, so re-offering one must not
        // be blocked by a spent budget — that would strand the very replies the
        // budget already paid for.
        const budget = await this._engageService.getReplyBudget(
          org.id,
          projectId,
          platform,
          now
        );
        // No plan / no enabled policy → nothing to drive. Deliberately the
        // OPPOSITE default from the send-time gate, which reads the same null as
        // "uncapped": the driver must never invent a target the plan didn't set.
        // Opt-in via ENGAGE_REPLY_BUDGET_GATE_ENABLED (default off) — see
        // isReplyBudgetGateEnabled above. `budget` is still fetched either way:
        // `_draftOne` uses `budget.keywords` to prefer under-quota keywords
        // regardless of whether the cap itself is enforced.
        if (
          isReplyBudgetGateEnabled() &&
          (budget.cap === null || !budget.remaining)
        ) {
          continue;
        }

        this.logger.debug(
          `[reply-gate] ${projectId}/${platform} PASSED all gates — drafting ` +
            `(budget cap=${budget.cap ?? 'uncapped'} remaining=${
              budget.remaining ?? 'n/a'
            } keywords=${budget.keywords.length})`
        );
        const drafted = await this._draftOne(
          org, projectId, platform, budget, pacing, policy
        );
        if (drafted) {
          due.push(drafted);
          perPlatformCount.set(platform, (perPlatformCount.get(platform) ?? 0) + 1);
        }
      }
    }
    return due;
  }

  /**
   * Read-only status for every (project, platform) this org has configured for
   * managed replying — what {@link getDueReplies} would see on its next poll,
   * without claiming or drafting anything.
   *
   * `getDueReplies` returning `{ due: [] }` conflates two very different
   * situations: "nothing eligible exists" and "something is eligible/queued
   * but pacing has it on hold this poll" (outside the active-hours window,
   * inside the minimum gap, or the platform switch is off). This tells them
   * apart so a stuck automation can be diagnosed from the numbers alone,
   * instead of guessing from a single empty array.
   */
  async getReplyQueueStatus(
    org: Organization,
    now = new Date()
  ): Promise<ReplyQueueStatusRow[]> {
    // Resolved ONCE, not per row. getPlatformPacing issues a settings query on
    // every call and this loop is (projects × platforms) deep — reading it
    // inside was an N+1 on a value that changes on the order of weeks. The
    // helpers below are pure functions over the resolved object.
    const [pacing, pacingConfig] = await Promise.all([
      this.getPacing(),
      this._platformPacing.getPlatformPacing(),
    ]);

    const configs = await this._engageRepository.getAutoReplyConfigs(org.id);
    const rows: ReplyQueueStatusRow[] = [];

    for (const config of configs) {
      const projectId = config.projectId!;
      const policies = (config.replyPolicies ?? {}) as Record<string, EngageReplyPolicy>;

      for (const rawPlatform of Object.keys(policies)) {
        const platform = rawPlatform.toLowerCase();
        const policy = policies[rawPlatform];
        const policyEnabled = !!policy?.autoReplyEnabled;

        // Skip the (project, platform) entirely when the platform was never
        // switched on — same as getDueReplies, and for the same reason: a row
        // here would otherwise read as "0 queued, 0 eligible" which looks
        // identical to "there's genuinely nothing", when the real answer is
        // "this platform isn't running at all".
        if (!policyEnabled) continue;

        const [queuedCount, eligibleCount, lastSentReplyAt, lastWriteAt] =
          await Promise.all([
            this._engageRepository.countQueuedEngageReplies(org.id, projectId, platform),
            this._engageRepository.countEligibleOpportunities(org.id, projectId, platform, {
              minScore: pacing.minScore,
            }),
            this._engageRepository.getLastSentReplyAt(org.id, projectId, platform),
            this._engageRepository.getLastPlatformWriteAt(org.id, platform),
          ]);

        // This row exists to EXPLAIN the dispatch gate, so it has to be computed
        // from the same rules — a row that disagrees with the gate is worse than
        // no row. It therefore mirrors all three of the gate's clocks:
        //   · the platform write window   (gate 2)
        //   · the project cadence          (gate 3)
        //   · the platform write floor     (gate 4)
        // Missing the floor was exactly this bug in miniature: the overview said
        // "eligible now" while getDueReplies withheld the reply, because a post
        // published minutes earlier had moved a clock this row never read.
        const withinActiveHours = this._platformPacing.isWithinWriteWindowFor(
          pacingConfig,
          platform,
          now
        );

        const minGapMinutes = policy.checkIntervalMinutes ?? pacing.minGapMinutes;
        const floorMinutes = this._platformPacing.writeFloorMinutesFor(
          pacingConfig,
          platform
        );
        const cadenceEligibleAt = lastSentReplyAt
          ? dayjs.utc(lastSentReplyAt).add(minGapMinutes, 'minute').toDate()
          : null;
        const floorEligibleAt = lastWriteAt
          ? dayjs.utc(lastWriteAt).add(floorMinutes, 'minute').toDate()
          : null;
        // Whichever holds the reply back longer is the one to report.
        const nextEligibleAt =
          cadenceEligibleAt && floorEligibleAt
            ? cadenceEligibleAt > floorEligibleAt
              ? cadenceEligibleAt
              : floorEligibleAt
            : cadenceEligibleAt ?? floorEligibleAt;
        const withinMinGap = !nextEligibleAt || nextEligibleAt.getTime() <= now.getTime();

        rows.push({
          projectId,
          platform,
          policyEnabled,
          queuedCount,
          eligibleCount,
          withinActiveHours,
          withinLocalWindow: withinLocalWindow(policy, now),
          withinMinGap,
          minGapMinutes,
          lastSentReplyAt: lastSentReplyAt ? lastSentReplyAt.toISOString() : null,
          nextEligibleAt:
            nextEligibleAt && !withinMinGap ? nextEligibleAt.toISOString() : null,
        });
      }
    }
    return rows;
  }

  /**
   * Pick ONE opportunity and draft a reply for it.
   *
   * Keyword quotas come first: a plan that says "3 replies for `geo`, 2 for
   * `ai search`" is asking for that split, not for 5 replies from whichever
   * keyword happens to have the highest-scoring posts. Only when no keyword has
   * headroom left does it fall back to the whole matched pool (the aggregate
   * target can exceed the sum of the per-keyword ones).
   */
  private async _draftOne(
    org: Organization,
    projectId: string,
    platform: string,
    budget: Awaited<ReturnType<EngageService['getReplyBudget']>>,
    pacing: EngageReplyPacing,
    policy: EngageReplyPolicy
  ): Promise<DueReply | null> {
    const hungryKeywords = budget.keywords
      .filter((k) => k.remaining > 0)
      .map((k) => k.keyword);

    const candidates = await this._engageRepository.pickAutoReplyCandidates(
      org.id,
      projectId,
      platform,
      {
        limit: 1,
        minScore: pacing.minScore,
        ...(hungryKeywords.length ? { keywords: hungryKeywords } : {}),
      }
    );
    const candidate = candidates[0];
    if (!candidate) {
      // The ONE silent exit on this path, and the one that cost the most to
      // diagnose: an empty pick is indistinguishable from "nothing eligible"
      // from the outside, while the reply-queue-status overview keeps reporting
      // a large `eligibleCount` because it does not apply the keyword filter.
      // The keywords are the part worth printing — they come from the plan's
      // keywordTargets and are the only condition here the overview does not
      // share, so a mismatch between them and the opportunities' stored
      // matchedKeywords shows up nowhere else.
      this.logger.debug(
        `Auto-reply pick empty for project ${projectId} / ${platform} — ` +
          `minScore=${pacing.minScore}, keywords=${
            hungryKeywords.length ? JSON.stringify(hungryKeywords) : '(unfiltered)'
          }`
      );
      return null;
    }

    // Discovery is intentionally a read so scoring and keyword filters stay
    // simple. Claim separately with a conditional state transition; only its
    // winner may call the model.
    const stateId = candidate.id;
    const claimed = await this._engageRepository.claimAutoReplyCandidate(
      org.id,
      projectId,
      stateId
    );
    if (!claimed) return null;

    try {
      const opportunity = await this._engageService.getOpportunityForReply(
        org,
        candidate.opportunityId,
        projectId
      );

      // Same admission control as the user-driven path: monthly cap + credit
      // balance clear BEFORE any model call, and the reservation is released on
      // any failure after it was taken.
      const strategy = policy.defaultStrategy || 'EXPERT_ANSWER';
      const lengthTier = policy.length ?? 'medium';
      const reservation = await this._engageService.reserveReplyGeneration(
        org,
        lengthTier,
        candidate.opportunityId
      );
      let text = '';
      try {
        const outputLength = outputLengthForLength(opportunity.platform, lengthTier);
        for await (const chunk of this._engageDraftService.generateDraft(
          opportunity,
          strategy,
          50,
          policy.mentionTags,
          undefined,
          outputLength
        )) {
          text += chunk;
        }
        assertDraftWithinPlatformLimit(opportunity.platform, text, outputLength);
      } catch (err) {
        await this._engageService
          .releaseReplyGeneration(reservation.taskId)
          .catch(() => undefined);
        throw err;
      }

      // Park it as a DRAFT BEFORE settling the reservation — this row is the
      // commit point: it's what the Awaiting-review UI shows, what the
      // extension settles against, and what stops the next poll from drafting
      // this SAME opportunity again (pickAutoReplyCandidates excludes rows that
      // already have one). Settling first would charge for a draft that then
      // fails to persist — no record anywhere, but the credit already spent AND
      // the opportunity still eligible, so the next poll re-drafts (and
      // re-charges) it, silently, every cycle. Persist-then-settle means a save
      // failure here releases instead — recoverable, not a repeat charge.
      let saved: { id: string };
      try {
        // QUEUE, not DRAFT. DRAFT is a person's — it waits for them in Awaiting
        // review and nothing automated may send it. This reply was authorized by
        // the project's automation switch and is waiting only for a browser,
        // exactly like a scheduled post waiting for its slot.
        saved = await this._engageService.queueAutoReply(org, candidate.opportunityId, {
          platform: opportunity.platform,
          content: text,
          inputData: { strategy, brandStrength: 50 },
          projectId,
        });
      } catch (err) {
        await this._engageService
          .releaseReplyGeneration(reservation.taskId)
          .catch(() => undefined);
        throw err;
      }

      await this._engageService
        .settleReplyGeneration(org, reservation.taskId, lengthTier, reservation.cost)
        .catch((err) =>
          // A billing hiccup must not discard a draft that was already produced
          // AND durably saved; the reservation stays counted so the cap still
          // holds. Unlike the pre-saveDraft failure above, there is no
          // "re-drafted every cycle" risk here — the saved row already excludes
          // this opportunity from the next pick.
          this.logger.error(
            `Auto-reply credit settle failed for opportunity ${candidate.opportunityId}`,
            err instanceof Error ? err.stack : err
          )
        );

      // No lease stamped here. The reply is in QUEUE, so the very next poll's
      // claim lane picks it up and leases it there — one code path holding the
      // lease instead of two writing the same columns. Handing it over now
      // without a lease is safe for the same reason: an unclaimed QUEUE row is
      // exactly what the claim lane is for.
      return {
        sentReplyId: saved.id,
        opportunityId: candidate.opportunityId,
        projectId,
        platform: opportunity.platform,
        url: opportunity.externalPostUrl || '',
        text,
      };
    } catch (err) {
      await this._engageRepository
        .releaseAutoReplyCandidate(org.id, projectId, stateId)
        .catch((releaseErr) =>
          this.logger.error(
            `Auto-reply candidate release failed for state ${stateId}: ${
              releaseErr instanceof Error ? releaseErr.message : releaseErr
            }`
          )
        );
      // One project's failure must never stop the others — the loop continues.
      this.logger.warn(
        `Auto-reply draft failed for project ${projectId} / ${platform}: ${
          (err as Error)?.message || err
        }`
      );
      return null;
    }
  }
}


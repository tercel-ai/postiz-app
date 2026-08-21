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
 * Local rather than UTC because a window is a human statement ("office hours"),
 * and the global pacing setting's activeHoursUtc cannot express it for an org
 * whose day straddles midnight UTC. A window that wraps past midnight
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
  /** UTC hours [startInclusive, endExclusive) the driver may hand out work in. */
  activeHoursUtc: [number, number];
  /** Skip opportunities whose post is older than this — a late reply reads as spam. */
  maxPostAgeHours: number;
  /** Opportunities below this score are never auto-replied to. */
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
  activeHoursUtc: [0, 24],
  maxPostAgeHours: 48,
  minScore: 70,
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
    private _settingsService: SettingsService
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
              'PLATFORM, minimum spacing per project+platform, the UTC active-hours window, the ' +
              'maximum age of a post worth replying to, the minimum opportunity score, and the ' +
              'claim lease (how long a reply handed to a browser stays spoken for before it ' +
              'is offered again).',
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
    const pacing = await this.getPacing();
    const hour = dayjs.utc(now).hour();
    const [startHour, endHour] = pacing.activeHoursUtc;
    // Outside the configured window the driver hands out nothing. Checked before
    // any query: the common case for a narrow window is "not now".
    if (hour < startHour || hour >= endHour) return [];

    const configs = await this._engageRepository.getAutoReplyConfigs(org.id);
    if (!configs.length) return [];

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
        if (!policy?.autoReplyEnabled) continue;

        // ── Gates that apply to EVERY reply handed out, queued or fresh ──────
        //
        // These decide WHEN a reply may leave, so a queued one has to pass them
        // too. It was generated at some earlier moment under conditions that no
        // longer hold: handing it over now without re-checking would post
        // outside the hours the project set, or in a burst the gap exists to
        // prevent — and a reply that failed to send once is exactly the one most
        // likely to be re-offered at 3am.
        if (!withinLocalWindow(policy, now)) continue;

        // Human-like spacing, per project+platform: without it a poll loop would
        // empty a day's budget into one burst the moment the window opened.
        const lastAt = await this._engageRepository.getLastSentReplyAt(
          org.id,
          projectId,
          platform
        );
        const minGapMinutes = policy.checkIntervalMinutes ?? pacing.minGapMinutes;
        if (
          lastAt &&
          dayjs.utc(now).diff(dayjs.utc(lastAt), 'minute') < minGapMinutes
        ) {
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

        const drafted = await this._draftOne(
          org, projectId, platform, budget, pacing, now, policy
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
    now: Date,
    policy: EngageReplyPolicy
  ): Promise<DueReply | null> {
    const publishedAfter = dayjs.utc(now).subtract(pacing.maxPostAgeHours, 'hour').toDate();
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
        publishedAfter,
        ...(hungryKeywords.length ? { keywords: hungryKeywords } : {}),
      }
    );
    const candidate = candidates[0];
    if (!candidate) return null;

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


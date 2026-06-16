import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import {
  AiseeCreditService,
} from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee-credit.service';
import { AiseeBusinessType } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee.client';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

dayjs.extend(utc);

// ─── Settings keys (admin-configurable via /admin/settings, no redeploy) ──────
export const ENGAGE_ENTITLEMENTS_KEY = 'engage_entitlements';
export const ENGAGE_REPLY_CREDITS_KEY = 'engage_reply_credits';

// Reply-cap reservation lifecycle, stored as BillingRecord.status. The cap is
// the count of engage_reply rows whose status is NOT 'released': a reservation
// is written BEFORE generation (so concurrent requests see it and the cap holds
// even if the later charge fails), then settled (success/unbilled) on a
// delivered draft or released (excluded) on failure/abort.
const RESERVED_STATUS = 'reserved';
const RELEASED_STATUS = 'released';
// Prisma error code for a serialization conflict (Postgres 40001) — the signal
// to retry the cap reserve under SERIALIZABLE.
const SERIALIZATION_FAILURE_CODE = 'P2034';

export type EngagePlanCode = 'starter' | 'developer' | 'pro';
export type ReplyLength = 'short' | 'medium' | 'long';

/**
 * Per-plan engage limits. `null` means "unlimited" (no hard cap). Mirrors the
 * product spec table; every value is overridable from the Settings store.
 */
export interface EngageEntitlement {
  /** Max simultaneously-enabled keywords. */
  keywordsMax: number | null;
  /** Max enabled tracked/priority accounts (0 = feature hidden). */
  priorityAccountsMax: number | null;
  /** Max enabled monitored subreddits. */
  subredditsMax: number | null;
  /** Scan cadence applied to this org's keyword/channel/tracked units. */
  scanIntervalHours: number;
  /** Max reply drafts generated per billing period (null = unlimited). */
  replyMonthlyCap: number | null;
  /**
   * Plan ceiling (in days) for how far back a post stays under metrics
   * monitoring after it is published. The effective window is
   * `min(user override, metricsWindowDaysMax)`; a user cannot monitor beyond
   * this cap. Not nullable — an unbounded window would defeat the demand-driven
   * fetch design (it would pull every historical post).
   */
  metricsWindowDaysMax: number;
}

export type EngageEntitlementMap = Record<EngagePlanCode, EngageEntitlement>;

export interface EngageReplyCredits {
  /** Base credits for a Short reply. */
  base: number;
  /** Length multipliers applied to `base`; cost = round(base × multiplier). */
  multipliers: Record<ReplyLength, number>;
}

// ─── Defaults (seeded on first boot; spec §1 + §3.2) ──────────────────────────
const DEFAULT_ENTITLEMENTS: EngageEntitlementMap = {
  starter: {
    keywordsMax: 3,
    priorityAccountsMax: 0,
    subredditsMax: 1,
    scanIntervalHours: 24,
    replyMonthlyCap: 10,
    metricsWindowDaysMax: 7,
  },
  developer: {
    keywordsMax: 10,
    priorityAccountsMax: 10,
    subredditsMax: 5,
    scanIntervalHours: 24,
    replyMonthlyCap: null,
    metricsWindowDaysMax: 14,
  },
  pro: {
    keywordsMax: 30,
    priorityAccountsMax: null,
    subredditsMax: 15,
    scanIntervalHours: 6,
    replyMonthlyCap: null,
    metricsWindowDaysMax: 30,
  },
};

const DEFAULT_REPLY_CREDITS: EngageReplyCredits = {
  base: 2,
  multipliers: { short: 1.0, medium: 1.5, long: 2.5 },
};

// When billing is active but no plan can be resolved (no/expired package, or an
// unrecognised plan name), fall back to the most restrictive tier. Over-blocking
// an anomalous account is safer for revenue than silently granting Pro limits.
const FALLBACK_PLAN_CODE: EngagePlanCode = 'starter';

// Default scan cadence when no entitlement applies (self-hosted / billing off).
export const DEFAULT_SCAN_INTERVAL_HOURS = 24;

// Metrics-monitoring window used when no plan cap applies (self-hosted / billing
// off): the most generous tier, since there is no plan to bound it.
export const DEFAULT_METRICS_WINDOW_DAYS = 30;

// Fully-unlimited entitlement used when billing is disabled (self-hosted). No
// hard caps; scan cadence falls back to the default.
const UNLIMITED_ENTITLEMENT: EngageEntitlement = {
  keywordsMax: null,
  priorityAccountsMax: null,
  subredditsMax: null,
  scanIntervalHours: DEFAULT_SCAN_INTERVAL_HOURS,
  replyMonthlyCap: null,
  metricsWindowDaysMax: DEFAULT_METRICS_WINDOW_DAYS,
};

interface ResolvedPlan {
  /** null when billing is disabled (self-hosted) — unlimited entitlement. */
  code: EngagePlanCode | null;
  /** Billing-period start; null when billing off or package missing. */
  periodStart: Date | null;
}

/**
 * Owns the engage subscription entitlements and reply-credit pricing.
 *
 * Plans themselves live in aisee-core; this service maps a user's resolved plan
 * to engage-specific limits (stored in the Postiz Settings table so an admin can
 * tune them without a redeploy) and enforces them server-side. The only
 * credit-charging action in engage is generating a reply draft — priced by
 * length and deducted through the shared Aisee credit pipeline.
 */
@Injectable()
export class EngageEntitlementService implements OnModuleInit {
  private readonly logger = new Logger(EngageEntitlementService.name);

  // orgId → resolved plan, short-lived to avoid an Aisee round-trip per call
  // (e.g. once per scan tick across every enabled org).
  private readonly _planCache = new Map<
    string,
    { plan: ResolvedPlan; expiresAt: number }
  >();
  private static readonly PLAN_TTL_MS = 5 * 60 * 1000;

  constructor(
    private readonly _settings: SettingsService,
    private readonly _users: UsersService,
    private readonly _aiseeCredit: AiseeCreditService,
    private readonly _keyword: PrismaRepository<'engageKeyword'>,
    private readonly _trackedAccount: PrismaRepository<'engageTrackedAccount'>,
    private readonly _channel: PrismaRepository<'engageMonitoredChannel'>,
    private readonly _billingRecord: PrismaRepository<'billingRecord'>,
    private readonly _tx: PrismaTransaction
  ) {}

  async onModuleInit(): Promise<void> {
    await this._seedIfMissing(
      ENGAGE_ENTITLEMENTS_KEY,
      DEFAULT_ENTITLEMENTS,
      'Per-plan engage limits (keywords/accounts/subreddits/scan interval/reply cap/metrics window days). null = unlimited.'
    );
    await this._seedIfMissing(
      ENGAGE_REPLY_CREDITS_KEY,
      DEFAULT_REPLY_CREDITS,
      'Engage reply-draft pricing: cost = round(base × length multiplier).'
    );
  }

  private async _seedIfMissing(
    key: string,
    value: unknown,
    description: string
  ): Promise<void> {
    const existing = await this._settings.get(key);
    if (existing === null || existing === undefined) {
      await this._settings.set(key, value, {
        type: 'object',
        description,
        defaultValue: value,
      });
      this.logger.log(`Seeded default ${key}`);
    }
  }

  // ─── Entitlement resolution ────────────────────────────────────────────────

  private async _loadEntitlements(): Promise<EngageEntitlementMap> {
    const stored = await this._settings.get<Partial<EngageEntitlementMap>>(
      ENGAGE_ENTITLEMENTS_KEY
    );
    // Merge per-plan so a partial admin override never drops a tier.
    return {
      starter: { ...DEFAULT_ENTITLEMENTS.starter, ...(stored?.starter ?? {}) },
      developer: {
        ...DEFAULT_ENTITLEMENTS.developer,
        ...(stored?.developer ?? {}),
      },
      pro: { ...DEFAULT_ENTITLEMENTS.pro, ...(stored?.pro ?? {}) },
    };
  }

  private async _loadReplyCredits(): Promise<EngageReplyCredits> {
    const stored = await this._settings.get<Partial<EngageReplyCredits>>(
      ENGAGE_REPLY_CREDITS_KEY
    );
    return {
      base: stored?.base ?? DEFAULT_REPLY_CREDITS.base,
      multipliers: {
        ...DEFAULT_REPLY_CREDITS.multipliers,
        ...(stored?.multipliers ?? {}),
      },
    };
  }

  /**
   * Normalise an aisee plan display name ("Starter Plan (Monthly)", "pro", …)
   * to an engage plan code. Returns null when nothing matches.
   */
  static normalizePlanName(name: string | undefined | null): EngagePlanCode | null {
    if (!name) return null;
    const n = name.toLowerCase();
    if (n.includes('developer')) return 'developer';
    if (n.includes('pro')) return 'pro';
    if (n.includes('starter')) return 'starter';
    return null;
  }

  /** Resolve (and cache) the org's plan code + billing-period start. */
  private async _resolvePlan(orgId: string): Promise<ResolvedPlan> {
    const cached = this._planCache.get(orgId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.plan;
    }

    const plan = await this._resolvePlanUncached(orgId);
    this._planCache.set(orgId, {
      plan,
      expiresAt: Date.now() + EngageEntitlementService.PLAN_TTL_MS,
    });
    return plan;
  }

  private async _resolvePlanUncached(orgId: string): Promise<ResolvedPlan> {
    const userId = await this._aiseeCredit.resolveOwnerUserId(orgId);
    const limits = await this._users.getUserLimits(userId);

    // null => billing disabled (self-hosted): no entitlement enforcement.
    if (limits === null) {
      return { code: null, periodStart: null };
    }

    const name = 'name' in limits ? limits.name : undefined;
    const periodStart =
      'periodStart' in limits && limits.periodStart
        ? new Date(limits.periodStart)
        : null;

    const code = EngageEntitlementService.normalizePlanName(name);
    if (!code) {
      this.logger.warn(
        `Unrecognised plan name "${name}" for org=${orgId}; applying "${FALLBACK_PLAN_CODE}" limits`
      );
      return { code: FALLBACK_PLAN_CODE, periodStart };
    }
    return { code, periodStart };
  }

  /** Resolve the org's effective engage entitlement. */
  async getEntitlement(orgId: string): Promise<EngageEntitlement> {
    const plan = await this._resolvePlan(orgId);
    if (plan.code === null) {
      return UNLIMITED_ENTITLEMENT;
    }
    const entitlements = await this._loadEntitlements();
    return entitlements[plan.code];
  }

  /**
   * Resolved entitlement + current usage + reply pricing for one org — the
   * read model the frontend needs to disable entrypoints ("+ Add" once a cap is
   * hit), show "N/cap" reply usage, and label length costs. Server-side checks
   * (§15.3) remain the source of truth; this is only for UX.
   */
  async getEntitlementSummary(orgId: string): Promise<{
    plan: EngagePlanCode | null;
    limits: EngageEntitlement;
    usage: {
      keywords: number;
      trackedAccounts: number;
      subreddits: number;
      repliesThisPeriod: number;
    };
    replyCredits: Record<ReplyLength, number>;
  }> {
    const [plan, limits] = await Promise.all([
      this._resolvePlan(orgId),
      this.getEntitlement(orgId),
    ]);
    const [keywords, trackedAccounts, subreddits, repliesThisPeriod, replyCredits] =
      await Promise.all([
        this._countEnabled(orgId, 'keyword'),
        this._countEnabled(orgId, 'tracked'),
        this._countEnabled(orgId, 'subreddit'),
        this.countRepliesThisPeriod(orgId),
        this.getAllReplyCosts(),
      ]);
    return {
      plan: plan.code,
      limits,
      usage: { keywords, trackedAccounts, subreddits, repliesThisPeriod },
      replyCredits,
    };
  }

  /** Scan cadence (hours) for this org's units. Falls back to the default. */
  async getScanIntervalHours(orgId: string): Promise<number> {
    const entitlement = await this.getEntitlement(orgId);
    const hours = entitlement.scanIntervalHours;
    return Number.isFinite(hours) && hours > 0
      ? hours
      : DEFAULT_SCAN_INTERVAL_HOURS;
  }

  /**
   * Effective metrics-monitoring window (days) for this org: posts published
   * within this many days stay under monitoring; older ones fall out. Currently
   * the plan ceiling; once a per-org user override lands (Organization.data),
   * this becomes `min(userOverride, planMax)` — clamping is intentional so an
   * over-set override (or a plan downgrade) is bounded at read time, never at
   * write time.
   */
  async getMetricsWindowDays(orgId: string): Promise<number> {
    const entitlement = await this.getEntitlement(orgId);
    const max = entitlement.metricsWindowDaysMax;
    return Number.isFinite(max) && max > 0 ? max : DEFAULT_METRICS_WINDOW_DAYS;
  }

  // ─── Hard limit checks (server-side; the frontend can be bypassed) ─────────

  /**
   * Ensure activating `count` more units of `type` stays within the plan cap.
   * No-op when the cap is null (unlimited). Throws ForbiddenException otherwise.
   */
  async assertCanActivate(
    orgId: string,
    type: 'keyword' | 'tracked' | 'subreddit',
    count = 1
  ): Promise<void> {
    const entitlement = await this.getEntitlement(orgId);
    const max =
      type === 'keyword'
        ? entitlement.keywordsMax
        : type === 'tracked'
        ? entitlement.priorityAccountsMax
        : entitlement.subredditsMax;

    if (max === null) return; // unlimited

    const current = await this._countEnabled(orgId, type);
    if (current + count > max) {
      throw new ForbiddenException({
        code: 'engage_limit_reached',
        limit: type,
        max,
        current,
        message: `Your plan allows up to ${max} active ${this._label(type)}.`,
      });
    }
  }

  /**
   * Enforce the cap only when an existing unit transitions disabled → enabled.
   * Re-enabling an already-enabled row, or touching an unknown id, is a no-op so
   * the count is never double-charged.
   */
  async assertCanEnable(
    orgId: string,
    type: 'keyword' | 'tracked' | 'subreddit',
    id: string
  ): Promise<void> {
    const enabled = await this._currentlyEnabled(orgId, type, id);
    if (enabled !== false) return; // already enabled / not found
    await this.assertCanActivate(orgId, type, 1);
  }

  private async _currentlyEnabled(
    orgId: string,
    type: 'keyword' | 'tracked' | 'subreddit',
    id: string
  ): Promise<boolean | null> {
    if (type === 'keyword') {
      const row = await this._keyword.model.engageKeyword.findFirst({
        where: { id, organizationId: orgId },
        select: { enabled: true },
      });
      return row ? row.enabled : null;
    }
    if (type === 'tracked') {
      const row = await this._trackedAccount.model.engageTrackedAccount.findFirst({
        where: { id, organizationId: orgId },
        select: { enabled: true },
      });
      return row ? row.enabled : null;
    }
    const row = await this._channel.model.engageMonitoredChannel.findFirst({
      where: { id, organizationId: orgId },
      select: { enabled: true },
    });
    return row ? row.enabled : null;
  }

  private _label(type: 'keyword' | 'tracked' | 'subreddit'): string {
    return type === 'keyword'
      ? 'keywords'
      : type === 'tracked'
      ? 'tracked accounts'
      : 'subreddits';
  }

  private async _countEnabled(
    orgId: string,
    type: 'keyword' | 'tracked' | 'subreddit'
  ): Promise<number> {
    if (type === 'keyword') {
      return this._keyword.model.engageKeyword.count({
        where: { organizationId: orgId, enabled: true },
      });
    }
    if (type === 'tracked') {
      return this._trackedAccount.model.engageTrackedAccount.count({
        where: { organizationId: orgId, enabled: true },
      });
    }
    return this._channel.model.engageMonitoredChannel.count({
      where: { organizationId: orgId, enabled: true },
    });
  }

  // ─── Reply generation: monthly cap + credit cost ───────────────────────────

  /** All three length costs from ONE settings load (avoids 3× reads on getConfig). */
  async getAllReplyCosts(): Promise<Record<ReplyLength, number>> {
    const credits = await this._loadReplyCredits();
    const cost = (length: ReplyLength) =>
      Math.max(0, Math.round(credits.base * (credits.multipliers[length] ?? 1)));
    return { short: cost('short'), medium: cost('medium'), long: cost('long') };
  }

  /** Credits charged for a reply draft of the given length. */
  async getReplyCost(length: ReplyLength): Promise<number> {
    return (await this.getAllReplyCosts())[length];
  }

  /**
   * Reply drafts counted against the cap in the current billing period: every
   * engage_reply BillingRecord whose status is NOT 'released' (i.e. an in-flight
   * reservation, a settled charge, or a delivered-but-unbilled draft). Window =
   * billing periodStart, or the start of the calendar month (UTC) when unknown.
   */
  async countRepliesThisPeriod(orgId: string): Promise<number> {
    const plan = await this._resolvePlan(orgId);
    const windowStart =
      plan.periodStart ?? dayjs.utc().startOf('month').toDate();
    return this._billingRecord.model.billingRecord.count({
      where: this._capWindowWhere(orgId, windowStart),
    });
  }

  private _capWindowWhere(orgId: string, windowStart: Date) {
    return {
      organizationId: orgId,
      businessType: AiseeBusinessType.ENGAGE_REPLY,
      createdAt: { gte: windowStart },
      status: { not: RELEASED_STATUS },
    };
  }

  /**
   * Reserve a reply generation (spec §3.3): balance check, then ATOMICALLY
   * re-count under the cap and write a 'reserved' BillingRecord. Writing the cap
   * ledger row up-front (instead of after generation) closes the TOCTOU race —
   * concurrent reservations serialize on the count+insert and a phantom over the
   * cap predicate aborts one (Postgres SSI), and it guarantees the cap counts the
   * draft even if the later charge fails. Returns the cost + the reservation
   * taskId; the caller MUST later settleReplyGeneration (success) or
   * releaseReplyGeneration (failure/abort). Throws ForbiddenException when blocked.
   */
  async reserveReplyGeneration(
    orgId: string,
    length: ReplyLength,
    opportunityId: string
  ): Promise<{ cost: number; taskId: string }> {
    const entitlement = await this.getEntitlement(orgId);
    const cost = await this.getReplyCost(length);

    // Balance check first — it's an Aisee HTTP call and must not run inside the
    // DB transaction below. null => billing disabled: allow without a check.
    const balance = await this._aiseeCredit.getBalance(orgId);
    if (balance !== null && balance.total < cost) {
      throw new ForbiddenException({
        code: 'engage_insufficient_credits',
        required: cost,
        balance: balance.total,
        message: `Not enough credits: this reply costs ${cost} but your balance is ${balance.total}. Top up to continue.`,
      });
    }

    const taskId = `postiz_engage_reply_${opportunityId}_${Date.now()}_${randomBytes(4).toString('hex')}`;
    const reservation = {
      organizationId: orgId,
      taskId,
      amount: cost.toFixed(6),
      businessType: AiseeBusinessType.ENGAGE_REPLY,
      description: `Engage reply draft (${length})`,
      costItems: JSON.stringify([
        { type: 'text', amount: cost.toFixed(6), model: 'engage_reply', billing_mode: 'per_token', quantity: 0 },
      ]),
      relatedId: opportunityId,
      data: { length } as any,
      status: RESERVED_STATUS,
    };

    const cap = entitlement.replyMonthlyCap;
    if (cap === null) {
      // Unlimited: no cap to enforce; still write the reservation as the
      // up-front billing/ledger row so settle/release have a row to update.
      await this._billingRecord.model.billingRecord.create({ data: reservation });
      return { cost, taskId };
    }

    const plan = await this._resolvePlan(orgId);
    const windowStart =
      plan.periodStart ?? dayjs.utc().startOf('month').toDate();

    await this._runSerializable(async (tx: any) => {
      const used = await tx.billingRecord.count({
        where: this._capWindowWhere(orgId, windowStart),
      });
      if (used >= cap) {
        throw new ForbiddenException({
          code: 'engage_reply_cap_reached',
          cap,
          used,
          message: `You have reached your monthly limit of ${cap} reply drafts. Upgrade your plan to generate more.`,
        });
      }
      await tx.billingRecord.create({ data: reservation });
    });

    return { cost, taskId };
  }

  /**
   * Settle a reserved reply after a successful generation (spec §3.3 step 4):
   * deduct the fixed cost through the shared Aisee pipeline, updating the
   * reservation row in place (no new ledger row). A zero-cost reply just marks
   * the reservation settled. If the Aisee deduction itself fails the row stays
   * counted (status 'unbilled') so the cap still holds during a billing outage.
   */
  async settleReplyGeneration(
    orgId: string,
    taskId: string,
    length: ReplyLength,
    cost: number
  ): Promise<void> {
    if (cost <= 0) {
      await this._billingRecord.model.billingRecord
        .update({ where: { taskId }, data: { status: 'success' } })
        .catch(() => undefined);
      return;
    }
    await this._aiseeCredit.deductReserved({
      userId: orgId,
      taskId,
      description: `Engage reply draft (${length})`,
      costItems: [
        { type: 'text', amount: cost.toFixed(6), model: 'engage_reply', billing_mode: 'per_token', quantity: 0 },
      ],
    });
  }

  /**
   * Release a reservation when generation failed or was aborted — marks it
   * 'released' so it no longer counts toward the cap. Best-effort: the row may
   * not exist (reservation never written).
   */
  async releaseReplyGeneration(taskId: string): Promise<void> {
    await this._billingRecord.model.billingRecord
      .update({ where: { taskId }, data: { status: RELEASED_STATUS } })
      .catch(() => undefined);
  }

  /**
   * Run a function inside a SERIALIZABLE transaction, retrying a bounded number
   * of times on a serialization conflict (the mechanism that makes the cap
   * count+insert atomic against concurrent reservations).
   */
  private async _runSerializable<T>(
    fn: (tx: any) => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this._tx.model.$transaction(fn, {
          isolationLevel: 'Serializable',
        });
      } catch (err) {
        if (attempt < 3 && (err as { code?: string })?.code === SERIALIZATION_FAILURE_CODE) {
          continue;
        }
        throw err;
      }
    }
  }
}

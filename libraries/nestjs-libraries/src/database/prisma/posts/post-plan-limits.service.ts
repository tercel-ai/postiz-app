import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import {
  AISEE_PLAN_CODES,
  AiseePlanCode,
  AiseeUserCreditPackage,
  resolveAiseePlanCode,
} from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee.client';

export const POST_PLAN_LIMITS_KEY = 'post_plan_limits';

/**
 * Per-plan posting limits managed in Postiz Settings — the SOLE source of
 * truth once the user's plan resolves. The aisee-core package numbers are only
 * a fallback for unresolvable plans (unknown name/no plan code) or a Settings
 * read failure. Enforcement (permissions gate, overage deduction), the
 * dashboard summary, and the public plan catalog all read the same values.
 *
 * Values are non-negative integers or null; **null means "no limit"**.
 * `postSendLimit: 0` = "zero free posts, every post is charged as overage"
 * (posting stays allowed; only the no-active-subscription sentinel blocks
 * posting); `postSendLimit: null` = unlimited free posts (no overage ever).
 * `postChannelLimit: 0` = no channels can be connected (there is no channel
 * overage billing); `postChannelLimit: null` = unlimited channels.
 */
export interface PostPlanLimits {
  /** Free posts per billing period (the API/calendar send quota). */
  postSendLimit: number | null;
  /** Max connected channels. */
  postChannelLimit: number | null;
  /**
   * Live (non-deleted) DRAFT posts allowed PER PLATFORM, org-wide. The
   * effective cap is this x the size of the `operation_plan.allowed_platforms`
   * allowlist, so widening the allowlist widens the cap instead of squeezing it.
   *
   * Per-platform for the same reason `priorityAccountsMax` is: a draft budget is
   * spent per surface, and a flat total would mean adding a platform silently
   * cut every other platform's share.
   */
  draftsPerPlatformMax: number | null;
  /** The same budget scoped to ONE project. Both caps apply; see the invariant. */
  draftsPerPlatformPerProjectMax: number | null;
}

/**
 * Mirrors OPERATION_PLAN_ALLOWED_PLATFORMS_KEY, re-declared rather than imported
 * to avoid a posts <-> operation-plan module cycle (operation-plan already
 * imports from posts). Same trick, and same reason, as
 * engage-scan-config.service.ts.
 */
const OPERATION_PLAN_ALLOWED_PLATFORMS_SETTING = 'operation_plan.allowed_platforms';

/**
 * Platform count the draft caps multiply by, when the allowlist is unreadable or
 * empty. "Empty = no extra restriction" for the allowlist itself, but an empty
 * list must not collapse the cap to zero and block every draft.
 */
export const DEFAULT_DRAFT_PLATFORM_COUNT = 8;

/** The two draft caps resolved to absolute row counts for one org. */
export interface ResolvedDraftLimits {
  /** Org-wide ceiling on live DRAFT rows; null = unlimited. */
  orgMax: number | null;
  /** Per-project ceiling on live DRAFT rows; null = unlimited. */
  projectMax: number | null;
  /** How many platforms the per-platform numbers were multiplied by. */
  platformCount: number;
}

export type PostPlanLimitsMap = Record<AiseePlanCode, PostPlanLimits>;

/** An aisee package whose posting limits were resolved from post_plan_limits
 *  (null = no limit — a state the raw aisee package cannot express). */
export type ResolvedPostLimitsPackage = Omit<
  AiseeUserCreditPackage,
  'postSendLimit' | 'postChannelLimit'
> & {
  postSendLimit: number | null;
  postChannelLimit: number | null;
};

// Product default: NO free posts on any plan (every post goes through overage
// billing) and UNLIMITED channels, until an admin tunes a plan here. Junk
// stored values also fall back to these per-field defaults — never to null,
// which would silently grant "no limit".
//
// starter/developer/pro are legacy tiers, retained only so pre-existing
// subscriptions keep resolving (see AiseePlanCode). 'growth-loop' is the only
// plan aisee-core sells going forward.
// Draft caps are per PLATFORM, multiplied by the allowlist at read time. 500 per
// platform per project is roughly an order of magnitude above what a project
// actually holds: one 30-day operation plan materializes a few hundred rows
// across every platform, and re-running the plan soft-deletes the previous run's
// drafts (the supersede sweep in operation-plan.repository), so the live count
// does not stack plan over plan. The org number is 10x the project one — the
// ratio keywordsMax and priorityAccountsMax already use, i.e. a budget sized for
// about ten projects.
const DEFAULT_DRAFTS_PER_PLATFORM_PER_PROJECT = 500;
const DEFAULT_DRAFTS_PER_PLATFORM = 5000;

const DEFAULT_POST_PLAN_LIMITS: PostPlanLimitsMap = {
  starter: {
    postSendLimit: 0,
    postChannelLimit: null,
    draftsPerPlatformMax: DEFAULT_DRAFTS_PER_PLATFORM,
    draftsPerPlatformPerProjectMax: DEFAULT_DRAFTS_PER_PLATFORM_PER_PROJECT,
  },
  developer: {
    postSendLimit: 0,
    postChannelLimit: null,
    draftsPerPlatformMax: DEFAULT_DRAFTS_PER_PLATFORM,
    draftsPerPlatformPerProjectMax: DEFAULT_DRAFTS_PER_PLATFORM_PER_PROJECT,
  },
  pro: {
    postSendLimit: 0,
    postChannelLimit: null,
    draftsPerPlatformMax: DEFAULT_DRAFTS_PER_PLATFORM,
    draftsPerPlatformPerProjectMax: DEFAULT_DRAFTS_PER_PLATFORM_PER_PROJECT,
  },
  'growth-loop': {
    postSendLimit: 0,
    postChannelLimit: null,
    draftsPerPlatformMax: DEFAULT_DRAFTS_PER_PLATFORM,
    draftsPerPlatformPerProjectMax: DEFAULT_DRAFTS_PER_PLATFORM_PER_PROJECT,
  },
};

/**
 * Owns the plan → posting-limits mapping, mirroring how engage limits work
 * (`engage_entitlements`): aisee-core stays the authority on WHICH plan an org
 * is on, while the per-plan numbers are admin-tunable here without a redeploy.
 */
@Injectable()
export class PostPlanLimitsService implements OnModuleInit {
  private readonly logger = new Logger(PostPlanLimitsService.name);

  constructor(private readonly _settings: SettingsService) {}

  /**
   * Seed the map, and backfill any plan code the stored object predates.
   *
   * Testing only whether the KEY exists is right for a flat value and wrong for
   * a map keyed by plan: this row was written when starter/developer/pro were
   * the only codes, so 'growth-loop' — added to AISEE_PLAN_CODES afterwards —
   * could never reach the table. `getAll` merges per plan so nothing broke, but
   * the admin settings UI renders the STORED object, and it listed three tiers
   * nobody can buy any more while omitting the only one that is sold. Mirrors
   * EngageEntitlementService._seedPlansIfMissing.
   *
   * Stored entries are never touched: an admin's tuning outranks a default, and
   * a plan present in storage but absent from the defaults is left alone rather
   * than pruned.
   */
  async onModuleInit(): Promise<void> {
    const description =
      'Per-plan posting limits: postSendLimit (free posts per billing period) and postChannelLimit. null = defer to the aisee-core credit package value.';
    const existing = await this._settings.get<Record<string, unknown>>(
      POST_PLAN_LIMITS_KEY
    );
    if (existing === null || existing === undefined) {
      await this._settings.set(POST_PLAN_LIMITS_KEY, DEFAULT_POST_PLAN_LIMITS, {
        type: 'object',
        description,
        defaultValue: DEFAULT_POST_PLAN_LIMITS,
      });
      this.logger.log(`Seeded default ${POST_PLAN_LIMITS_KEY}`);
      return;
    }
    if (typeof existing !== 'object' || Array.isArray(existing)) {
      this.logger.warn(
        `${POST_PLAN_LIMITS_KEY} is not an object; leaving it alone rather than overwriting an admin's value`
      );
      return;
    }
    const missing = AISEE_PLAN_CODES.filter(
      (code) => existing[code] === undefined
    );
    if (!missing.length) return;
    await this._settings.set(
      POST_PLAN_LIMITS_KEY,
      {
        ...existing,
        ...Object.fromEntries(
          missing.map((code) => [code, DEFAULT_POST_PLAN_LIMITS[code]])
        ),
      },
      { type: 'object', description, defaultValue: DEFAULT_POST_PLAN_LIMITS }
    );
    this.logger.log(
      `Backfilled ${POST_PLAN_LIMITS_KEY} with missing plan(s): ${missing.join(', ')}`
    );
  }

  /**
   * Stored map with defaults merged per plan: a field that is ABSENT falls
   * back to the product default (postSendLimit 0 / postChannelLimit null),
   * an explicit `null` means "no limit", and junk values (strings, negatives,
   * floats) fall back to the field's DEFAULT with a warning — never to null,
   * so a typo can't silently grant an unlimited quota.
   */
  async getAll(): Promise<PostPlanLimitsMap> {
    const stored = await this._settings.get<Partial<PostPlanLimitsMap>>(
      POST_PLAN_LIMITS_KEY
    );
    return AISEE_PLAN_CODES.reduce((acc, code) => {
      const raw: Partial<PostPlanLimits> = stored?.[code] ?? {};
      acc[code] = {
        postSendLimit: this._sanitize(code, 'postSendLimit', raw.postSendLimit),
        postChannelLimit: this._sanitize(
          code,
          'postChannelLimit',
          raw.postChannelLimit
        ),
        draftsPerPlatformMax: this._sanitize(
          code,
          'draftsPerPlatformMax',
          raw.draftsPerPlatformMax
        ),
        draftsPerPlatformPerProjectMax: this._sanitize(
          code,
          'draftsPerPlatformPerProjectMax',
          raw.draftsPerPlatformPerProjectMax
        ),
      };
      return acc;
    }, {} as PostPlanLimitsMap);
  }

  private _sanitize(
    code: AiseePlanCode,
    field: keyof PostPlanLimits,
    value: unknown
  ): number | null {
    if (value === undefined) return DEFAULT_POST_PLAN_LIMITS[code][field];
    if (value === null) return null; // explicit: no limit
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      return value;
    }
    this.logger.warn(
      `Invalid ${POST_PLAN_LIMITS_KEY}.${code}.${field}=${JSON.stringify(
        value
      )} — must be a non-negative integer or null (no limit); using the default`
    );
    return DEFAULT_POST_PLAN_LIMITS[code][field];
  }

  /**
   * Resolve a package's posting limits from post_plan_limits: once the plan
   * code resolves, the Settings values REPLACE the aisee package numbers
   * entirely (null = no limit). The aisee numbers only survive as a fallback
   * when the plan can't be resolved (unknown name, no `plan` field) or the
   * Settings read fails — so a Postiz DB hiccup can only lose the plan
   * tuning, never break the permissions path that calls getUserLimits.
   */
  async applyOverrides(
    pkg: AiseeUserCreditPackage
  ): Promise<ResolvedPostLimitsPackage> {
    const code = resolveAiseePlanCode(pkg);
    if (!code) return pkg;
    try {
      const limits = (await this.getAll())[code];
      return {
        ...pkg,
        postSendLimit: limits.postSendLimit,
        postChannelLimit: limits.postChannelLimit,
      };
    } catch (err) {
      this.logger.error(
        `Failed to read ${POST_PLAN_LIMITS_KEY}; using aisee package values as-is`,
        err
      );
      return pkg;
    }
  }

  /**
   * How many platforms the per-platform draft caps multiply by.
   *
   * Reads the POST-domain allowlist (`operation_plan.allowed_platforms`), not
   * the engage scan one: drafts are posts, and a plan generates them for exactly
   * these platforms — reading a different list would let a plan produce content
   * for a platform the draft budget was never sized for.
   */
  private async _platformCount(): Promise<number> {
    try {
      const raw = await this._settings.get<unknown>(
        OPERATION_PLAN_ALLOWED_PLATFORMS_SETTING
      );
      const list = Array.isArray(raw)
        ? raw
        : typeof raw === 'string'
          ? raw.split(',')
          : [];
      const distinct = new Set(
        list.map((p) => String(p).trim().toLowerCase()).filter(Boolean)
      );
      // Empty allowlist means "no extra restriction", never "no platforms" — it
      // must not collapse the cap to zero and refuse every draft.
      return distinct.size || DEFAULT_DRAFT_PLATFORM_COUNT;
    } catch (err) {
      this.logger.error(
        `Failed to read ${OPERATION_PLAN_ALLOWED_PLATFORMS_SETTING}; sizing draft caps for ${DEFAULT_DRAFT_PLATFORM_COUNT} platforms`,
        err
      );
      return DEFAULT_DRAFT_PLATFORM_COUNT;
    }
  }

  /**
   * Absolute live-DRAFT ceilings for one plan: the per-platform numbers times
   * the allowlist size. `null` (unlimited) survives the multiplication.
   */
  async resolveDraftLimits(
    code: AiseePlanCode | null
  ): Promise<ResolvedDraftLimits> {
    const platformCount = await this._platformCount();
    // No resolvable plan → no draft ceiling to enforce. Posting itself is
    // already blocked for those accounts by the no-active-subscription sentinel
    // in getUserLimits, so gating drafts here would only add a second, more
    // confusing refusal on a path that never gets that far.
    if (!code) return { orgMax: null, projectMax: null, platformCount };
    const limits = (await this.getAll())[code];
    const scale = (per: number | null) =>
      per === null ? null : per * platformCount;
    return {
      orgMax: scale(limits.draftsPerPlatformMax),
      projectMax: scale(limits.draftsPerPlatformPerProjectMax),
      platformCount,
    };
  }
}

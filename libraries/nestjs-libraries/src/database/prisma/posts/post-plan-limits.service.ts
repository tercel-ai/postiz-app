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
const DEFAULT_POST_PLAN_LIMITS: PostPlanLimitsMap = {
  starter: { postSendLimit: 0, postChannelLimit: null },
  developer: { postSendLimit: 0, postChannelLimit: null },
  pro: { postSendLimit: 0, postChannelLimit: null },
  'growth-loop': { postSendLimit: 0, postChannelLimit: null },
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

  async onModuleInit(): Promise<void> {
    const existing = await this._settings.get(POST_PLAN_LIMITS_KEY);
    if (existing === null || existing === undefined) {
      await this._settings.set(POST_PLAN_LIMITS_KEY, DEFAULT_POST_PLAN_LIMITS, {
        type: 'object',
        description:
          'Per-plan posting limits: postSendLimit (free posts per billing period) and postChannelLimit. null = defer to the aisee-core credit package value.',
        defaultValue: DEFAULT_POST_PLAN_LIMITS,
      });
      this.logger.log(`Seeded default ${POST_PLAN_LIMITS_KEY}`);
    }
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
}

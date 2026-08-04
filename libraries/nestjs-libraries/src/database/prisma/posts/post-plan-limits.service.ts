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
 * Per-plan posting limits managed in Postiz Settings. `null` means "no
 * override — keep the number aisee-core's credit package reports". Once a
 * value is set here it becomes the source of truth for that plan: enforcement
 * (permissions gate, overage deduction), the dashboard summary, and the public
 * plan catalog all flow through the same override.
 *
 * Values are non-negative integers or null. `postSendLimit: 0` is a real
 * quota — "zero free posts, every post is charged as overage" (posting stays
 * allowed; only the no-active-subscription sentinel blocks posting).
 * `postChannelLimit: 0` literally means "no channels can be connected" —
 * there is no channel overage billing.
 */
export interface PostPlanLimits {
  /** Free posts per billing period (the API/calendar send quota). */
  postSendLimit: number | null;
  /** Max connected channels. */
  postChannelLimit: number | null;
}

export type PostPlanLimitsMap = Record<AiseePlanCode, PostPlanLimits>;

// Product default: NO free posts on any plan — every post goes through
// overage billing until an admin raises a plan's quota here. Channel caps
// stay deferred to the aisee-core package value (0 would mean "no channels
// at all", which is not a sane default).
const DEFAULT_POST_PLAN_LIMITS: PostPlanLimitsMap = {
  starter: { postSendLimit: 0, postChannelLimit: null },
  developer: { postSendLimit: 0, postChannelLimit: null },
  pro: { postSendLimit: 0, postChannelLimit: null },
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
   * while an explicit `null` means "defer to the aisee-core package value".
   * Junk values (strings, negatives, floats) sanitise to null with a warning
   * so they can neither corrupt enforcement nor leak into the public catalog.
   */
  async getAll(): Promise<PostPlanLimitsMap> {
    const stored = await this._settings.get<Partial<PostPlanLimitsMap>>(
      POST_PLAN_LIMITS_KEY
    );
    return AISEE_PLAN_CODES.reduce((acc, code) => {
      const raw: Partial<PostPlanLimits> = stored?.[code] ?? {};
      acc[code] = {
        postSendLimit:
          raw.postSendLimit === undefined
            ? DEFAULT_POST_PLAN_LIMITS[code].postSendLimit
            : this._sanitize(code, 'postSendLimit', raw.postSendLimit),
        postChannelLimit:
          raw.postChannelLimit === undefined
            ? DEFAULT_POST_PLAN_LIMITS[code].postChannelLimit
            : this._sanitize(code, 'postChannelLimit', raw.postChannelLimit),
      };
      return acc;
    }, {} as PostPlanLimitsMap);
  }

  private _sanitize(
    code: AiseePlanCode,
    field: keyof PostPlanLimits,
    value: unknown
  ): number | null {
    if (value === null) return null;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      return value;
    }
    this.logger.warn(
      `Ignoring invalid ${POST_PLAN_LIMITS_KEY}.${code}.${field}=${JSON.stringify(
        value
      )} — must be a non-negative integer or null`
    );
    return null;
  }

  /**
   * Apply the plan's Settings overrides onto an aisee credit package: each
   * configured value replaces the package's number; nulls leave the aisee
   * value untouched. Packages whose plan can't be resolved (unknown name, no
   * `plan` field) pass through unchanged — as does everything on a Settings
   * read failure, so a Postiz DB hiccup can only lose the override, never
   * break the permissions path that calls getUserLimits.
   */
  async applyOverrides(
    pkg: AiseeUserCreditPackage
  ): Promise<AiseeUserCreditPackage> {
    const code = resolveAiseePlanCode(pkg);
    if (!code) return pkg;
    try {
      const limits = (await this.getAll())[code];
      return {
        ...pkg,
        postSendLimit: limits.postSendLimit ?? pkg.postSendLimit,
        postChannelLimit: limits.postChannelLimit ?? pkg.postChannelLimit,
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

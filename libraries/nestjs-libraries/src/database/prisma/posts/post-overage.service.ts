import { ForbiddenException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { AiseeCreditService } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee-credit.service';
import { AiseeBusinessType } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee.client';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { PostPlanLimitsService } from '@gitroom/nestjs-libraries/database/prisma/posts/post-plan-limits.service';
import { resolveAiseePlanCode } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee.client';
import {
  RISK_GATES,
  RiskControlTickService,
} from '@gitroom/nestjs-libraries/risk-control/risk-control-tick.service';

const SETTINGS_KEY = 'post_send_overage_cost';
const DEFAULT_OVERAGE_COST = 25;

@Injectable()
export class PostOverageService implements OnModuleInit {
  private readonly logger = new Logger(PostOverageService.name);

  constructor(
    private readonly _settingsService: SettingsService,
    private readonly _postsRepository: PostsRepository,
    private readonly _aiseeCreditService: AiseeCreditService,
    private readonly _usersService: UsersService,
    // Optional so the specs that build this service positionally keep working;
    // DatabaseModule always provides it at runtime. A missing one disables the
    // draft gate rather than blocking every draft.
    private readonly _postPlanLimits?: PostPlanLimitsService,
    private readonly _riskTicks?: RiskControlTickService
  ) {}

  /**
   * Refuse a batch of DRAFTS that would carry the org past its plan's ceiling.
   *
   * Drafts are deliberately NOT billed — a free scratchpad is the intended
   * product semantics — which is exactly why they need a different bound.
   * `countPostsFromDay` counts only QUEUE and PUBLISHED, so a draft never moves
   * the number the overage charge tests against: before this, draft creation was
   * free, unrated and batchable all at once.
   *
   * Both scopes are checked and the effective head-room is the smaller, matching
   * how the engage caps work. The org cap is what actually bounds an account:
   * growth-loop's project limit in aisee-core is null (unlimited), so a
   * per-project cap alone would be `cap x infinity`.
   */
  async assertDraftQuota(
    orgId: string,
    userId: string | undefined,
    requested: number,
    projectId?: string | null
  ): Promise<void> {
    if (!this._postPlanLimits || !userId || requested <= 0) return;

    const pkg = await this._usersService.getUserLimits(userId);
    // Billing off (null) or no active subscription: nothing to size a cap from,
    // and the latter is already refused by the permissions gate — a second,
    // differently-worded refusal here would only obscure the real reason.
    if (!pkg || 'noActiveSubscription' in pkg) return;

    const { orgMax, projectMax, platformCount } =
      await this._postPlanLimits.resolveDraftLimits(resolveAiseePlanCode(pkg));
    if (orgMax === null && projectMax === null) return;

    const [orgCount, projectCount] = await Promise.all([
      orgMax === null ? Promise.resolve(0) : this._postsRepository.countLiveDrafts(orgId),
      projectMax === null || !projectId
        ? Promise.resolve(0)
        : this._postsRepository.countLiveDrafts(orgId, projectId),
    ]);

    const breach =
      orgMax !== null && orgCount + requested > orgMax
        ? { scope: 'organization' as const, max: orgMax, current: orgCount }
        : projectMax !== null && projectId && projectCount + requested > projectMax
          ? { scope: 'project' as const, max: projectMax, current: projectCount }
          : null;
    if (!breach) return;

    this.logger.warn(
      `[drafts orgId=${orgId}${projectId ? ` projectId=${projectId}` : ''}] ` +
        `${breach.scope} cap reached: ${breach.current} + ${requested} > ${breach.max}`
    );
    // The draft cap is the one control whose head-room IS queryable, but a
    // refusal still needs recording: head-room says how close accounts are, not
    // whether anyone actually met the cap and got turned away.
    await this._riskTicks?.record({
      gate: RISK_GATES.postDraftLimit,
      organizationId: orgId,
      detail: breach.scope,
    });
    throw new ForbiddenException({
      code: 'post_draft_limit_reached',
      // Which cap refused this — the frontend needs it to word the remedy
      // ("delete drafts in this project" vs "across the account").
      scope: breach.scope,
      max: breach.max,
      current: breach.current,
      requested,
      platformCount,
      message:
        `Draft limit reached: this ${breach.scope} already holds ` +
        `${breach.current} of ${breach.max} drafts. Delete or publish some to make room.`,
    });
  }

  async onModuleInit(): Promise<void> {
    const existing = await this._settingsService.get(SETTINGS_KEY);
    if (existing === null || existing === undefined) {
      await this._settingsService.set(SETTINGS_KEY, DEFAULT_OVERAGE_COST, {
        type: 'number',
        description: 'Credits deducted per post when the monthly send limit is exceeded.',
        defaultValue: DEFAULT_OVERAGE_COST,
      });
      this.logger.log(`Seeded default ${SETTINGS_KEY}=${DEFAULT_OVERAGE_COST}`);
    }
  }

  async getOverageCost(): Promise<number> {
    const value = await this._settingsService.get<number>(SETTINGS_KEY);
    return value ?? DEFAULT_OVERAGE_COST;
  }

  /**
   * After a post is created, check if the user is over their monthly limit.
   * If so, deduct overageCost credits from their Aisee balance.
   * Fire-and-forget — does not block the response.
   *
   * `source` reflects the originating Post.source (e.g. 'calendar', 'chat',
   * 'engage') so the overage record can be attributed correctly in audits.
   */
  async deductIfOverage(
    orgId: string,
    userId: string,
    postId: string,
    source: string = 'calendar'
  ): Promise<void> {
    const tag = `[overage orgId=${orgId} postId=${postId} source=${source}]`;
    try {
      const limits = await this._usersService.getUserLimits(userId);

      // Skip when billing is off (null limits) or there is no active
      // subscription (sentinel marker — those users are blocked from posting
      // anyway). postSendLimit=null means "no limit — never overage-charge";
      // postSendLimit=0 is a REAL quota ("zero free posts") and must fall
      // through so every post is charged as overage.
      if (!limits || 'noActiveSubscription' in limits) {
        return;
      }
      const sendLimit = limits.postSendLimit;
      if (sendLimit === null || !Number.isFinite(sendLimit)) {
        return;
      }

      const periodStart = limits && 'periodStart' in limits && limits.periodStart
        ? new Date(limits.periodStart)
        : null;

      if (!periodStart) {
        this.logger.warn(`${tag} no periodStart — skipped`);
        return;
      }

      const count = await this._postsRepository.countPostsFromDay(orgId, periodStart);

      if (count <= sendLimit) {
        return;
      }

      const overageCost = await this.getOverageCost();
      const taskId = `postiz_post_overage_${postId}`;

      this.logger.log(`${tag} DEDUCT ${overageCost} credits (${count}/${sendLimit})`);

      await this._aiseeCreditService.deductAndConfirm({
        userId: orgId,
        taskId,
        businessType: AiseeBusinessType.POST_OVERAGE,
        description: `Post overage: ${count}/${sendLimit} posts used this period`,
        relatedId: postId,
        data: { source },
        costItems: [
          {
            type: 'text',
            amount: overageCost.toFixed(6),
            model: 'post_send',
            billing_mode: 'per_token',
            quantity: 0,
          },
        ],
      });
    } catch (error) {
      this.logger.error(`${tag} FAILED:`, error);
    }
  }
}

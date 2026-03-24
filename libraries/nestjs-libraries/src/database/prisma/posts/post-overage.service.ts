import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { AiseeCreditService } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee-credit.service';
import { AiseeBusinessType } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee.client';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';

const SETTINGS_KEY = 'post_send_overage_cost';
const DEFAULT_OVERAGE_COST = 25;

@Injectable()
export class PostOverageService implements OnModuleInit {
  private readonly logger = new Logger(PostOverageService.name);

  constructor(
    private readonly _settingsService: SettingsService,
    private readonly _postsRepository: PostsRepository,
    private readonly _aiseeCreditService: AiseeCreditService,
    private readonly _usersService: UsersService
  ) {}

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
   */
  async deductIfOverage(orgId: string, userId: string, postId: string): Promise<void> {
    const tag = `[deductIfOverage orgId=${orgId} userId=${userId} postId=${postId}]`;
    try {
      this.logger.log(`${tag} START`);

      const limits = await this._usersService.getUserLimits(userId);
      this.logger.log(
        `${tag} getUserLimits returned: postSendLimit=${limits.postSendLimit} postChannelLimit=${limits.postChannelLimit}` +
        ('periodStart' in limits ? ` periodStart=${limits.periodStart} periodEnd=${limits.periodEnd}` : ' (no period info)')
      );

      // No active subscription or hard-blocked — nothing to deduct
      if (!limits.postSendLimit) {
        this.logger.warn(`${tag} SKIP — postSendLimit is falsy (${limits.postSendLimit}), no active subscription`);
        return;
      }

      const periodStart = 'periodStart' in limits && limits.periodStart
        ? new Date(limits.periodStart)
        : null;

      if (!periodStart) {
        this.logger.warn(`${tag} SKIP — periodStart is missing or falsy`);
        return;
      }

      const count = await this._postsRepository.countPostsFromDay(orgId, periodStart);
      this.logger.log(`${tag} countPostsFromDay(orgId=${orgId}, since=${periodStart.toISOString()}) = ${count}, limit=${limits.postSendLimit}`);

      if (count <= limits.postSendLimit) {
        this.logger.log(`${tag} SKIP — count(${count}) <= limit(${limits.postSendLimit}), within allowance`);
        return;
      }

      const overageCost = await this.getOverageCost();
      // Fixed taskId (no random suffix) — ensures Aisee-side idempotency on retry
      const taskId = `postiz_post_overage_${postId}`;

      this.logger.log(`${tag} DEDUCTING: cost=${overageCost} taskId=${taskId} count=${count}/${limits.postSendLimit}`);

      await this._aiseeCreditService.deductAndConfirm({
        userId: orgId,
        taskId,
        businessType: AiseeBusinessType.POST_OVERAGE,
        description: `Post overage: ${count}/${limits.postSendLimit} posts used this period`,
        relatedId: postId,
        data: { source: 'calendar' },
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

      this.logger.log(`${tag} SUCCESS — deducted ${overageCost} credits`);
    } catch (error) {
      this.logger.error(`${tag} FAILED:`, error);
    }
  }
}

import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SuperAdmin } from '@gitroom/backend/services/auth/admin/super-admin.decorator';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';

@ApiTags('Admin')
@Controller('/admin/diagnostics')
@SuperAdmin()
export class AdminDiagnosticsController {
  constructor(
    private _postsRepository: PostsRepository,
    private _integrationRepository: IntegrationRepository
  ) {}

  /**
   * GET /admin/diagnostics/recurring-posts
   *
   * Checks for anomalies in recurring post data:
   * 1. Premature clones: published before their publishDate
   * 2. Duplicate clones: multiple PUBLISHED clones for the same day
   * 3. Missed cycles: expected publishDate passed with no clone
   */
  @Get('/recurring-posts')
  async checkRecurringPosts() {
    const results = {
      checkedAt: new Date().toISOString(),
      prematureClones: [] as any[],
      duplicateClones: [] as any[],
      missedCycles: [] as any[],
    };

    const recurringPosts = await this._postsRepository.findRecurringPosts();

    if (recurringPosts.length === 0) {
      return { ...results, summary: { recurringPostsCount: 0, totalClones: 0, prematureCount: 0, duplicateCount: 0, missedCount: 0, healthy: true } };
    }

    const recurringIds = recurringPosts.map((p) => p.id);
    const recurringGroups = recurringPosts.map((p) => p.group);
    const allClones = await this._postsRepository.findClonesByGroups(recurringGroups, recurringIds);

    const cloneMap = new Map<string, typeof allClones>();
    for (const clone of allClones) {
      if (!clone.group) continue;
      if (!cloneMap.has(clone.group)) {
        cloneMap.set(clone.group, []);
      }
      cloneMap.get(clone.group)!.push(clone);
    }

    const now = new Date();

    for (const post of recurringPosts) {
      const clones = cloneMap.get(post.group) || [];

      // Check 1: Premature clones — createdAt is significantly before publishDate (>1h)
      for (const clone of clones) {
        if (clone.state !== 'PUBLISHED') continue;
        const publishTime = new Date(clone.publishDate).getTime();
        const createdTime = new Date(clone.createdAt).getTime();
        if (publishTime - createdTime > 60 * 60 * 1000) {
          results.prematureClones.push({
            cloneId: clone.id,
            sourcePostId: post.id,
            publishDate: clone.publishDate,
            createdAt: clone.createdAt,
            releaseURL: clone.releaseURL,
            gapHours: +((publishTime - createdTime) / (60 * 60 * 1000)).toFixed(1),
            integration: post.integration,
          });
        }
      }

      // Check 2: Duplicate clones — multiple PUBLISHED clones with same day publishDate
      const publishedByDay = new Map<string, typeof clones>();
      for (const clone of clones) {
        if (clone.state !== 'PUBLISHED') continue;
        const day = new Date(clone.publishDate).toISOString().slice(0, 10);
        if (!publishedByDay.has(day)) publishedByDay.set(day, []);
        publishedByDay.get(day)!.push(clone);
      }
      for (const [day, dayClones] of publishedByDay) {
        if (dayClones.length > 1) {
          results.duplicateClones.push({
            sourcePostId: post.id,
            day,
            count: dayClones.length,
            clones: dayClones.map((c) => ({
              id: c.id,
              createdAt: c.createdAt,
              publishDate: c.publishDate,
              releaseURL: c.releaseURL,
            })),
            integration: post.integration,
          });
        }
      }

      // Check 3: Missed cycles — past 7 days, expected publishDate with no clone
      if (post.intervalInDays && post.intervalInDays > 0) {
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const cloneDates = new Set(
          clones
            .filter((c) => c.state === 'PUBLISHED' || c.state === 'ERROR')
            .map((c) => new Date(c.publishDate).toISOString().slice(0, 10))
        );

        let checkDate = new Date(post.publishDate);
        while (checkDate > sevenDaysAgo) {
          checkDate = new Date(checkDate.getTime() - post.intervalInDays * 24 * 60 * 60 * 1000);
        }
        while (checkDate < now) {
          if (checkDate > sevenDaysAgo) {
            const dayStr = checkDate.toISOString().slice(0, 10);
            if (!cloneDates.has(dayStr)) {
              results.missedCycles.push({
                sourcePostId: post.id,
                expectedDate: dayStr,
                intervalInDays: post.intervalInDays,
                integration: post.integration,
              });
            }
          }
          checkDate = new Date(checkDate.getTime() + post.intervalInDays * 24 * 60 * 60 * 1000);
        }
      }
    }

    return {
      ...results,
      summary: {
        recurringPostsCount: recurringPosts.length,
        totalClones: allClones.length,
        prematureCount: results.prematureClones.length,
        duplicateCount: results.duplicateClones.length,
        missedCount: results.missedCycles.length,
        healthy:
          results.prematureClones.length === 0 &&
          results.duplicateClones.length === 0 &&
          results.missedCycles.length === 0,
      },
    };
  }

  /**
   * GET /admin/diagnostics/stuck-posts
   *
   * Finds non-recurring posts stuck in QUEUE past their publishDate (>2h).
   * These should have been picked up by missingPostWorkflow but weren't.
   */
  @Get('/stuck-posts')
  async checkStuckPosts() {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const stuckPosts = await this._postsRepository.findStuckQueuePosts(twoHoursAgo);

    return {
      checkedAt: new Date().toISOString(),
      stuckPosts: stuckPosts.map((p) => ({
        id: p.id,
        publishDate: p.publishDate,
        createdAt: p.createdAt,
        stuckHours: +((Date.now() - new Date(p.publishDate).getTime()) / (60 * 60 * 1000)).toFixed(1),
        intervalInDays: p.intervalInDays,
        integration: p.integration,
        organizationId: p.organizationId,
      })),
      summary: {
        count: stuckPosts.length,
        healthy: stuckPosts.length === 0,
      },
    };
  }

  /**
   * GET /admin/diagnostics/integrations
   *
   * Finds integrations with health issues:
   * 1. refreshNeeded: token expired, needs reconnection
   * 2. inBetweenSteps: stuck in OAuth flow
   * 3. disabled: manually disabled
   * Also counts QUEUE posts per unhealthy integration (posts that can't publish).
   */
  @Get('/integrations')
  async checkIntegrations() {
    const unhealthy = await this._integrationRepository.findUnhealthyIntegrations();

    const integrationIds = unhealthy.map((i) => i.id);
    const blockedPostCounts = integrationIds.length
      ? await this._postsRepository.countQueuePostsByIntegrations(integrationIds)
      : [];

    const blockedMap = new Map(blockedPostCounts.map((r) => [r.integrationId, r._count]));

    return {
      checkedAt: new Date().toISOString(),
      unhealthyIntegrations: unhealthy.map((i) => ({
        id: i.id,
        name: i.name,
        provider: i.providerIdentifier,
        organizationId: i.organizationId,
        refreshNeeded: i.refreshNeeded,
        inBetweenSteps: i.inBetweenSteps,
        disabled: i.disabled,
        blockedQueuePosts: blockedMap.get(i.id) || 0,
      })),
      summary: {
        total: unhealthy.length,
        refreshNeeded: unhealthy.filter((i) => i.refreshNeeded).length,
        inBetweenSteps: unhealthy.filter((i) => i.inBetweenSteps).length,
        disabled: unhealthy.filter((i) => i.disabled).length,
        healthy: unhealthy.length === 0,
      },
    };
  }

  /**
   * GET /admin/diagnostics/error-posts
   *
   * Finds recent ERROR posts (last 7 days) with their error details.
   */
  @Get('/error-posts')
  async checkErrorPosts() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const errorPosts = await this._postsRepository.findRecentErrorPosts(sevenDaysAgo);

    return {
      checkedAt: new Date().toISOString(),
      errorPosts: errorPosts.map((p) => ({
        id: p.id,
        publishDate: p.publishDate,
        createdAt: p.createdAt,
        error: p.error,
        sourcePostId: p.sourcePostId,
        integration: p.integration,
        organizationId: p.organizationId,
      })),
      summary: {
        count: errorPosts.length,
        healthy: errorPosts.length === 0,
      },
    };
  }

  /**
   * GET /admin/diagnostics/overview
   *
   * Aggregated health check across all diagnostics.
   */
  @Get('/overview')
  async overview() {
    const [recurring, stuck, integrations, errors] = await Promise.all([
      this.checkRecurringPosts(),
      this.checkStuckPosts(),
      this.checkIntegrations(),
      this.checkErrorPosts(),
    ]);

    return {
      checkedAt: new Date().toISOString(),
      healthy:
        recurring.summary.healthy &&
        stuck.summary.healthy &&
        integrations.summary.healthy &&
        errors.summary.healthy,
      recurringPosts: recurring.summary,
      stuckPosts: stuck.summary,
      integrations: integrations.summary,
      errorPosts: errors.summary,
    };
  }
}

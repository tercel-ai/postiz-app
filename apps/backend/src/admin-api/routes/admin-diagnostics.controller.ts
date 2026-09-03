import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SuperAdmin } from '@gitroom/backend/services/auth/admin/super-admin.decorator';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';
import {
  EngageScanLeaseService,
  normalizeKeyword,
  normalizeUsername,
} from '@gitroom/nestjs-libraries/engage/engage-scan-lease.service';
import { SCANNABLE_PLATFORMS } from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';
import { PostPlanLimitsService } from '@gitroom/nestjs-libraries/database/prisma/posts/post-plan-limits.service';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { isExtensionPublishProvider } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { RiskControlTickService } from '@gitroom/nestjs-libraries/risk-control/risk-control-tick.service';

type ReleaseScanCursorBody = {
  platform?: string;
  scanType?: string;
  scanKey?: string;
  clearCooldown?: boolean;
};

function normalizeDebugScanKey(platform: string, scanType: string, scanKey: string): string {
  if (scanType === 'keyword') return normalizeKeyword(scanKey);
  if (scanType === 'tracked') return normalizeUsername(platform, scanKey);
  return scanKey.trim();
}

@ApiTags('Admin')
@Controller('/admin/diagnostics')
@SuperAdmin()
export class AdminDiagnosticsController {
  constructor(
    private _postsRepository: PostsRepository,
    private _integrationRepository: IntegrationRepository,
    private _engageRepository: EngageRepository,
    private _engageScanLeaseService: EngageScanLeaseService,
    private _postPlanLimits: PostPlanLimitsService,
    private _post: PrismaRepository<'post'>,
    private _riskTicks: RiskControlTickService
  ) {}

  /**
   * GET /admin/diagnostics/write-limits
   *
   * How close accounts are to the write-path ceilings (see
   * docs/engage/write-path-limits.md).
   *
   * Reports HEAD-ROOM, not breaches, and the distinction is the point. A breach
   * count reads zero whether a limit is perfectly tuned or a thousand times too
   * high, so it cannot tell you the limit is wrong until it already hurt
   * someone; the distance between the busiest account and the cap can, while
   * there is still time to move it.
   *
   * Only the DRAFT cap is measurable from durable state. The ingest quota and
   * the route throttles count in Redis under a short TTL, so nothing about
   * yesterday survives — an accurate "who was refused yesterday" needs those
   * refusals persisted, which is a schema change and not done here. Until then
   * a refusal exists only as a logged warning (`post_draft_limit_reached`,
   * `engage_ingest_quota_exceeded`, and the throttler's own 429s).
   */
  @Get('/write-limits')
  async checkWriteLimits() {
    // Sized for growth-loop, the only plan still sold; the legacy tiers share
    // the same defaults today, so one set of numbers covers every live account.
    const { orgMax, projectMax, platformCount } =
      await this._postPlanLimits.resolveDraftLimits('growth-loop');

    const [rows, rejections] = await Promise.all([
      this._post.model.post.groupBy({
        by: ['organizationId', 'projectId'],
        where: { state: 'DRAFT', deletedAt: null, parentPostId: null },
        _count: { _all: true },
      }),
      this._rejectionReport(),
    ]);

    const perOrg = new Map<string, number>();
    for (const r of rows) {
      perOrg.set(r.organizationId, (perOrg.get(r.organizationId) ?? 0) + r._count._all);
    }

    // "Approaching" at 80%: far enough out that there is room to react, close
    // enough that it is not noise.
    const NEAR = 0.8;
    const near = (used: number, cap: number | null) =>
      cap !== null && used >= cap * NEAR;

    const orgs = [...perOrg.entries()]
      .map(([organizationId, used]) => ({
        organizationId,
        used,
        cap: orgMax,
        pctOfCap: orgMax ? Math.round((used / orgMax) * 100) : null,
      }))
      .sort((a, b) => b.used - a.used);

    const projects = rows
      .filter((r) => r.projectId)
      .map((r) => ({
        organizationId: r.organizationId,
        projectId: r.projectId as string,
        used: r._count._all,
        cap: projectMax,
        pctOfCap: projectMax ? Math.round((r._count._all / projectMax) * 100) : null,
      }))
      .sort((a, b) => b.used - a.used);

    const orgsNear = orgs.filter((o) => near(o.used, orgMax));
    const projectsNear = projects.filter((p) => near(p.used, projectMax));

    return {
      drafts: {
        caps: { perOrg: orgMax, perProject: projectMax, platformCount },
        // The busiest few are the calibration signal: a top account sitting at
        // 1% of the cap says the cap bounds nothing in practice.
        topOrgs: orgs.slice(0, 10),
        topProjects: projects.slice(0, 10),
        approachingOrgs: orgsNear,
        approachingProjects: projectsNear,
      },
      rejections,
      summary: {
        orgsApproachingCap: orgsNear.length,
        projectsApproachingCap: projectsNear.length,
        busiestOrgDrafts: orgs[0]?.used ?? 0,
        busiestProjectDrafts: projects[0]?.used ?? 0,
        rejectionsYesterday: rejections.yesterday.total,
        rejectionsLast7Days: rejections.last7Days.total,
        // Head-room alone reads healthy right up until a cap refuses a real
        // customer, so a refusal counts against health even when nothing is
        // near a cap — the two answer different questions.
        healthy:
          orgsNear.length === 0 &&
          projectsNear.length === 0 &&
          rejections.yesterday.total === 0,
      },
    };
  }

  /**
   * Refusals actually served, from the durable counters (RiskControlTick).
   *
   * The counterpart to head-room above. Head-room says whether a cap is set
   * sanely; this says whether anyone met it — and for the ingest quota and the
   * route throttles it is the ONLY signal, since both count in Redis under short
   * TTLs and leave no trace by the next day.
   */
  private async _rejectionReport() {
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const yesterday = new Date(startOfToday.getTime() - 86_400_000);
    const weekAgo = new Date(startOfToday.getTime() - 7 * 86_400_000);

    const [yesterdayByGate, yesterdayOrgs, weekByGate] = await Promise.all([
      this._riskTicks.totalsByGate({ from: yesterday, to: yesterday }),
      this._riskTicks.topOrgs({ from: yesterday, to: yesterday, limit: 10 }),
      this._riskTicks.totalsByGate({ from: weekAgo }),
    ]);
    const sum = (m: Record<string, number>) =>
      Object.values(m).reduce((a, b) => a + b, 0);

    return {
      yesterday: {
        date: yesterday.toISOString().slice(0, 10),
        byGate: yesterdayByGate,
        topOrgs: yesterdayOrgs,
        total: sum(yesterdayByGate),
      },
      last7Days: { byGate: weekByGate, total: sum(weekByGate) },
    };
  }

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

    const rows = await this._postsRepository.findStuckQueuePosts(twoHoursAgo);

    // A post with no publishMethod on an extension-routed platform is NOT
    // stuck — it is waiting for the user's browser, which is the normal state
    // of the default send path. Counting those as stuck would bury the genuinely
    // stuck ones in noise; dropping them would hide an extension fleet that is
    // offline. Report both, separately.
    const shape = (p: (typeof rows)[number]) => ({
      id: p.id,
      publishDate: p.publishDate,
      createdAt: p.createdAt,
      stuckHours: +((Date.now() - new Date(p.publishDate).getTime()) / (60 * 60 * 1000)).toFixed(1),
      intervalInDays: p.intervalInDays,
      integration: p.integration,
      organizationId: p.organizationId,
      providerIdentifier: p.providerIdentifier,
    });
    const waitingForExtension = rows.filter((p) =>
      isExtensionPublishProvider(
        p.providerIdentifier || p.integration?.providerIdentifier || ''
      )
    );
    const stuckPosts = rows.filter((p) => !waitingForExtension.includes(p));

    return {
      checkedAt: new Date().toISOString(),
      stuckPosts: stuckPosts.map(shape),
      // Expected to be non-empty whenever browsers are simply not open; a large
      // or growing number is the signal that the extension fleet is down.
      waitingForExtension: waitingForExtension.map(shape),
      summary: {
        count: stuckPosts.length,
        waitingForExtensionCount: waitingForExtension.length,
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
   * GET /admin/diagnostics/engage-scan-cursors
   *
   * Finds EngageScanCursor rows stuck in SCANNING state for more than 2 hours.
   * A stuck cursor means the Temporal workflow that owns the scan exited without
   * resetting it, blocking all future scans for that platform/scanType/scanKey.
   */
  @Get('/engage-scan-cursors')
  async checkEngageScanCursors() {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const stuckCursors = await this._engageRepository.findStuckScanCursors(twoHoursAgo);

    return {
      checkedAt: new Date().toISOString(),
      stuckCursors: stuckCursors.map((c) => ({
        id: c.id,
        platform: c.platform,
        scanType: c.scanType,
        scanKey: c.scanKey,
        lastScanStartedAt: c.lastScanStartedAt,
        lastScannedAt: c.lastScannedAt,
        stuckHours: c.lastScanStartedAt
          ? +((Date.now() - new Date(c.lastScanStartedAt).getTime()) / (60 * 60 * 1000)).toFixed(1)
          : null,
      })),
      summary: {
        count: stuckCursors.length,
        healthy: stuckCursors.length === 0,
      },
    };
  }

  /**
   * POST /admin/diagnostics/engage-scan-cursors/release
   *
   * Debug-only global release for an EngageScanCursor lease. This does not
   * advance cursor fields; it only clears a fresh/stuck SCANNING lease so the
   * same platform/scanType/scanKey unit can be claimed again.
   */
  @Post('/engage-scan-cursors/release')
  async releaseEngageScanCursor(@Body() body: ReleaseScanCursorBody) {
    const platform = String(body?.platform ?? '').trim().toLowerCase();
    const scanType = String(body?.scanType ?? '').trim().toLowerCase();
    const rawScanKey = String(body?.scanKey ?? '').trim();

    if (!SCANNABLE_PLATFORMS.includes(platform as (typeof SCANNABLE_PLATFORMS)[number])) {
      throw new BadRequestException(
        `platform must be one of: ${SCANNABLE_PLATFORMS.join(', ')}`
      );
    }
    if (!['keyword', 'tracked', 'channel'].includes(scanType)) {
      throw new BadRequestException('scanType must be one of: keyword, tracked, channel');
    }
    if (!rawScanKey) {
      throw new BadRequestException('scanKey is required');
    }

    const scanKey = normalizeDebugScanKey(platform, scanType, rawScanKey);
    if (!scanKey) {
      throw new BadRequestException('scanKey is invalid after normalization');
    }

    return this._engageScanLeaseService.releaseByUnit({
      platform,
      scanType,
      scanKey,
      clearCooldown: body?.clearCooldown === true,
    });
  }

  /**
   * GET /admin/diagnostics/engage-failed-scans
   *
   * Finds EngageKeywordInitialScan rows that are FAILED or stuck in RUNNING
   * for more than 1 hour. Failed initial scans mean the org's keyword never
   * got a historical backfill, so users see no opportunities for that keyword.
   */
  @Get('/engage-failed-scans')
  async checkEngageFailedScans() {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const failedScans = await this._engageRepository.findFailedKeywordScans(oneHourAgo);

    const failedCount = failedScans.filter((s) => s.status === 'FAILED').length;
    const stuckCount = failedScans.filter((s) => s.status === 'RUNNING').length;

    return {
      checkedAt: new Date().toISOString(),
      failedScans: failedScans.map((s) => ({
        id: s.id,
        organizationId: s.organizationId,
        keyword: s.keyword,
        platform: s.platform,
        status: s.status,
        startedAt: s.startedAt,
        attempts: s.attempts,
        error: s.error,
      })),
      summary: {
        total: failedScans.length,
        failedCount,
        stuckCount,
        healthy: failedScans.length === 0,
      },
    };
  }

  /**
   * GET /admin/diagnostics/engage-keyword-subscribers
   *
   * Per-keyword ACTIVATED-subscriber counts: how many orgs have each keyword
   * actually running (EngageConfig.enabled AND EngageKeyword.enabled), keyed by
   * the normalized keyword so case/whitespace variants collapse. "Activated",
   * not merely "added" — a keyword on a disabled config, or a disabled keyword,
   * is excluded. Live query; reflects the current enable/disable state exactly.
   */
  @Get('/engage-keyword-subscribers')
  async checkEngageKeywordSubscribers() {
    const items = await this._engageRepository.getKeywordActivationStats();

    return {
      checkedAt: new Date().toISOString(),
      items, // [{ keyword, activatedOrgs, variants }]
      summary: {
        distinctKeywords: items.length,
        totalActivations: items.reduce((s, i) => s + i.activatedOrgs, 0),
      },
    };
  }

  /**
   * GET /admin/diagnostics/engage-dead-reply-accounts
   *
   * Finds project bindings with engageEnabled=true but whose linked
   * Integration has refreshNeeded=true or disabled=true. These accounts will
   * silently fail to send or auto-reply without any user-visible error.
   */
  @Get('/engage-dead-reply-accounts')
  async checkEngageDeadReplyAccounts() {
    const deadAccounts = await this._engageRepository.findDeadReplyAccounts();

    return {
      checkedAt: new Date().toISOString(),
      deadReplyAccounts: deadAccounts.map((a) => ({
        id: a.id,
        organizationId: a.organizationId,
        integrationId: a.integrationId,
        projectId: a.projectId,
        integration: {
          id: a.integration.id,
          name: a.integration.name,
          provider: a.integration.providerIdentifier,
          refreshNeeded: a.integration.refreshNeeded,
          disabled: a.integration.disabled,
        },
      })),
      summary: {
        count: deadAccounts.length,
        // Distinct ACCOUNTS, not bindings: one dead integration shared by three
        // projects is one thing to fix, and counting it three times would make
        // the number read as a bigger outage than it is.
        affectedIntegrations: new Set(deadAccounts.map((a) => a.integrationId)).size,
        healthy: deadAccounts.length === 0,
      },
    };
  }

  /**
   * GET /admin/diagnostics/engage-reply-errors
   *
   * Finds EngageSentReply rows whose linked Post has state=ERROR within the
   * last 7 days. These represent replies the user believes were sent (the
   * opportunity shows REPLIED) but that actually failed at the publish layer.
   */
  @Get('/engage-reply-errors')
  async checkEngageReplyErrors() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const replyErrors = await this._engageRepository.findEngageReplyErrors(sevenDaysAgo);

    return {
      checkedAt: new Date().toISOString(),
      replyErrors: replyErrors.map((r) => ({
        id: r.id,
        organizationId: r.organizationId,
        opportunityId: r.opportunityId,
        postId: r.postId,
        createdAt: r.createdAt,
        platform: r.opportunity.platform,
        externalPostUrl: r.opportunity.externalPostUrl,
        postError: r.post.error,
        postCreatedAt: r.post.createdAt,
      })),
      summary: {
        count: replyErrors.length,
        healthy: replyErrors.length === 0,
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
    const [recurring, stuck, integrations, errors, scanCursors, failedScans, deadReplyAccounts, replyErrors, writeLimits] =
      await Promise.all([
        this.checkRecurringPosts(),
        this.checkStuckPosts(),
        this.checkIntegrations(),
        this.checkErrorPosts(),
        this.checkEngageScanCursors(),
        this.checkEngageFailedScans(),
        this.checkEngageDeadReplyAccounts(),
        this.checkEngageReplyErrors(),
        this.checkWriteLimits(),
      ]);

    return {
      checkedAt: new Date().toISOString(),
      healthy:
        recurring.summary.healthy &&
        stuck.summary.healthy &&
        integrations.summary.healthy &&
        errors.summary.healthy &&
        scanCursors.summary.healthy &&
        failedScans.summary.healthy &&
        deadReplyAccounts.summary.healthy &&
        replyErrors.summary.healthy &&
        writeLimits.summary.healthy,
      recurringPosts: recurring.summary,
      stuckPosts: stuck.summary,
      integrations: integrations.summary,
      errorPosts: errors.summary,
      engageScans: {
        stuckCursors: scanCursors.summary.count,
        failedKeywordScans: failedScans.summary.total,
        stuckKeywordScans: failedScans.summary.stuckCount,
        healthy: scanCursors.summary.healthy && failedScans.summary.healthy,
      },
      engageReplies: {
        deadReplyAccounts: deadReplyAccounts.summary.count,
        affectedIntegrations: deadReplyAccounts.summary.affectedIntegrations,
        replyErrors: replyErrors.summary.count,
        healthy: deadReplyAccounts.summary.healthy && replyErrors.summary.healthy,
      },
      writeLimits: writeLimits.summary,
    };
  }
}

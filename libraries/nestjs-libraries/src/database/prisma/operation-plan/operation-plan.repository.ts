import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { OperationPlan, Prisma } from '@prisma/client';

type GeneratedPlatformPost = {
  id: string;
  platform: string;
  content: string;
  // Nullable (not optional) to match the generation schema — OpenAI Structured
  // Outputs requires every field present, with null for "absent".
  media?: { url: string; altText?: string | null }[] | null;
};

type GeneratedContentItem = {
  contentId: string;
  utcDate: string;
  themeKey: string;
  themeTitle: string;
  platforms: GeneratedPlatformPost[];
};

type GeneratedPlanPayload = {
  campaignId?: string;
  contentItems?: GeneratedContentItem[];
};

@Injectable()
export class OperationPlanRepository {
  constructor(
    private _operationPlan: PrismaRepository<'operationPlan'>,
    private _post: PrismaRepository<'post'>,
    private _sentReply: PrismaRepository<'engageSentReply'>,
    private _keyword: PrismaRepository<'engageKeyword'>,
    private _integration?: PrismaRepository<'integration'>
  ) {}

  async getById(id: string, organizationId: string) {
    const plan = await this._operationPlan.model.operationPlan.findFirst({
      where: { id, organizationId },
    });
    if (!plan) {
      throw new NotFoundException('Operation plan not found');
    }
    return plan;
  }

  findByTaskId(organizationId: string, taskId: string) {
    return this._operationPlan.model.operationPlan.findFirst({
      where: { organizationId, taskId },
    });
  }

  findBillingPending(limit = 50) {
    return this._operationPlan.model.operationPlan.findMany({
      where: { status: 'BILLING_PENDING' },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
  }

  // GENERATING rows whose background generation appears stuck — untouched for
  // longer than `olderThanMs` (a crashed/interrupted worker never advanced them
  // past the stub). Mirrors findBillingPending so the generation sweeper can
  // re-drive them idempotently. `updatedAt` is the freshness signal: it is set
  // on the initial persist and bumped again when generation completes.
  findStuckGenerating(olderThanMs: number, limit = 20) {
    const threshold = new Date(Date.now() - olderThanMs);
    return this._operationPlan.model.operationPlan.findMany({
      where: { status: 'GENERATING', updatedAt: { lt: threshold } },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
  }

  create(data: Prisma.OperationPlanUncheckedCreateInput) {
    return this._operationPlan.model.operationPlan.create({ data });
  }

  updateStatus(
    id: string,
    data: {
      status: 'BILLING_PENDING' | 'READY' | 'BILLING_FAILED' | 'FAILED';
      billingTransactionId?: string | null;
      creditAmount?: string | null;
      errorCode?: string | null;
    }
  ) {
    return this._operationPlan.model.operationPlan.update({ where: { id }, data });
  }

  // Write the generated artifacts onto the existing GENERATING stub row and
  // advance it to BILLING_PENDING in one update — the background job persisted a
  // placeholder ({} planPayload/data) up front to return an id immediately, and
  // this fills it in once generation finishes. Distinct from updateStatus, which
  // only touches billing/status columns and never the (large) JSON payloads.
  completeGeneration(
    id: string,
    fields: {
      planPayload: Prisma.InputJsonValue;
      data: Prisma.InputJsonValue;
      status: 'BILLING_PENDING';
    }
  ) {
    return this._operationPlan.model.operationPlan.update({
      where: { id },
      data: {
        planPayload: fields.planPayload,
        data: fields.data,
        status: fields.status,
      },
    });
  }

  async getConnectedPlatforms(organizationId: string): Promise<string[]> {
    if (!this._integration) return [];
    const rows = await this._integration.model.integration.findMany({
      where: { organizationId, disabled: false, deletedAt: null },
      select: { providerIdentifier: true },
    });
    return [...new Set(rows.map((row) => row.providerIdentifier))];
  }

  // The project's currently-active plan, if any (project-scoped-post-engage-
  // design.md §3.4/§6: "today's target" is read from the active — status
  // READY, startsAt <= now <= endsAt — plan; a project with no active plan
  // simply has no daily target"). `now` is caller-supplied (not Date.now())
  // so callers stay testable without mocking the clock.
  getActivePlan(organizationId: string, projectId: string, now: Date) {
    return this._operationPlan.model.operationPlan.findFirst({
      where: {
        organizationId,
        projectId,
        status: 'READY',
        startsAt: { lte: now },
        endsAt: { gte: now },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  getPostsForPlan(operationPlanId: string, organizationId: string) {
    return this._post.model.post.findMany({
      where: { operationPlanId, organizationId, deletedAt: null },
      orderBy: { publishDate: 'asc' },
      select: {
        id: true,
        content: true,
        publishDate: true,
        state: true,
        releaseURL: true,
        group: true,
        settings: true,
        integration: {
          select: {
            id: true,
            providerIdentifier: true,
            name: true,
            picture: true,
          },
        },
      },
    });
  }

  // Sent replies attributed to the plan's project within its date range —
  // the raw material for the per-day/per-platform/per-keyword pacing breakdown.
  // Selects publishDate (day bucket) + matchedKeywords + the opportunity's
  // platform (so pacing splits per platform); the caller buckets in JS (matches
  // this codebase's existing day-bucketing convention, e.g.
  // EngageRepository.getDashboardRepliesTrend — no raw-SQL unnest here).
  getSentRepliesInRange(
    organizationId: string,
    projectId: string,
    startDate: Date,
    endDate: Date
  ) {
    return this._sentReply.model.engageSentReply.findMany({
      where: {
        organizationId,
        projectId,
        post: { publishDate: { gte: startDate, lte: endDate } },
      },
      select: {
        matchedKeywords: true,
        post: { select: { publishDate: true } },
        opportunity: { select: { platform: true } },
      },
    });
  }

  resolveKeywordTexts(keywordIds: string[]) {
    if (!keywordIds.length) {
      return Promise.resolve([]);
    }
    return this._keyword.model.engageKeyword.findMany({
      where: { id: { in: keywordIds } },
      select: { id: true, keyword: true },
    });
  }

  async materializePlanPosts(plan: OperationPlan, planPayload: unknown) {
    const payload = planPayload as GeneratedPlanPayload | null;
    const contentItems = Array.isArray(payload?.contentItems) ? payload!.contentItems : [];
    const platformPosts = contentItems.flatMap((item) =>
      item.platforms.map((post) => ({ item, post }))
    );
    if (!platformPosts.length) {
      return { count: 0 };
    }

    const postIds = [...new Set(platformPosts.map(({ post }) => post.id))];
    const existingPosts = await this._post.model.post.findMany({
      where: { id: { in: postIds } },
      select: { id: true, organizationId: true, operationPlanId: true },
    });
    const existingById = new Map(existingPosts.map((post) => [post.id, post]));
    const conflictingPost = existingPosts.find((post) =>
      post.organizationId !== plan.organizationId || post.operationPlanId !== plan.id
    );
    if (conflictingPost) {
      throw new ConflictException({
        code: 'OPERATION_PLAN_POST_ID_CONFLICT',
        postId: conflictingPost.id,
      });
    }

    const platforms = [...new Set(platformPosts.map(({ post }) => post.platform))];
    const integrations = await this._integration!.model.integration.findMany({
      where: {
        organizationId: plan.organizationId,
        disabled: false,
        deletedAt: null,
        providerIdentifier: { in: platforms },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, providerIdentifier: true },
    });
    const integrationByPlatform = new Map(
      integrations.map((integration) => [integration.providerIdentifier, integration.id])
    );

    const postsToCreate = platformPosts
      .filter(({ post }) => !existingById.has(post.id))
      .map(({ item, post }) => {
        const integrationId = integrationByPlatform.get(post.platform);
        if (!integrationId) {
          throw new ConflictException({
            code: 'OPERATION_PLAN_PLATFORM_NOT_CONNECTED',
            platform: post.platform,
          });
        }
        return {
          id: post.id,
          state: 'DRAFT' as const,
          publishDate: new Date(item.utcDate),
          organizationId: plan.organizationId,
          integrationId,
          content: post.content,
          delay: 0,
          group: `${plan.id}:${item.contentId}`,
          title: item.themeTitle,
          description: null,
          settings: JSON.stringify({
            __type: post.platform,
            campaignId: payload?.campaignId ?? plan.campaignId,
            contentId: item.contentId,
            themeKey: item.themeKey,
          }),
          image: JSON.stringify(post.media ?? []),
          source: 'calendar',
          projectId: plan.projectId,
          operationPlanId: plan.id,
        };
      });

    if (!postsToCreate.length) {
      return { count: 0 };
    }
    return this._post.model.post.createMany({
      data: postsToCreate,
      skipDuplicates: true,
    });
  }
}

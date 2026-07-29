import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { v5 as uuidv5 } from 'uuid';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { OperationPlan, Prisma } from '@prisma/client';
import { postTitleFromTheme } from './theme-title';

// Fixed namespace for deriving a materialized Post.id from a (plan, payload id)
// pair. The generation payload's ids are minted by the LLM, which only guarantees
// uniqueness WITHIN a plan — it routinely re-emits the same UUID across separate
// generations for the same project. Feeding those raw ids straight into Post.id
// let a later plan collide with an earlier plan's row and throw
// OPERATION_PLAN_POST_ID_CONFLICT. Namespacing by plan.id makes the Post.id a pure
// function of (plan.id, rawId): globally unique across plans, yet deterministic so
// re-materializing the SAME plan stays idempotent. Any fixed UUID works as the
// value, but it MUST NEVER CHANGE once in use: the derived id is part of the
// idempotency key, so altering this constant would make every already-materialized
// plan re-materialize under new ids and duplicate its posts.
const OPERATION_PLAN_POST_ID_NAMESPACE = '6f4d2b1e-9c3a-4d7e-8b2f-0a1c3e5d7f90';

// Derive the stable, globally-unique Post.id for a payload id under a given plan.
// Applied uniformly to anchor ids AND thread parentPostId references so the
// self-referential thread chain stays internally consistent.
export function deriveOperationPlanPostId(planId: string, rawId: string): string {
  return uuidv5(`${planId}:${rawId}`, OPERATION_PLAN_POST_ID_NAMESPACE);
}

type GeneratedThreadPart = {
  id: string;
  content: string;
  media?: { url: string; altText?: string | null }[] | null;
};

// Reddit-only publishing header, attached during generation by the reddit target
// resolver (resolveRedditTargets). Present only on platform==='reddit' posts that
// resolved to a valid subreddit; a reddit post WITHOUT it was dropped at
// resolution time and should never reach here. Folded into settings.subreddit so
// the Reddit provider's submit (which reads post.settings.subreddit) can publish.
type ResolvedRedditTarget = {
  subreddit: string;
  title: string;
  type: 'self';
  is_flair_required: false;
};

type GeneratedPlatformPost = {
  id: string;
  platform: string;
  content: string;
  // Nullable (not optional) to match the generation schema — OpenAI Structured
  // Outputs requires every field present, with null for "absent".
  media?: { url: string; altText?: string | null }[] | null;
  // Ordered follow-up posts published as a native reply-chain under `content`.
  // null/empty = a single post. See the generation schema's `thread` field.
  thread?: GeneratedThreadPart[] | null;
  // Resolved Reddit target (subreddit/title/type). See ResolvedRedditTarget.
  redditTarget?: ResolvedRedditTarget | null;
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

  // A task may own multiple plans (one per distinct parameter set), so this
  // returns ALL of them; the service picks the one whose parameters match the
  // request (idempotent reuse) or falls through to create a brand-new plan.
  findManyByTaskId(organizationId: string, taskId: string) {
    return this._operationPlan.model.operationPlan.findMany({
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
        title: true,
        content: true,
        image: true,
        publishDate: true,
        publishMethod: true,
        state: true,
        releaseId: true,
        releaseURL: true,
        group: true,
        settings: true,
        // Thread parts share the anchor's group but carry a parentPostId chain;
        // exposing it lets the overview nest a thread instead of listing its
        // parts as separate top-level posts. null = a standalone/anchor post.
        parentPostId: true,
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
    // Expand every platform post into a chain: the anchor (parentPostId=null)
    // followed by its thread parts, each linked to the PREVIOUS node's id. This
    // mirrors the main editor (createOrUpdatePost) and is exactly what the
    // publisher walks — getPostsRecursively follows childrenPost[0] down the
    // chain, so a star (all parts pointing at the anchor) would drop every part
    // after the first. Ids come from the payload (stable across re-runs), so the
    // createMany stays idempotent. The anchor is emitted before its children, so
    // the self-referencing FK is satisfied within the single INSERT.
    // Namespace every payload id by this plan so the resulting Post.id is globally
    // unique (no cross-plan collision from an LLM-reused UUID) yet deterministic
    // (same plan re-materialize → same ids → idempotent). Applied to BOTH the node
    // id and the parentPostId reference so the thread chain's FK stays consistent.
    const deriveId = (rawId: string) => deriveOperationPlanPostId(plan.id, rawId);
    const materializedPosts = contentItems.flatMap((item) =>
      item.platforms.flatMap((post) => {
        const chain = [
          { id: deriveId(post.id), content: post.content, media: post.media, parentPostId: null as string | null },
          ...(post.thread ?? []).map((part, index, parts) => ({
            id: deriveId(part.id),
            content: part.content,
            media: part.media,
            parentPostId: index === 0 ? deriveId(post.id) : deriveId(parts[index - 1].id),
          })),
        ];
        // The resolved Reddit target rides on every node of the chain (anchor +
        // thread parts share one subreddit) so each materialized Reddit Post row
        // is independently valid against the settings DTO.
        return chain.map((node) => ({
          item,
          platform: post.platform,
          node,
          redditTarget: post.redditTarget ?? null,
        }));
      })
    );
    if (!materializedPosts.length) {
      return { count: 0 };
    }

    const postIds = [...new Set(materializedPosts.map(({ node }) => node.id))];
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

    const platforms = [...new Set(materializedPosts.map(({ platform }) => platform))];
    // The generator only ever targets the canonical `linkedin` slot (see
    // operation-plan.service.ts _validateInput), never `linkedin-page`
    // directly, so also look up `linkedin-page` integrations whenever
    // `linkedin` was requested — that's the fallback resolved below.
    const queryProviderIdentifiers = platforms.includes('linkedin')
      ? [...new Set([...platforms, 'linkedin-page'])]
      : platforms;
    const integrations = await this._integration!.model.integration.findMany({
      where: {
        organizationId: plan.organizationId,
        disabled: false,
        deletedAt: null,
        providerIdentifier: { in: queryProviderIdentifiers },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, providerIdentifier: true },
    });
    const integrationByPlatform = new Map(
      integrations.map((integration) => [integration.providerIdentifier, integration.id])
    );
    // Resolve `linkedin` to whichever integration type this org actually has
    // connected: prefer a personal profile integration (matches the
    // canonical platform value everywhere else — cadence, content limits,
    // prompt), falling back to the company page only when no personal
    // integration exists. An org with neither, or with both, is unaffected
    // beyond this default (both connected → personal wins, same as before
    // this fallback existed).
    const resolvePlatform = (platform: string): string =>
      platform === 'linkedin' &&
      !integrationByPlatform.has('linkedin') &&
      integrationByPlatform.has('linkedin-page')
        ? 'linkedin-page'
        : platform;

    const postsToCreate = materializedPosts
      .filter(({ node }) => !existingById.has(node.id))
      // A Reddit post that reached materialization WITHOUT a resolved target is a
      // resolver contract violation (or a legacy payload generated before this
      // feature). Drop it here rather than persist an unpublishable Reddit draft
      // that would throw at submit on `undefined.subreddit`.
      .filter(({ platform, redditTarget }) => platform !== 'reddit' || !!redditTarget)
      .map(({ item, platform, node, redditTarget }) => {
        // integrationId is optional: publishing is by platform (the plugin reads
        // settings.__type), so a platform without an OAuth integration still gets
        // a DRAFT post with a null integrationId. When an integration exists we
        // attach it, so OAuth-based publishing is unaffected.
        const resolvedPlatform = resolvePlatform(platform);
        const integrationId = integrationByPlatform.get(resolvedPlatform) ?? null;
        return {
          id: node.id,
          // parentPostId chains thread parts to the anchor; null on the anchor.
          parentPostId: node.parentPostId,
          state: 'DRAFT' as const,
          publishDate: new Date(item.utcDate),
          organizationId: plan.organizationId,
          integrationId,
          content: node.content,
          delay: 0,
          // group must be per-platform: a single contentItem fans out into
          // multiple platforms (item.platforms), and getPostsByGroup filters by
          // `group` alone (no platform/integration predicate) while reading the
          // integration/settings header from posts[0]. A group shared across
          // platforms therefore mixes e.g. an X anchor with Reddit thread parts.
          // Scoping the group by platform restores the vanilla invariant "one
          // group = one channel's post + its thread chain". Still deterministic
          // (plan.id + contentId + platform), so re-materialize stays idempotent.
          group: `${plan.id}:${item.contentId}:${resolvedPlatform}`,
          // Boundary guard: strip any week label the model leaked into themeTitle
          // so the published post title (Reddit/Hashnode/blog channels submit this
          // verbatim) stays clean even though the prompt asks for a clean title.
          title: postTitleFromTheme(item.themeTitle),
          description: null,
          settings: JSON.stringify({
            // __type mirrors the RESOLVED platform (matches the rest of the
            // codebase: __type is always set from the bound integration's
            // providerIdentifier, e.g. posts.service.ts / autopost.service.ts),
            // so a 'linkedin' plan post that resolved to a linkedin-page
            // integration is tagged consistently for any code that reads
            // settings.__type directly (e.g. getSocialTaskQueue) instead of
            // going through post.integration.
            __type: resolvedPlatform,
            campaignId: payload?.campaignId ?? plan.campaignId,
            contentId: item.contentId,
            themeKey: item.themeKey,
            // Reddit needs a real publishing header: the submit call reads
            // settings.subreddit[].value.{subreddit,title,type}. Shaped to
            // RedditSettingsDto (a one-element array; url/flair omitted — only
            // validated for type='link'/is_flair_required, both false here).
            ...(platform === 'reddit' && redditTarget
              ? {
                  subreddit: [
                    {
                      value: {
                        subreddit: redditTarget.subreddit,
                        title: redditTarget.title,
                        type: redditTarget.type,
                        is_flair_required: redditTarget.is_flair_required,
                      },
                    },
                  ],
                }
              : {}),
          }),
          image: JSON.stringify(node.media ?? []),
          source: 'calendar',
          projectId: plan.projectId,
          operationPlanId: plan.id,
        };
      });

    const result = postsToCreate.length
      ? await this._post.model.post.createMany({
          data: postsToCreate,
          skipDuplicates: true,
        })
      : { count: 0 };

    // Single-active-plan semantics: the latest materialized plan supersedes every
    // earlier plan for this project. Soft-delete the prior plans' DRAFT posts so
    // they leave the calendar (every read path filters deletedAt: null) and can no
    // longer be published.
    //   - Guard on planHasPosts: only supersede when THIS plan actually owns posts
    //     — either just created (postsToCreate) or already present from an
    //     idempotent re-materialize (existingById). A degenerate plan that resolved
    //     to zero posts (e.g. every reddit item dropped) must not wipe the previous
    //     valid plan and leave the project with an empty calendar.
    //   - state DRAFT only: a post the user already scheduled (QUEUE) or that
    //     already published/errored is committed work and must survive.
    //   - operationPlanId IS NOT NULL: hand-authored drafts (no plan) are never a
    //     stale plan and must be left untouched.
    //   - NOT operationPlanId = plan.id: protect this plan's own rows.
    const planHasPosts = postsToCreate.length > 0 || existingById.size > 0;
    if (planHasPosts) {
      await this._post.model.post.updateMany({
        where: {
          organizationId: plan.organizationId,
          projectId: plan.projectId,
          state: 'DRAFT',
          deletedAt: null,
          operationPlanId: { not: null },
          NOT: { operationPlanId: plan.id },
        },
        data: { deletedAt: new Date(), parentPostId: null },
      });
    }

    return result;
  }
}

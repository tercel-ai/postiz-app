import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Post as PostBody } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';
import { APPROVED_SUBMIT_FOR_ORDER, Post, State } from '@prisma/client';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';
import { PostSource } from '@gitroom/nestjs-libraries/dtos/posts/post-source';
import { GetPostsListDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts-list.dto';
import { LocatePostInListDto } from '@gitroom/nestjs-libraries/dtos/posts/locate.post-in-list.dto';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import weekOfYear from 'dayjs/plugin/weekOfYear';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { v4 as uuidv4 } from 'uuid';
import { parseDate } from '@gitroom/helpers/utils/date.utils';
import { CreateTagDto } from '@gitroom/nestjs-libraries/dtos/posts/create.tag.dto';

dayjs.extend(isoWeek);
dayjs.extend(weekOfYear);
dayjs.extend(isSameOrAfter);
dayjs.extend(isSameOrBefore);
dayjs.extend(utc);
dayjs.extend(timezone);

function displayToUnit(display: 'day' | 'week' | 'month'): 'day' | 'isoWeek' | 'month' {
  if (display === 'day') return 'day';
  if (display === 'week') return 'isoWeek';
  return 'month';
}

/**
 * Flatten a stored `Post.analytics` value (an AnalyticsData[] of
 * `{ label, data: [{ total, date }] }`) into a plain `{ label: number }` map,
 * taking each metric's latest `total`. Returns null when there is no analytics
 * payload. Used by the admin list to expose metrics as key/value pairs without
 * making callers walk the nested array. Example outputs:
 *   Reddit → { score: 1, comments: 0 }
 *   X      → { Impressions: 100, Likes: 2, Retweets: 0, Replies: 1, ... }
 */
function flattenAnalytics(analytics: unknown): Record<string, number> | null {
  if (!Array.isArray(analytics)) return null;
  const out: Record<string, number> = {};
  for (const entry of analytics as Array<{
    label?: unknown;
    data?: Array<{ total?: string | number }>;
  }>) {
    if (!entry || typeof entry.label !== 'string') continue;
    const data = Array.isArray(entry.data) ? entry.data : [];
    const last = data[data.length - 1];
    const n = Number(last?.total);
    out[entry.label] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

@Injectable()
export class PostsRepository {
  constructor(
    private _post: PrismaRepository<'post'>,
    private _popularPosts: PrismaRepository<'popularPosts'>,
    private _comments: PrismaRepository<'comments'>,
    private _tags: PrismaRepository<'tags'>,
    private _tagsPosts: PrismaRepository<'tagsPosts'>,
    private _errors: PrismaRepository<'errors'>
  ) { }

  searchForMissingThreeHoursPosts() {
    return this._post.model.post.findMany({
      where: {
        integration: {
          refreshNeeded: false,
          inBetweenSteps: false,
          disabled: false,
        },
        OR: [
          // Normal case: posts due within ±2 hours
          {
            publishDate: {
              gte: dayjs.utc().subtract(2, 'hour').toDate(),
              lt: dayjs.utc().add(2, 'hour').toDate(),
            },
          },
          // Recurring posts stuck in the past (initial workflow failed or
          // server restarted).  These need to be picked up so their
          // publishDate can be advanced and the next cycle scheduled.
          {
            intervalInDays: { not: null },
            sourcePostId: null,
            publishDate: {
              lt: dayjs.utc().subtract(2, 'hour').toDate(),
            },
          },
          // Non-recurring posts stuck in the past (orchestrator was down >2h).
          // Recovery window: up to 7 days back.  Posts older than that are
          // swept to ERROR by markStaleQueuePostsAsError.
          {
            intervalInDays: null,
            sourcePostId: null,
            publishDate: {
              gte: dayjs.utc().subtract(7, 'day').toDate(),
              lt: dayjs.utc().subtract(2, 'hour').toDate(),
            },
          },
        ],
        state: 'QUEUE',
        deletedAt: null,
        parentPostId: null,
      },
      select: {
        id: true,
        organizationId: true,
        integration: {
          select: {
            providerIdentifier: true,
          },
        },
        publishDate: true,
      },
    });
  }

  getOldPosts(orgId: string, date: string) {
    return this._post.model.post.findMany({
      where: {
        integration: {
          refreshNeeded: false,
          inBetweenSteps: false,
          disabled: false,
        },
        organizationId: orgId,
        publishDate: {
          lte: dayjs(date).toDate(),
        },
        deletedAt: null,
        parentPostId: null,
      },
      orderBy: {
        publishDate: 'desc',
      },
      select: {
        id: true,
        content: true,
        publishDate: true,
        releaseURL: true,
        state: true,
        integration: {
          select: {
            id: true,
            name: true,
            providerIdentifier: true,
            picture: true,
            type: true,
          },
        },
      },
    });
  }

  async getPostByIdForAdmin(id: string) {
    const post = await this._post.model.post.findUnique({
      where: { id, deletedAt: null },
      select: {
        id: true,
        content: true,
        image: true,
        publishDate: true,
        createdAt: true,
        updatedAt: true,
        releaseURL: true,
        releaseId: true,
        state: true,
        error: true,
        group: true,
        delay: true,
        intervalInDays: true,
        organizationId: true,
        source: true,
        impressions: true,
        trafficScore: true,
        analytics: true,
        tags: { select: { tag: true } },
        integration: {
          select: {
            id: true,
            providerIdentifier: true,
            name: true,
            picture: true,
          },
        },
        organization: {
          select: { id: true, name: true },
        },
        childrenPost: {
          where: { deletedAt: null },
          select: {
            id: true,
            content: true,
            image: true,
            delay: true,
          },
        },
      },
    });
    if (!post) return post;
    // Same flattening as the admin list: expose metrics as a { label: value }
    // map alongside the raw `analytics` array. See flattenAnalytics.
    return { ...post, metrics: flattenAnalytics(post.analytics) };
  }

  async getAllPostsList(query: GetPostsListDto & { organizationId?: string | string[] }) {
    const skip = (query.page - 1) * query.pageSize;
    const where = {
      deletedAt: null,
      parentPostId: null,
      ...(query.organizationId
        ? { organizationId: Array.isArray(query.organizationId) ? { in: query.organizationId } : query.organizationId }
        : {}),
      ...(query.state
        ? {
            OR: [
              { state: query.state, intervalInDays: null },
              { intervalInDays: { not: null } },
            ],
          }
        : {}),
      ...(query.integrationId?.length
        ? { integrationId: { in: query.integrationId } }
        : {}),
      ...(query.channel?.length
        ? { integration: { providerIdentifier: { in: query.channel } } }
        : {}),
      ...(query.source?.length ? { source: { in: query.source } } : {}),
    };

    const [results, total] = await Promise.all([
      this._post.model.post.findMany({
        where,
        orderBy: { [query.sortBy]: query.sortOrder },
        select: {
          id: true,
          content: true,
          image: true,
          publishDate: true,
          createdAt: true,
          releaseURL: true,
          state: true,
          group: true,
          organizationId: true,
          source: true,
          impressions: true,
          trafficScore: true,
          analytics: true,
          tags: {
            select: { tag: true },
          },
          integration: {
            select: {
              id: true,
              providerIdentifier: true,
              name: true,
              picture: true,
            },
          },
          organization: {
            select: {
              id: true,
              name: true,
              users: {
                where: { role: { in: ['SUPERADMIN', 'ADMIN'] }, disabled: false },
                orderBy: { role: 'asc' },
                take: 1,
                select: { userId: true },
              },
            },
          },
        },
        skip,
        take: query.pageSize,
      }),
      this._post.model.post.count({ where }),
    ]);

    return {
      results: results.map(({ organization, ...item }) => ({
        ...item,
        // `item.analytics` is the raw stored AnalyticsData[]; `metrics` is the
        // same data flattened into a { label: value } map so callers get plain
        // key/value pairs (Reddit { score: 1, comments: 0 }, X { Impressions:
        // 100, Likes: 2, ... }) without walking the nested array.
        metrics: flattenAnalytics(item.analytics),
        organization: {
          id: organization.id,
          name: organization.name,
        },
        userId: organization.users[0]?.userId ?? null,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async getPostsList(orgId: string, query: GetPostsListDto) {
    const skip = (query.page - 1) * query.pageSize;
    const where = {
      organizationId: orgId,
      deletedAt: null,
      parentPostId: null,
      ...(query.view === 'templates' ? { sourcePostId: null } : {}),
      ...(query.sourcePostId ? { sourcePostId: query.sourcePostId } : {}),
      // IMPORTANT — keep this as a plain `{ state: query.state }`.
      //
      // Unlike `getPosts` (calendar) above, this endpoint:
      //   1. has no date-range / virtual-occurrence expansion, and
      //   2. returns Prisma rows DIRECTLY to the client with NO post-filter.
      //
      // The calendar version uses an `OR` that intentionally pulls every
      // recurring template regardless of state, because two later in-memory
      // filters (line ~452 and line ~489 in getPosts) re-apply the state
      // constraint after expansion. This endpoint has neither of those, so
      // the same OR would leak QUEUE/DRAFT recurring templates into results
      // filtered by `state=ERROR` — that bug existed between commit 95aa1dc8
      // (2026-04-03) and its fix; do not reintroduce it by "aligning" this
      // clause with the calendar one. See the long comment in getPosts above
      // for the full rationale.
      ...(query.state ? { state: query.state } : {}),
      ...(query.source?.length ? { source: { in: query.source } } : {}),
      ...(query.integrationId?.length
        ? { integrationId: { in: query.integrationId } }
        : {}),
      ...(query.channel?.length
        ? { integration: { providerIdentifier: { in: query.channel } } }
        : {}),
      // Opaque aisee-core products.id. Omitting it returns every post the
      // caller can already see (legacy, non-project behavior preserved
      // during migration — project-scoped-post-engage-design.md §8/§11).
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.operationPlanId ? { operationPlanId: query.operationPlanId } : {}),
    };

    const [results, total] = await Promise.all([
      this._post.model.post.findMany({
        where,
        orderBy: [
          { [query.sortBy]: query.sortOrder },
          // Stable tiebreaker so `locatePostInList` can reproduce the exact
          // page index for posts sharing the same `sortBy` value.
          { id: query.sortOrder },
        ],
        select: {
          id: true,
          content: true,
          image: true,
          publishDate: true,
          createdAt: true,
          releaseURL: true,
          intervalInDays: true,
          state: true,
          group: true,
          error: true,
          sourcePostId: true,
          impressions: true,
          trafficScore: true,
          lastMetricsFetchAt: true,
          analytics: true,
          tags: {
            select: {
              tag: true,
            },
          },
          integration: {
            select: {
              id: true,
              providerIdentifier: true,
              name: true,
              picture: true,
            },
          },
        },
        skip,
        take: query.pageSize,
      }),
      this._post.model.post.count({ where }),
    ]);

    return {
      results,
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async locatePostInList(orgId: string, query: LocatePostInListDto) {
    // Mirror the `where` from `getPostsList` exactly so the position we
    // compute matches the index the post occupies in `/posts/list`.
    const where = {
      organizationId: orgId,
      deletedAt: null,
      parentPostId: null,
      ...(query.view === 'templates' ? { sourcePostId: null } : {}),
      ...(query.sourcePostId ? { sourcePostId: query.sourcePostId } : {}),
      ...(query.state ? { state: query.state } : {}),
      ...(query.source?.length ? { source: { in: query.source } } : {}),
      ...(query.integrationId?.length
        ? { integrationId: { in: query.integrationId } }
        : {}),
      ...(query.channel?.length
        ? { integration: { providerIdentifier: { in: query.channel } } }
        : {}),
      // Must mirror getPostsList's projectId/operationPlanId clauses exactly
      // — see the "Mirror the where from getPostsList" note above.
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.operationPlanId ? { operationPlanId: query.operationPlanId } : {}),
    };

    const sortBy = query.sortBy!;
    const sortOrder = query.sortOrder!;
    const pageSize = query.pageSize!;

    const post = await this._post.model.post.findFirst({
      where: { ...where, id: query.postId },
      select: {
        id: true,
        publishDate: true,
        createdAt: true,
        updatedAt: true,
        state: true,
      },
    });

    if (!post) {
      // Either the post does not exist, does not belong to the org, or it
      // is excluded by the same filters that `/posts/list` would apply.
      const total = await this._post.model.post.count({ where });
      return {
        found: false as const,
        page: null as number | null,
        position: null as number | null,
        total,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      };
    }

    const sortValue = (post as Record<string, unknown>)[sortBy];
    // For desc, "before" the target means strictly greater; for asc, less.
    // Tiebreaker on equal sort values follows the same id ordering applied
    // in `getPostsList`.
    const cmp = sortOrder === 'desc' ? 'gt' : 'lt';

    const [precedingByValue, precedingByTie, total] = await Promise.all([
      this._post.model.post.count({
        where: { ...where, [sortBy]: { [cmp]: sortValue } },
      }),
      this._post.model.post.count({
        where: {
          ...where,
          [sortBy]: { equals: sortValue },
          id: { [cmp]: post.id },
        },
      }),
      this._post.model.post.count({ where }),
    ]);

    const position = precedingByValue + precedingByTie + 1;
    const page = Math.ceil(position / pageSize);

    return {
      found: true as const,
      page,
      position,
      total,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  updateImages(id: string, images: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        image: images,
      },
    });
  }

  getPostUrls(orgId: string, ids: string[]) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        id: {
          in: ids,
        },
      },
      select: {
        id: true,
        releaseURL: true,
      },
    });
  }

  async getPosts(orgId: string, query: GetPostsDto, tz?: string) {
    let startDate = parseDate(query.startDate, tz).toDate();
    let endDate = parseDate(query.endDate, tz).toDate();

    if (tz && query.display) {
      const unit = displayToUnit(query.display);
      startDate = parseDate(query.startDate, tz).startOf(unit).toDate();
      endDate = parseDate(query.endDate, tz).endOf(unit).toDate();
    }

    const list = await this._post.model.post.findMany({
      where: {
        AND: [
          {
            OR: [
              {
                organizationId: orgId,
              },
              {
                submittedForOrganizationId: orgId,
              },
            ],
          },
          {
            OR: [
              {
                publishDate: {
                  gte: startDate,
                  lte: endDate,
                },
              },
              {
                intervalInDays: {
                  not: null,
                },
              },
            ],
          },
        ],
        deletedAt: null,
        parentPostId: null,
        // Removed sourcePostId: null to allow clones to be fetched.
        //
        // IMPORTANT — recurring template state filter:
        // Recurring template originals always stay in QUEUE state (clones carry
        // the real lifecycle state, see posts.service.ts notes on
        // `intervalInDays=null` for clones). The OR below intentionally pulls
        // ALL templates regardless of `query.state`, because the calendar
        // post-processing below needs them to (a) anchor cycle clones via
        // `originals.find(...)` at line ~468 and (b) expand `virtualEntries`
        // for future occurrences at line ~487.
        //
        // The leak that this would otherwise cause (templates surviving a
        // `state=ERROR` filter) is closed by TWO post-filters further down:
        //   - line ~452: `if (query.state && p.state !== query.state) return false;`
        //   - line ~489: `if (query.state && query.state !== 'QUEUE') continue;`
        // Both must stay in sync with this OR — do not relax them.
        //
        // DO NOT copy this OR pattern into endpoints that return rows directly
        // without those post-filters. The sibling `getPostsList` below uses a
        // plain `{ state: query.state }` for exactly that reason — see the
        // comment there. Mirroring this OR into a list-style endpoint reopens
        // the bug fixed in this file's history (QUEUE/DRAFT recurring rows
        // leaking into `state=ERROR` results).
        ...(query.state
          ? {
              OR: [
                { state: query.state, intervalInDays: null },
                { intervalInDays: { not: null } },
              ],
            }
          : {}),
        ...(query.source?.length ? { source: { in: query.source } } : {}),
        ...(query.integrationId?.length
          ? { integrationId: { in: query.integrationId } }
          : {}),
        ...((query.channel?.length || query.customer)
          ? {
            integration: {
              ...(query.channel?.length ? { providerIdentifier: { in: query.channel } } : {}),
              ...(query.customer ? { customerId: query.customer } : {}),
            },
          }
          : {}),
        // Opaque aisee-core products.id. Omitting it returns every post in
        // the org (legacy, non-project calendar behavior preserved during
        // migration — project-scoped-post-engage-design.md §8/§11).
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.operationPlanId ? { operationPlanId: query.operationPlanId } : {}),
      },
      select: {
        id: true,
        title: true,
        content: true,
        image: true,
        publishDate: true,
        createdAt: true,
        releaseURL: true,
        releaseId: true,
        state: true,
        intervalInDays: true,
        group: true,
        integrationId: true,
        sourcePostId: true,
        tags: {
          select: {
            tag: true,
          },
        },
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

    const now = dayjs.utc();
    const start = dayjs.utc(startDate);
    const end = dayjs.utc(endDate);

    const allIds = new Set(list.map((p) => p.id));
    const originals = list.filter((p) => p.intervalInDays);
    const realPosts = list
      .filter((p) => {
        const pDate = dayjs.utc(p.publishDate);
        const inRange = pDate.isSameOrAfter(start) && pDate.isSameOrBefore(end);
        if (!inRange) return false;

        // Filter by state if requested
        if (query.state && p.state !== query.state) {
          return false;
        }

        // If it's a release clone (sourcePostId is set), only show it if the original isn't already in the list
        // This prevents duplicates for non-recurring posts that might have snapshots.
        if (p.sourcePostId && allIds.has(p.sourcePostId)) {
          return false;
        }

        return true;
      })
      .map((p) => {
        if (p.intervalInDays) return p;

        // Link clones (Cycle Clones have sourcePostId: null, Release Clones have it set)
        const original = originals.find(
          (o) =>
            (p.sourcePostId && o.id === p.sourcePostId) ||
            (o.group === p.group && o.integrationId === p.integrationId)
        );

        return original ? { ...p, actualDate: original.publishDate } : p;
      });

    const realPostsSlots = new Set(
      realPosts.map(
        (p) =>
          `${p.group}:${p.integrationId}:${dayjs
            .utc(p.publishDate)
            .format('YYYY-MM-DD')}`
      )
    );

    const virtualEntries = [];
    for (const post of originals) {
      if (post.state === 'DRAFT') continue;
      if (query.state && query.state !== 'QUEUE') continue;

      let startingDate = tz
        ? dayjs.tz(post.publishDate, tz)
        : dayjs.utc(post.publishDate);

      // Fast-forward startingDate to the first occurrence that could be within or after the range
      if (startingDate.isBefore(start)) {
        const daysToWait = start.diff(startingDate, 'days');
        const occurrencesToSkip = Math.floor(daysToWait / post.intervalInDays);
        if (occurrencesToSkip > 0) {
          startingDate = startingDate.add(
            occurrencesToSkip * post.intervalInDays,
            'days'
          );
        }
        while (startingDate.isBefore(start)) {
          startingDate = startingDate.add(post.intervalInDays, 'days');
        }
      }

      while (end.isSameOrAfter(startingDate)) {
        if (startingDate.isSameOrAfter(start) && startingDate.isAfter(now)) {
          // Check if we already have a real post for this group, account and day
          const slotKey = `${post.group}:${
            post.integrationId
          }:${startingDate.format('YYYY-MM-DD')}`;
          if (!realPostsSlots.has(slotKey)) {
            virtualEntries.push({
              ...post,
              publishDate: startingDate.toDate(),
              actualDate: post.publishDate,
              state: 'QUEUE' as const,
            });
          }
        }
        startingDate = startingDate.add(post.intervalInDays, 'days');
      }
    }

    return [...realPosts, ...virtualEntries];

  }

  /**
   * Soft-delete QUEUE/DRAFT posts in a group, optionally excluding specific IDs.
   * PUBLISHED and ERROR posts are never touched — they are immutable history.
   * All group-level deletions (explicit delete, edit cleanup) must go through here.
   */
  async softDeleteGroupPosts(
    group: string,
    opts: { organizationId?: string; excludeIds?: string[] } = {}
  ) {
    return this._post.model.post.updateMany({
      where: {
        group,
        deletedAt: null,
        state: { in: ['QUEUE', 'DRAFT'] },
        ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
        ...(opts.excludeIds?.length ? { id: { notIn: opts.excludeIds } } : {}),
      },
      data: { parentPostId: null, deletedAt: new Date() },
    });
  }

  async deletePost(orgId: string, group: string) {
    // For recurring posts: preserve PUBLISHED/ERROR clones (publish history).
    // For non-recurring posts: delete everything including PUBLISHED — the user
    // wants the post gone, there are no separate clone rows to preserve.
    const hasRecurring = await this._post.model.post.findFirst({
      where: { organizationId: orgId, group, intervalInDays: { not: null }, deletedAt: null },
      select: { id: true },
    });

    if (hasRecurring) {
      await this.softDeleteGroupPosts(group, { organizationId: orgId });
    } else {
      await this._post.model.post.updateMany({
        where: { organizationId: orgId, group, deletedAt: null },
        data: { parentPostId: null, deletedAt: new Date() },
      });
    }

    return this._post.model.post.findFirst({
      where: {
        organizationId: orgId,
        group,
        parentPostId: null,
        deletedAt: null,
      },
      select: {
        id: true,
      },
    });
  }

  getPostsByGroup(orgId: string, group: string) {
    return this._post.model.post.findMany({
      where: {
        group,
        ...(orgId ? { organizationId: orgId } : {}),
        deletedAt: null,
      },
      include: {
        integration: true,
        tags: {
          select: {
            tag: true,
          },
        },
      },
    });
  }

  getPost(
    id: string,
    includeIntegration = false,
    orgId?: string,
    isFirst?: boolean,
    projectId?: string
  ) {
    return this._post.model.post.findUnique({
      where: {
        id,
        ...(orgId ? { organizationId: orgId } : {}),
        // Same authorization posture as organizationId above (§8: "404 or
        // the established authorization-safe response for records
        // belonging to another project").
        ...(projectId ? { projectId } : {}),
        deletedAt: null,
      },
      include: {
        ...(includeIntegration
          ? {
            integration: true,
            tags: {
              select: {
                tag: true,
              },
            },
          }
          : {}),
        childrenPost: true,
      },
    });
  }

  updatePost(id: string, postId: string, releaseURL: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        state: 'PUBLISHED',
        releaseURL,
        releaseId: postId,
        error: null,
      },
    });
  }

  /**
   * Idempotent: find or create a QUEUE clone for a recurring post cycle.
   * Uses (group, publishDate) to detect existing clones — no sourcePostId
   * so the clone is always a standalone post visible in calendar and list.
   *
   * Returns { clone, alreadyHandled }:
   *  - alreadyHandled=true  → clone is PUBLISHED or ERROR, skip this cycle
   *  - alreadyHandled=false → clone is QUEUE, proceed to publish
   */
  async findOrCreateCycleClone(
    originalPost: any,
    cyclePublishDate: Date,
    claimToken: string
  ): Promise<{ clone: any; alreadyHandled: boolean }> {
    const existing = await this._post.model.post.findFirst({
      where: {
        group: originalPost.group,
        publishDate: cyclePublishDate,
        id: { not: originalPost.id },
      },
      select: { id: true, state: true, releaseId: true },
    });

    if (existing) {
      if (existing.state === 'PUBLISHED' || existing.state === 'ERROR') {
        return { clone: existing, alreadyHandled: true };
      }

      // Clone is QUEUE — try to atomically claim it by setting releaseId.
      // Only succeeds if releaseId is still null (no other workflow claimed it).
      const claimed = await this._post.model.post.updateMany({
        where: {
          id: existing.id,
          state: 'QUEUE',
          releaseId: null,
        },
        data: {
          releaseId: claimToken,
        },
      });

      if (claimed.count === 0) {
        // Another workflow already claimed this QUEUE clone
        return { clone: existing, alreadyHandled: true };
      }

      return { clone: existing, alreadyHandled: false };
    }

    const clone = await this._post.model.post.create({
      data: {
        content: originalPost.content,
        title: originalPost.title,
        description: originalPost.description,
        image: originalPost.image,
        settings: originalPost.settings,
        group: originalPost.group,
        delay: originalPost.delay,
        organizationId: originalPost.organizationId,
        integrationId: originalPost.integrationId,
        // A recurring post's future cycles stay attributed to the same
        // project/plan as the template they were cloned from.
        projectId: originalPost.projectId,
        operationPlanId: originalPost.operationPlanId,
        publishDate: cyclePublishDate,
        state: 'QUEUE',
        releaseId: claimToken,
      },
    });

    // Guard against concurrent creates: if another workflow also created a
    // clone for the same (group, publishDate) between our findFirst and
    // create, multiple clones exist.  The earliest createdAt wins.
    const allClones = await this._post.model.post.findMany({
      where: {
        group: originalPost.group,
        publishDate: cyclePublishDate,
        id: { not: originalPost.id },
      },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    if (allClones.length > 1 && allClones[0].id !== clone.id) {
      // We lost the race — delete our clone and report as already handled
      await this._post.model.post.delete({ where: { id: clone.id } });
      return { clone: allClones[0], alreadyHandled: true };
    }

    return { clone, alreadyHandled: false };
  }

  /**
   * Finalize a cycle clone after publish attempt.
   */
  async finalizeCycleClone(
    cloneId: string,
    data: {
      state: 'PUBLISHED' | 'ERROR';
      releaseId?: string;
      releaseURL?: string;
      error?: string;
    }
  ) {
    return this._post.model.post.update({
      where: { id: cloneId },
      data: {
        state: data.state,
        releaseId: data.releaseId || null,
        releaseURL: data.releaseURL || null,
        error: data.error || null,
      },
    });
  }

  async clonePostAsRelease(
    originalPost: any,
    data: {
      releaseId: string;
      releaseURL?: string;
      state: 'PUBLISHED' | 'ERROR';
      error?: string;
    }
  ) {
    // Check if a clone already exists for this (sourcePostId, releaseId) pair
    // to prevent duplicates from retry loops.
    const existing = await this._post.model.post.findFirst({
      where: {
        sourcePostId: originalPost.id,
        releaseId: data.releaseId,
      },
      select: { id: true },
    });

    if (existing) {
      // Update existing clone instead of creating duplicate
      return this._post.model.post.update({
        where: { id: existing.id },
        data: {
          state: data.state,
          releaseURL: data.releaseURL || null,
          error: data.error || null,
        },
      });
    }

    return this._post.model.post.create({
      data: {
        content: originalPost.content,
        title: originalPost.title,
        description: originalPost.description,
        image: originalPost.image,
        settings: originalPost.settings,
        group: originalPost.group,
        delay: originalPost.delay,
        organizationId: originalPost.organizationId,
        integrationId: originalPost.integrationId,
        // A release clone stays attributed to the same project/plan as the
        // post it was cloned from.
        projectId: originalPost.projectId,
        operationPlanId: originalPost.operationPlanId,
        publishDate: originalPost.publishDate,
        state: data.state,
        releaseId: data.releaseId,
        releaseURL: data.releaseURL || null,
        error: data.error || null,
        sourcePostId: originalPost.id,
      },
    });
  }

  /**
   * Reset the claim lock on a QUEUE post whose workflow was terminated.
   * Only resets if the post is still in QUEUE — a PUBLISHED post must not be touched.
   * The releaseId is a claim token (starts with 'claim_'), not a platform post ID.
   */
  async resetClaimForPost(id: string): Promise<void> {
    await this._post.model.post.updateMany({
      where: {
        id,
        state: 'QUEUE',
        releaseId: { not: null },
      },
      data: {
        releaseId: null,
      },
    });
  }

  /**
   * Mark non-recurring QUEUE posts whose publishDate is over 7 days old as ERROR.
   * These fell outside the recovery window and will never be published.
   * Excludes recurring originals (intervalInDays set) and thread children (parentPostId set).
   */
  async markStaleQueuePostsAsError(): Promise<number> {
    const cutoff = dayjs.utc().subtract(7, 'day').toDate();
    const result = await this._post.model.post.updateMany({
      where: {
        state: 'QUEUE',
        deletedAt: null,
        parentPostId: null,
        intervalInDays: null,
        publishDate: {
          lt: cutoff,
        },
      },
      data: {
        state: 'ERROR',
        error: 'Post was never published — it fell outside the recovery window. Please reschedule.',
        releaseId: null,
      },
    });
    return result.count;
  }

  /**
   * Atomically claim a non-recurring QUEUE post for publishing.
   * Sets releaseId to the given claimToken only if it is currently null and state is QUEUE.
   * Returns true if this caller won the claim; false if another workflow already claimed it.
   */
  async claimPostForPublishing(id: string, claimToken: string): Promise<boolean> {
    const result = await this._post.model.post.updateMany({
      where: {
        id,
        state: 'QUEUE',
        releaseId: null,
      },
      data: {
        releaseId: claimToken,
      },
    });
    return result.count > 0;
  }

  /**
   * Advance publishDate using optimistic locking.
   * Only succeeds if publishDate still equals currentPublishDate (i.e. no
   * other workflow has already advanced it).  Returns true on success.
   */
  async advancePublishDate(id: string, currentPublishDate: Date, intervalInDays: number): Promise<boolean> {
    // Calculate the next publish date.  If currentPublishDate + interval is
    // still in the past (e.g. the post was stuck), keep advancing until we
    // land in the future.  This prevents a burst of rapid catch-up publishes.
    const now = dayjs.utc();
    let next = dayjs.utc(currentPublishDate).add(intervalInDays, 'days');
    while (next.isBefore(now)) {
      next = next.add(intervalInDays, 'days');
    }

    const result = await this._post.model.post.updateMany({
      where: {
        id,
        publishDate: currentPublishDate,
      },
      data: {
        publishDate: next.toDate(),
      },
    });
    return result.count > 0;
  }

  /**
   * Find all recurring main posts (intervalInDays > 0, not a clone).
   */
  findRecurringPosts() {
    return this._post.model.post.findMany({
      where: {
        intervalInDays: { not: null },
        sourcePostId: null,
        parentPostId: null,
        deletedAt: null,
      },
      select: {
        id: true,
        group: true,
        publishDate: true,
        intervalInDays: true,
        state: true,
        createdAt: true,
        integration: {
          select: {
            id: true,
            providerIdentifier: true,
            name: true,
          },
        },
      },
    });
  }

  /**
   * Find all clone posts for given recurring post groups.
   */
  findClonesByGroups(groups: string[], excludeIds: string[]) {
    return this._post.model.post.findMany({
      where: {
        group: { in: groups },
        id: { notIn: excludeIds },
        deletedAt: null,
        parentPostId: null,
      },
      select: {
        id: true,
        group: true,
        publishDate: true,
        createdAt: true,
        state: true,
        releaseURL: true,
        releaseId: true,
        error: true,
      },
      orderBy: { publishDate: 'asc' },
    });
  }

  /**
   * Find non-recurring QUEUE posts whose publishDate has passed.
   */
  findStuckQueuePosts(before: Date) {
    return this._post.model.post.findMany({
      where: {
        state: 'QUEUE',
        publishDate: { lt: before },
        deletedAt: null,
        parentPostId: null,
        sourcePostId: null,
        intervalInDays: null,
      },
      select: {
        id: true,
        publishDate: true,
        createdAt: true,
        intervalInDays: true,
        organizationId: true,
        integration: {
          select: {
            id: true,
            providerIdentifier: true,
            name: true,
          },
        },
      },
      orderBy: { publishDate: 'asc' },
    });
  }

  /**
   * Count QUEUE posts grouped by integration ID.
   */
  countQueuePostsByIntegrations(integrationIds: string[]) {
    return this._post.model.post.groupBy({
      by: ['integrationId'],
      where: {
        integrationId: { in: integrationIds },
        state: 'QUEUE',
        deletedAt: null,
        parentPostId: null,
      },
      _count: true,
    });
  }

  /**
   * Find recent posts with ERROR state.
   */
  findRecentErrorPosts(since: Date) {
    return this._post.model.post.findMany({
      where: {
        state: 'ERROR',
        createdAt: { gte: since },
        deletedAt: null,
      },
      select: {
        id: true,
        publishDate: true,
        createdAt: true,
        error: true,
        sourcePostId: true,
        organizationId: true,
        integration: {
          select: {
            id: true,
            providerIdentifier: true,
            name: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  batchUpdatePostAnalytics(
    updates: Array<{
      id: string;
      impressions?: number;
      trafficScore?: number;
      analytics?: any;
    }>
  ) {
    if (!updates.length) return Promise.resolve([]);
    return Promise.all(
      updates.map((u) =>
        this._post.model.post.update({
          where: { id: u.id },
          data: {
            impressions: u.impressions,
            trafficScore: u.trafficScore,
            analytics: u.analytics,
          },
        })
      )
    );
  }

  // Single-field cap so the message column doesn't grow unbounded. Big enough
  // to comfortably hold a multi-level Temporal ActivityFailure with full
  // stacks and platform response bodies.
  private static readonly MAX_MESSAGE_LEN = 64_000;

  // Headers that carry credentials or session state. Matched case-insensitively
  // against header names. Anything matching is redacted to "[REDACTED]" before
  // the response is serialized into Errors.message.
  private static readonly SENSITIVE_HEADER_PATTERNS: readonly RegExp[] = [
    /^authorization$/i,
    /^proxy-authorization$/i,
    /^cookie$/i,
    /^set-cookie$/i,
    /^x-api-key$/i,
    /^x-auth-token$/i,
    /^x-csrf-token$/i,
    /^x-session-token$/i,
    /^x-access-token$/i,
    /^x-refresh-token$/i,
    /^api-key$/i,
    /^bearer$/i,
    /token/i, // catches x-amz-security-token, dropbox-api-token, etc.
  ];

  // Query-string parameters that may carry credentials. Stripped from
  // captured URLs before storing.
  private static readonly SENSITIVE_QUERY_PARAMS: readonly string[] = [
    'access_token',
    'refresh_token',
    'id_token',
    'code',
    'client_secret',
    'api_key',
    'apikey',
    'token',
    'auth',
    'signature',
    'sig',
  ];

  /**
   * Replace credential-carrying header values with "[REDACTED]". Accepts the
   * shape used by axios/undici/Node http: either a plain `Record<string, string>`
   * or a `Headers`-like object with `.forEach`. Returns a plain object — the
   * caller will JSON.stringify it.
   */
  private static redactHeaders(headers: any): Record<string, string> | undefined {
    if (headers == null) return undefined;

    const isSensitive = (name: string) =>
      PostsRepository.SENSITIVE_HEADER_PATTERNS.some((re) => re.test(name));

    const out: Record<string, string> = {};

    // Headers-API shape (fetch / undici)
    if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
      try {
        headers.forEach((value: string, name: string) => {
          out[name] = isSensitive(name) ? '[REDACTED]' : String(value);
        });
        return out;
      } catch (_) {
        // fall through to plain-object path
      }
    }

    // Plain object / axios headers
    if (typeof headers === 'object') {
      for (const [name, value] of Object.entries(headers)) {
        if (value == null) continue;
        out[name] = isSensitive(name)
          ? '[REDACTED]'
          : Array.isArray(value)
            ? value.map((v) => String(v)).join(', ')
            : String(value);
      }
      return out;
    }

    return undefined;
  }

  /**
   * Strip credential-carrying query parameters from a URL while preserving
   * the rest. Falsy input passes through unchanged. Unparseable URLs are
   * returned as-is (better to log than to drop the diagnostic info).
   */
  private static redactUrl(url: unknown): string | undefined {
    if (url == null) return undefined;
    const raw = String(url);

    try {
      // URL constructor requires absolute URL or a base. Provider SDKs use
      // absolute URLs; fall back to a synthetic base for safety.
      const u = new URL(raw, 'http://internal.invalid');
      let changed = false;
      for (const key of PostsRepository.SENSITIVE_QUERY_PARAMS) {
        if (u.searchParams.has(key)) {
          u.searchParams.set(key, '[REDACTED]');
          changed = true;
        }
      }
      // Preserve original-style URL: if synthetic base was used and unchanged,
      // hand back the raw string to avoid spurious http://internal.invalid prefix.
      if (!changed && u.origin === 'http://internal.invalid') return raw;
      return u.origin === 'http://internal.invalid'
        ? u.pathname + (u.search || '')
        : u.toString();
    } catch (_) {
      // Best-effort regex fallback for non-URL-parseable strings.
      let s = raw;
      for (const key of PostsRepository.SENSITIVE_QUERY_PARAMS) {
        const re = new RegExp(`([?&]${key}=)[^&]*`, 'gi');
        s = s.replace(re, `$1[REDACTED]`);
      }
      return s;
    }
  }

  /**
   * Walk an error and its cause chain, producing a single comprehensive
   * string suitable for the Errors.message column. We intentionally keep
   * everything in one field (rather than splitting into stack/code/type
   * columns) because:
   *   - Temporal already serializes ActivityFailure to JSON with the full
   *     cause chain, stack traces, retry state, and activity metadata.
   *   - That JSON is stored verbatim by callers that pass it through `body`,
   *     so a parallel column structure would be redundant.
   *   - One field is simpler to inspect in any admin UI / psql query.
   *
   * Output shape:
   *   [Type] (Code: 401) Message  |  [InnerType] (Code: ECONNRESET) InnerMsg  |  ...
   *   Details: <JSON of structured payloads (response bodies, rate limits, etc.)>
   *   Stack:
   *     <full stack traces of every cause-chain level — NOT truncated to 3 lines>
   */
  private extractErrorMessage(err: any): string {
    if (err == null) return '';
    if (typeof err === 'string') return this.truncateMessage(err);

    const messageParts: string[] = [];
    const stackParts: string[] = [];
    const detailParts: any[] = [];

    let current: any = err;
    const seen = new Set<any>();
    let depth = 0;
    const MAX_DEPTH = 10;

    while (current && depth < MAX_DEPTH) {
      if (typeof current === 'object' && seen.has(current)) break;
      if (typeof current === 'object') seen.add(current);

      const message = current.message || current.details?.message || '';
      const type = current.type || current.name || '';
      const code = current.code || current.status || current.statusCode || '';

      let line = '';
      if (type && type !== 'Error') line += `[${type}] `;
      if (code !== undefined && code !== null && code !== '') line += `(Code: ${code}) `;
      if (message) line += message;
      if (line) messageParts.push(line);

      // Capture the FULL stack — no .slice(0, 3) truncation. Final length is
      // capped at the very end so even a 50-frame stack survives.
      const rawStack: string | undefined = current.stackTrace || current.stack;
      if (rawStack) {
        const header = type && type !== 'Error' ? `[${type}]` : '(stack)';
        stackParts.push(`${header}\n${rawStack}`);
      }

      // Structured payloads — common shapes:
      //   - Temporal ApplicationFailure: `details` array
      //   - twitter-api-v2 ApiResponseError: `data`, `errors`, `rateLimit`
      //   - axios / undici: `response.data`, `response.status`, `config.url`
      const structured: Record<string, unknown> = {};
      if (current.details && current.details !== current.message) {
        structured.details = current.details;
      }
      if (current.data !== undefined) structured.data = current.data;
      if (current.errors !== undefined) structured.errors = current.errors;
      if (current.rateLimit !== undefined) structured.rateLimit = current.rateLimit;
      if (current.response !== undefined) {
        const r = current.response;
        structured.response = {
          status: r?.status,
          statusText: r?.statusText,
          data: r?.data,
          // CRITICAL: headers are redacted. axios/undici/twitter-api-v2 error
          // objects expose request+response headers, which routinely contain
          // `Authorization: Bearer <accessToken>` and `Set-Cookie` / session
          // tokens. Persisting these to the multi-tenant Errors table is a
          // credential exposure (any admin / support / analytics consumer
          // could impersonate the user's OAuth identity until rotation).
          headers: PostsRepository.redactHeaders(r?.headers),
        };
      }
      if (current.config?.url) {
        // Same threat: many OAuth providers historically accept
        // `?access_token=...` / `?refresh_token=...` in the URL. Strip
        // sensitive query parameters before storing.
        structured.requestUrl = PostsRepository.redactUrl(current.config.url);
        structured.requestMethod = current.config.method;
      }
      if (Object.keys(structured).length > 0) {
        detailParts.push({
          level: depth,
          type: type || undefined,
          ...structured,
        });
      }

      if (current.cause && current.cause !== current) {
        current = current.cause;
      } else if (current.originalError && current.originalError !== current) {
        current = current.originalError;
      } else {
        break;
      }
      depth++;
    }

    const sections: string[] = [];
    if (messageParts.length > 0) {
      sections.push(messageParts.join(' | '));
    }
    if (detailParts.length > 0) {
      try {
        sections.push(`Details: ${JSON.stringify(detailParts, this.replacer())}`);
      } catch (_) {}
    }
    if (stackParts.length > 0) {
      sections.push(`Stack:\n${stackParts.join('\n\n')}`);
    }

    let out = sections.join('\n');
    if (!out) {
      try {
        out = JSON.stringify(err, this.replacer());
      } catch (_) {
        out = String(err);
      }
    }

    return this.truncateMessage(out);
  }

  private truncateMessage(s: string): string {
    const max = PostsRepository.MAX_MESSAGE_LEN;
    if (s.length <= max) return s;
    return s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`;
  }

  private replacer() {
    const seen = new WeakSet();
    return (_key: string, value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value as object)) return '[Circular]';
        seen.add(value as object);
      }
      if (value instanceof Error) {
        return { name: value.name, message: value.message };
      }
      return value;
    };
  }

  async changeState(id: string, state: State, err?: any, body?: any) {
    const errorMessage = err ? this.extractErrorMessage(err) : undefined;

    const update = await this._post.model.post.update({
      where: {
        id,
      },
      data: {
        state,
        ...(errorMessage ? { error: errorMessage } : {}),
        ...(state === 'ERROR' ? { releaseId: null } : {}),
      },
      include: {
        integration: {
          select: {
            providerIdentifier: true,
          },
        },
      },
    });

    if (state === 'ERROR' && err && body) {
      try {
        await this._errors.model.errors.create({
          data: {
            message: errorMessage || '',
            organizationId: update.organizationId,
            platform: update.integration.providerIdentifier,
            postId: update.id,
            body: typeof body === 'string' ? body : JSON.stringify(body),
          },
        });
      } catch (err) { }
    }

    return update;
  }

  async logError(id: string, err?: any, body?: any) {
    const errorMessage = err ? this.extractErrorMessage(err) : undefined;
    const post = await this._post.model.post.findUnique({
      where: { id },
      include: {
        integration: {
          select: { providerIdentifier: true },
        },
      },
    });
    if (!post) return;

    try {
      await this._errors.model.errors.create({
        data: {
          message: errorMessage || '',
          organizationId: post.organizationId,
          platform: post.integration.providerIdentifier,
          postId: post.id,
          body: body
            ? typeof body === 'string' ? body : JSON.stringify(body)
            : '',
        },
      });
    } catch (_) {}
  }

  async changeDate(orgId: string, id: string, date: string) {
    return this._post.model.post.update({
      where: {
        organizationId: orgId,
        id,
      },
      data: {
        publishDate: dayjs(date).toDate(),
      },
    });
  }

  countPostsFromDay(orgId: string, date: Date) {
    return this._post.model.post.count({
      where: {
        organizationId: orgId,
        parentPostId: null,
        publishDate: {
          gte: date,
        },
        OR: [
          {
            deletedAt: null,
            state: {
              in: ['QUEUE'],
            },
          },
          {
            state: 'PUBLISHED',
          },
        ],
      },
    });
  }

  async createOrUpdatePost(
    state: 'draft' | 'schedule' | 'now',
    orgId: string,
    date: string,
    body: PostBody,
    tags: { value: string; label: string }[],
    inter?: number,
    source?: PostSource,
    projectId?: string
  ) {
    const posts: Post[] = [];
    // Reuse existing group when editing, new UUID only for fresh posts.
    // This keeps published clones in the same group as the original.
    const uuid = body.group || uuidv4();

    for (const value of body.value) {
      const updateData = (type: 'create' | 'update') => ({
        publishDate: dayjs(date).toDate(),
        integration: {
          connect: {
            id: body.integration.id,
            organizationId: orgId,
          },
        },
        ...(posts?.[posts.length - 1]?.id
          ? {
            parentPost: {
              connect: {
                id: posts[posts.length - 1]?.id,
              },
            },
          }
          : type === 'update'
            ? {
              parentPost: {
                disconnect: true,
              },
            }
            : {}),
        content: value.content,
        delay: value.delay || 0,
        group: uuid,
        intervalInDays: inter ? +inter : null,
        ...(type === 'create' ? { source: source || 'calendar' } : {}),
        approvedSubmitForOrder: APPROVED_SUBMIT_FOR_ORDER.NO,
        state: state === 'draft' ? ('DRAFT' as const) : ('QUEUE' as const),
        releaseId: null,
        releaseURL: null,
        error: null,
        image: JSON.stringify(value.image),
        settings: JSON.stringify(body.settings),
        organization: {
          connect: {
            id: orgId,
          },
        },
        // Opaque aisee-core products.id, attribution set at creation time
        // (default null = legacy, non-project post). Unlike source/etc.
        // above, an update only touches it when the caller explicitly
        // passes one — omitting projectId on an edit must not silently
        // clear an existing post's project attribution.
        ...(type === 'create'
          ? { projectId: projectId ?? null }
          : projectId !== undefined
            ? { projectId }
            : {}),
      });

      posts.push(
        await this._post.model.post.upsert({
          where: {
            id: value.id || uuidv4(),
          },
          create: { ...updateData('create') },
          update: {
            ...updateData('update'),
            lastMessage: {
              disconnect: true,
            },
            submittedForOrder: {
              disconnect: true,
            },
          },
        })
      );

      if (posts.length === 1) {
        await this._tagsPosts.model.tagsPosts.deleteMany({
          where: {
            post: {
              id: posts[0].id,
            },
          },
        });

        if (tags.length) {
          const tagsList = await this._tags.model.tags.findMany({
            where: {
              orgId: orgId,
              name: {
                in: tags.map((tag) => tag.label).filter((f) => f),
              },
            },
          });

          if (tagsList.length) {
            await this._post.model.post.update({
              where: {
                id: posts[posts.length - 1].id,
              },
              data: {
                tags: {
                  createMany: {
                    data: tagsList.map((tag) => ({
                      tagId: tag.id,
                    })),
                  },
                },
              },
            });
          }
        }
      }
    }

    const previousPost = body.group
      ? (
        await this._post.model.post.findFirst({
          where: {
            group: body.group,
            deletedAt: null,
            parentPostId: null,
          },
          select: {
            id: true,
          },
        })
      )?.id!
      : undefined;

    return { previousPost, posts };
  }

  async submit(id: string, order: string, buyerOrganizationId: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        submittedForOrderId: order,
        approvedSubmitForOrder: 'WAITING_CONFIRMATION',
        submittedForOrganizationId: buyerOrganizationId,
      },
      select: {
        id: true,
        description: true,
        submittedForOrder: {
          select: {
            messageGroupId: true,
          },
        },
      },
    });
  }

  updateMessage(id: string, messageId: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        lastMessageId: messageId,
      },
    });
  }

  async hasRecurringOriginalInGroup(group: string): Promise<boolean> {
    const count = await this._post.model.post.count({
      where: {
        group,
        intervalInDays: { not: null },
        deletedAt: null,
      },
    });
    return count > 0;
  }

  async resetPostForRetry(id: string, orgId: string): Promise<boolean> {
    const result = await this._post.model.post.updateMany({
      where: {
        id,
        organizationId: orgId,
        state: 'ERROR',
        deletedAt: null,
      },
      data: {
        state: 'QUEUE',
        releaseId: null,
        error: null,
      },
    });
    return result.count > 0;
  }

  getPostById(id: string, org?: string) {
    return this._post.model.post.findUnique({
      where: {
        id,
        ...(org ? { organizationId: org } : {}),
      },
      include: {
        integration: true,
        submittedForOrder: {
          include: {
            posts: {
              where: {
                state: 'PUBLISHED',
              },
            },
            ordersItems: true,
            seller: {
              select: {
                id: true,
                account: true,
              },
            },
          },
        },
      },
    });
  }

  findAllExistingCategories() {
    return this._popularPosts.model.popularPosts.findMany({
      select: {
        category: true,
      },
      distinct: ['category'],
    });
  }

  findAllExistingTopicsOfCategory(category: string) {
    return this._popularPosts.model.popularPosts.findMany({
      where: {
        category,
      },
      select: {
        topic: true,
      },
      distinct: ['topic'],
    });
  }

  findPopularPosts(category: string, topic?: string) {
    return this._popularPosts.model.popularPosts.findMany({
      where: {
        category,
        ...(topic ? { topic } : {}),
      },
      select: {
        content: true,
        hook: true,
      },
    });
  }

  createPopularPosts(post: {
    category: string;
    topic: string;
    content: string;
    hook: string;
  }) {
    return this._popularPosts.model.popularPosts.create({
      data: {
        category: 'category',
        topic: 'topic',
        content: 'content',
        hook: 'hook',
      },
    });
  }

  async getPostsCountsByDates(
    orgId: string,
    times: number[],
    date: dayjs.Dayjs
  ) {
    const dates = await this._post.model.post.findMany({
      where: {
        deletedAt: null,
        organizationId: orgId,
        publishDate: {
          in: times.map((time) => {
            return date.clone().add(time, 'minutes').toDate();
          }),
        },
      },
    });

    return times.filter(
      (time) =>
        date.clone().add(time, 'minutes').isAfter(dayjs.utc()) &&
        !dates.find((dateFind) => {
          return (
            dayjs
              .utc(dateFind.publishDate)
              .diff(date.clone().startOf('day'), 'minutes') == time
          );
        })
    );
  }

  async getComments(postId: string) {
    return this._comments.model.comments.findMany({
      where: {
        postId,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
  }

  async getTags(orgId: string) {
    return this._tags.model.tags.findMany({
      where: {
        orgId,
      },
    });
  }

  createTag(orgId: string, body: CreateTagDto) {
    return this._tags.model.tags.create({
      data: {
        orgId,
        name: body.name,
        color: body.color,
      },
    });
  }

  editTag(id: string, orgId: string, body: CreateTagDto) {
    return this._tags.model.tags.update({
      where: {
        id,
      },
      data: {
        name: body.name,
        color: body.color,
      },
    });
  }

  createComment(
    orgId: string,
    userId: string,
    postId: string,
    content: string
  ) {
    return this._comments.model.comments.create({
      data: {
        organizationId: orgId,
        userId,
        postId,
        content,
      },
    });
  }

  async getPostByForWebhookId(postId: string) {
    return this._post.model.post.findMany({
      where: {
        id: postId,
        deletedAt: null,
        parentPostId: null,
      },
      select: {
        id: true,
        content: true,
        publishDate: true,
        releaseURL: true,
        state: true,
        integration: {
          select: {
            id: true,
            name: true,
            providerIdentifier: true,
            picture: true,
            type: true,
          },
        },
      },
    });
  }

  async getPostsSince(orgId: string, since: string) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        publishDate: {
          gte: new Date(since),
        },
        deletedAt: null,
        parentPostId: null,
      },
      select: {
        id: true,
        content: true,
        publishDate: true,
        releaseURL: true,
        state: true,
        integration: {
          select: {
            id: true,
            name: true,
            providerIdentifier: true,
            picture: true,
            type: true,
          },
        },
      },
    });
  }

  /**
   * Of the given candidate post ids (what the user is currently viewing), return
   * only those DUE for a metrics fetch: owned by the org, published, still inside
   * the monitoring window (`publishDate >= windowStart`), and either never
   * fetched or last fetched before `intervalCutoff`. This is the server-side
   * "visible ∩ due" gate behind the demand-driven extension fetch.
   */
  getDueMetricsPosts(
    organizationId: string,
    ids: string[],
    windowStart: Date,
    intervalCutoff: Date
  ) {
    return this._post.model.post.findMany({
      where: {
        id: { in: ids },
        organizationId,
        deletedAt: null,
        state: State.PUBLISHED,
        publishDate: { gte: windowStart },
        OR: [
          { lastMetricsFetchAt: null },
          { lastMetricsFetchAt: { lt: intervalCutoff } },
        ],
      },
      select: {
        id: true,
        source: true,
        publishDate: true,
        lastMetricsFetchAt: true,
        releaseURL: true,
        integrationId: true,
        integration: {
          select: { id: true, name: true, providerIdentifier: true },
        },
      },
    });
  }

  /**
   * Resolve the platform (providerIdentifier) for each org-owned post id. Used
   * by the metrics backfill to derive the platform server-side — never trusting
   * a platform the extension claims — so traffic weights and impression labels
   * are applied authoritatively. Posts not owned by the org are simply absent.
   */
  getPostsProviderByIds(organizationId: string, ids: string[]) {
    return this._post.model.post.findMany({
      where: { id: { in: ids }, organizationId, deletedAt: null },
      select: {
        id: true,
        // Currently persisted values — so the ingest response can echo the
        // effective stored value when a fresh read declines to overwrite it
        // (a transient zero read must not flicker the UI back to 0).
        impressions: true,
        trafficScore: true,
        integration: { select: { providerIdentifier: true } },
      },
    });
  }

  /**
   * Stamp `lastMetricsFetchAt = now` for the given org-owned posts — called by
   * the backfill path once the extension returns metrics, so the interval gate
   * holds and the same posts are not re-fetched until the interval elapses.
   */
  markMetricsFetched(organizationId: string, ids: string[], now: Date) {
    return this._post.model.post.updateMany({
      where: { id: { in: ids }, organizationId },
      data: { lastMetricsFetchAt: now },
    });
  }

  async syncPostMetrics(
    orgId: string,
    externalPostId: string,
    metrics: Record<string, number>
  ): Promise<{ updated: boolean }> {
    // Find Post whose releaseURL contains the tweet/reddit-post id.
    // X: https://x.com/user/status/{id}  Reddit: https://reddit.com/r/sub/comments/{id}/...
    const post = await this._post.model.post.findFirst({
      where: { organizationId: orgId, releaseURL: { contains: externalPostId } },
      select: { id: true },
    });
    if (!post) return { updated: false };

    const pick = (key: string) =>
      typeof metrics[key] === 'number' ? metrics[key] : undefined;

    const analytics: Record<string, number> = {};
    const map: Record<string, string> = {
      metricLikes: 'likes', metricReplies: 'replies', metricRetweets: 'retweets',
      metricQuotes: 'quotes', metricBookmarks: 'bookmarks', metricViews: 'views',
      metricShares: 'shares', metricSaves: 'saves', metricComments: 'comments',
      metricScore: 'score',
    };
    for (const [field, key] of Object.entries(map)) {
      const v = pick(key) ?? pick(field);
      if (v !== undefined) analytics[field] = v;
    }

    const viewCount = pick('metricViews') ?? pick('views');
    await this._post.model.post.update({
      where: { id: post.id },
      data: {
        impressions: viewCount !== undefined ? viewCount : undefined,
        analytics: Object.keys(analytics).length ? (analytics as any) : undefined,
        lastMetricsFetchAt: new Date(),
      },
    });
    return { updated: true };
  }
}

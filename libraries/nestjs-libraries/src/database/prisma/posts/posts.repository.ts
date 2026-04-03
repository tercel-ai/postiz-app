import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Post as PostBody } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';
import { APPROVED_SUBMIT_FOR_ORDER, Post, State } from '@prisma/client';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';
import { GetPostsListDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts-list.dto';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import weekOfYear from 'dayjs/plugin/weekOfYear';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { v4 as uuidv4 } from 'uuid';
import { parseDate } from '@gitroom/helpers/utils/date.utils';
import { CreateTagDto } from '@gitroom/nestjs-libraries/dtos/posts/create.tag.dto';

dayjs.extend(isoWeek);
dayjs.extend(weekOfYear);
dayjs.extend(isSameOrAfter);
dayjs.extend(utc);
dayjs.extend(timezone);

function displayToUnit(display: 'day' | 'week' | 'month'): 'day' | 'isoWeek' | 'month' {
  if (display === 'day') return 'day';
  if (display === 'week') return 'isoWeek';
  return 'month';
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

  getPostByIdForAdmin(id: string) {
    return this._post.model.post.findUnique({
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
  }

  async getAllPostsList(query: GetPostsListDto & { organizationId?: string | string[] }) {
    const skip = (query.page - 1) * query.pageSize;
    const where = {
      deletedAt: null,
      parentPostId: null,
      ...(query.organizationId
        ? { organizationId: Array.isArray(query.organizationId) ? { in: query.organizationId } : query.organizationId }
        : {}),
      ...(query.state ? { state: query.state } : {}),
      ...(query.integrationId?.length
        ? { integrationId: { in: query.integrationId } }
        : {}),
      ...(query.channel?.length
        ? { integration: { providerIdentifier: { in: query.channel } } }
        : {}),
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
      ...(query.state ? { state: query.state } : {}),
      ...(query.integrationId?.length
        ? { integrationId: { in: query.integrationId } }
        : {}),
      ...(query.channel?.length
        ? { integration: { providerIdentifier: { in: query.channel } } }
        : {}),
    };

    const [results, total] = await Promise.all([
      this._post.model.post.findMany({
        where,
        orderBy: {
          [query.sortBy]: query.sortOrder,
        },
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
        // For recurring posts the original always stays QUEUE; state filter is
        // applied later after expansion. Non-recurring posts are filtered directly here.
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
        ...((query.channel?.length || query.customer)
          ? {
            integration: {
              ...(query.channel?.length ? { providerIdentifier: { in: query.channel } } : {}),
              ...(query.customer ? { customerId: query.customer } : {}),
            },
          }
          : {}),
      },
      select: {
        id: true,
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
    isFirst?: boolean
  ) {
    return this._post.model.post.findUnique({
      where: {
        id,
        ...(orgId ? { organizationId: orgId } : {}),
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

  private extractErrorMessage(err: any): string {
    if (typeof err === 'string') return err;

    const parts: string[] = [];
    let current = err;
    const seen = new Set();
    let depth = 0;
    const MAX_DEPTH = 10;

    while (current && depth < MAX_DEPTH) {
      if (seen.has(current)) break;
      seen.add(current);

      const message = current.message || current.details?.message || '';
      const type = current.type || current.name || '';
      const code = current.code || current.status || current.statusCode || '';

      let part = '';
      if (type && type !== 'Error') part += `[${type}] `;
      if (code) part += `(Code: ${code}) `;
      if (message) part += message;

      if (part) parts.push(part);

      // Extract details if available (especially for ApplicationFailure)
      const details = current.details || current.cause?.details;
      if (details) {
        try {
          const detailedStr = typeof details === 'string' ? details : JSON.stringify(details);
          if (detailedStr !== '{}' && detailedStr !== '[]') {
            parts.push(`Details: ${detailedStr}`);
          }
        } catch (_) {}
      }

      if (current.stackTrace || current.stack) {
        // Just take the first couple of lines of stack trace to avoid bloating the database
        const stack = (current.stackTrace || current.stack).split('\n').slice(0, 3).join('\n');
        parts.push(`Stack: ${stack}`);
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

    if (parts.length > 0) return parts.join(' | ');

    try {
      return JSON.stringify(err, (key, value) => {
        if (value instanceof Error) {
          return {
            name: value.name,
            message: value.message,
            stack: value.stack?.split('\n').slice(0, 3).join('\n'),
            ...value,
          };
        }
        return value;
      });
    } catch (_) {
      return String(err);
    }
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
    source?: 'calendar' | 'chat'
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
}

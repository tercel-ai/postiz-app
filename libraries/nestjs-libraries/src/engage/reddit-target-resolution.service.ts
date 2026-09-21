// Server side of the parked-Reddit-post handshake: hand the browser extension
// the posts that still need a community, and accept what it finds.
//
// The extension is the executor here, exactly as it is for scanning and
// publishing — this service is the scheduler. It never reaches Reddit itself;
// everything it knows about a community arrives through resolve().
//
// Two rules shape the whole file:
//
//  1. Nothing the extension sends is trusted as-is. A subreddit name is
//     re-normalized (normalizeSubreddit) before it is written, because the
//     value lands in `settings.subreddit[].value.subreddit` where the submit
//     call reads it verbatim. The extension is a client; a client that has been
//     tampered with must not be able to write an arbitrary string there.
//
//  2. A resolution is idempotent and last-writer-wins. Two browsers signed into
//     the same org can both be handed the same parked post — there is no lease,
//     deliberately: a lease would park a post behind a browser that closed, and
//     the operation is cheap and convergent (both browsers resolve the same post
//     to a valid community; whichever lands second wins, and both are correct).
//     The write is conditional on the post still being parked, so a resolution
//     can never overwrite a community a human has since chosen by hand.

import { Injectable, Logger } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  applyResolvedRedditTarget,
  clearRedditTargetPending,
  readRedditTargetPending,
  REDDIT_TARGET_PENDING_KEY,
  RedditTargetPending,
} from '@gitroom/nestjs-libraries/engage/reddit-pending-target';
import { normalizeSubreddit } from '@gitroom/nestjs-libraries/database/prisma/operation-plan/reddit-target-resolver';

/** One parked post, as handed to the extension. */
export interface PendingRedditTargetItem {
  postId: string;
  /** Post body — the extension uses it to judge which community fits. */
  content: string;
  pending: RedditTargetPending;
  /** Scheduled publish time, so the extension can resolve the soonest first. */
  publishDate: string;
}

/** What the extension reports back for one post. */
export interface RedditTargetResolutionInput {
  postId: string;
  /** The community it chose. Omit (or send unresolvable) when it found none. */
  subreddit?: string | null;
  /** Reddit's own text for the matched flair option, when there is one. */
  flairLabel?: string | null;
  /** Observed: this community rejects a post with no flair. */
  flairRequired?: boolean;
  /**
   * The extension looked and there is no usable community for this post. The
   * post is soft-deleted — the same end state the old inline resolver reached by
   * dropping it, but reached after someone actually checked.
   */
  unresolvable?: boolean;
}

export interface RedditTargetResolutionResult {
  resolved: number;
  retired: number;
  skipped: number;
}

// Cap on one hand-out. The extension resolves these one community at a time
// against the user's own session, so a large batch is a long tab-driving run —
// and the next poll picks up whatever is left.
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

@Injectable()
export class RedditTargetResolutionService {
  private readonly logger = new Logger(RedditTargetResolutionService.name);

  constructor(private _post: PrismaRepository<'post'>) {}

  /**
   * Parked Reddit posts for this org, soonest-scheduled first.
   *
   * Matched by the marker's raw presence in the settings JSON string, the same
   * predicate the publish-due query excludes on — so "offered here" and "kept
   * out of the publish queue" are two readings of one condition and cannot
   * drift into a post that is both.
   */
  async listPending(
    organizationId: string,
    limit = DEFAULT_LIMIT
  ): Promise<PendingRedditTargetItem[]> {
    const rows = await this._post.model.post.findMany({
      where: {
        organizationId,
        deletedAt: null,
        providerIdentifier: 'reddit',
        settings: { contains: `"${REDDIT_TARGET_PENDING_KEY}"` },
        // Roots only: a thread's parts share their anchor's community and are
        // resolved with it (see resolve), so offering them separately would ask
        // the extension to pick a community per segment.
        parentPostId: null,
      },
      orderBy: { publishDate: 'asc' },
      take: Math.min(Math.max(1, limit), MAX_LIMIT),
      select: { id: true, content: true, settings: true, publishDate: true },
    });

    return rows.flatMap((row) => {
      const pending = readRedditTargetPending(row.settings);
      // A row whose marker will not parse is not actionable and must not be
      // offered: the extension would have no title to submit with. It stays in
      // the query's reach, which is deliberate — it is visible to anyone
      // debugging rather than silently filtered out of existence.
      if (!pending) {
        this.logger.warn(
          `[reddit-target] post ${row.id} matches the pending marker but it does not parse; skipping`
        );
        return [];
      }
      return [
        {
          postId: row.id,
          content: row.content ?? '',
          pending,
          publishDate: row.publishDate.toISOString(),
        },
      ];
    });
  }

  /** How many are parked — a cheap count for the extension's poll gate. */
  async countPending(organizationId: string): Promise<number> {
    return this._post.model.post.count({
      where: {
        organizationId,
        deletedAt: null,
        providerIdentifier: 'reddit',
        settings: { contains: `"${REDDIT_TARGET_PENDING_KEY}"` },
        parentPostId: null,
      },
    });
  }

  /** Apply a batch of resolutions. Never throws on one bad item. */
  async resolve(
    organizationId: string,
    inputs: RedditTargetResolutionInput[]
  ): Promise<RedditTargetResolutionResult> {
    const result: RedditTargetResolutionResult = {
      resolved: 0,
      retired: 0,
      skipped: 0,
    };

    for (const input of inputs) {
      try {
        const applied = await this._resolveOne(organizationId, input);
        result[applied] += 1;
      } catch (error) {
        // One malformed item must not cost the rest of the batch: the extension
        // sends what a whole polling round produced, and failing the request
        // would make it re-resolve every community in it.
        result.skipped += 1;
        this.logger.warn(
          `[reddit-target] resolving post ${input?.postId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    return result;
  }

  private async _resolveOne(
    organizationId: string,
    input: RedditTargetResolutionInput
  ): Promise<'resolved' | 'retired' | 'skipped'> {
    if (!input?.postId) return 'skipped';

    const post = await this._post.model.post.findFirst({
      where: { id: input.postId, organizationId, deletedAt: null },
      select: { id: true, settings: true, group: true },
    });
    if (!post) return 'skipped';

    const pending = readRedditTargetPending(post.settings);
    // Not parked any more — already resolved by another browser, or a human
    // picked a community in the editor. Either way this answer is stale and
    // must not overwrite what is there.
    if (!pending) return 'skipped';

    if (input.unresolvable) {
      await this._retire(organizationId, post.group);
      return 'retired';
    }

    // Re-normalize rather than trust: this value is submitted verbatim.
    const subreddit = normalizeSubreddit(input.subreddit);
    if (!subreddit) {
      this.logger.warn(
        `[reddit-target] post ${post.id}: rejected subreddit ${JSON.stringify(
          input.subreddit
        )} — not a valid community name`
      );
      return 'skipped';
    }

    const flairLabel = (input.flairLabel || '').trim();
    const resolution = {
      subreddit,
      title: pending.title,
      type: 'self' as const,
      ...(flairLabel ? { flairLabel } : {}),
      ...(input.flairRequired === true ? { flairRequired: true as const } : {}),
    };

    // The anchor AND its thread parts: they publish as one chain into one
    // community, so a partially-resolved group would submit the anchor and then
    // fail on every follow-up. `group` is per-platform (see materializePlanPosts),
    // so this cannot reach another channel's posts.
    const siblings = await this._post.model.post.findMany({
      where: { organizationId, group: post.group, deletedAt: null },
      select: { id: true, settings: true },
    });

    for (const sibling of siblings) {
      // Each row carries its own marker and its own title; resolve only the
      // ones still parked, so a re-run cannot clobber a sibling someone fixed.
      const siblingPending = readRedditTargetPending(sibling.settings);
      if (!siblingPending) continue;
      await this._post.model.post.update({
        where: { id: sibling.id },
        data: {
          settings: applyResolvedRedditTarget(sibling.settings, {
            ...resolution,
            // Keep each row's OWN title: a thread part's title is not the
            // anchor's, and Reddit submits the anchor's only.
            title: siblingPending.title,
          }),
        },
      });
    }

    return 'resolved';
  }

  /**
   * No community exists for this post. Soft-delete the whole chain and clear the
   * marker, so it leaves both the parked list and every publish query.
   *
   * Soft, not hard: the post is the output of a plan the user paid to generate,
   * and "the extension could not place it" is a judgement worth being able to
   * review. `deletedAt` already excludes it everywhere that matters.
   */
  private async _retire(organizationId: string, group: string): Promise<void> {
    // Org-scoped even though `group` embeds a plan UUID and could not collide in
    // practice: this soft-deletes rows, and a delete should not rest on "could
    // not happen" when scoping it costs one predicate.
    const rows = await this._post.model.post.findMany({
      where: { organizationId, group, deletedAt: null },
      select: { id: true, settings: true },
    });
    if (!rows.length) return;

    const now = new Date();
    await this._post.model.post.updateMany({
      where: { organizationId, group, deletedAt: null },
      data: { deletedAt: now },
    });

    // Clear the marker on EVERY row of the chain, not just the one we were told
    // about: `deletedAt` is what hides them today, so a row that is ever
    // un-deleted would otherwise come straight back onto the parked list.
    for (const row of rows) {
      if (!readRedditTargetPending(row.settings)) continue;
      await this._post.model.post.update({
        where: { id: row.id },
        data: { settings: clearRedditTargetPending(row.settings) },
      });
    }
  }
}

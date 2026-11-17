import { Prisma } from '@prisma/client';
import { legacyExecutionWhere } from '@gitroom/nestjs-libraries/extension/legacy-execution';
import { Injectable, Logger } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  AiseeNotificationChannel,
  AiseeNotificationClient,
  AiseeNotificationEvent,
} from '@gitroom/nestjs-libraries/notifications/aisee-notification.client';
import {
  DEFAULT_OPPORTUNITY_TTL_DAYS,
  EngageScanConfigService,
  SCANNABLE_PLATFORMS,
  opportunityExpiryCutoff,
} from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

interface MaintenanceJob {
  key: string;
  run: () => Promise<string>;
}

/**
 * Engage-domain, cheap, all-DB maintenance jobs that need to run on a
 * wall-clock cadence regardless of what triggers business activity (page
 * visits, extension scans, etc.). Unlike the engage scan ticker — which is
 * event-driven on purpose to avoid burning upstream API quota — these jobs
 * only touch our own database, so a plain hourly tick is the simplest correct
 * design. Add new engage DB-hygiene work as another entry in `_jobs` rather
 * than inventing a bespoke scheduled workflow per job. Deliberately scoped to
 * engage: its dependencies stay cohesive (engage state + config only). A
 * cross-domain DB-hygiene need would warrant a separate, broader host, not
 * widening this one into a multi-domain god-activity.
 */
@Injectable()
@Activity()
export class EngageHousekeepingActivity {
  private readonly logger = new Logger(EngageHousekeepingActivity.name);

  constructor(
    private _oppState: PrismaRepository<'engageOpportunityState'>,
    private _post: PrismaRepository<'post'>,
    private _scanConfig: EngageScanConfigService,
    private _engageRepository: EngageRepository,
    private _aiseeNotificationClient: AiseeNotificationClient
  ) {}

  private get _jobs(): MaintenanceJob[] {
    return [
      {
        key: 'engage-opportunity-expiry',
        run: () => this._expireStaleOpportunities(),
      },
      {
        key: 'engage-stale-queued-reply-expiry',
        run: () => this._closeStaleQueuedReplies(),
      },
      {
        key: 'engage-orphaned-scan-cursor-cleanup',
        run: () => this._deleteOrphanedScanCursors(),
      },
    ];
  }

  @ActivityMethod()
  async runDueMaintenanceJobs(): Promise<void> {
    const jobs = this._jobs;
    const results = await Promise.allSettled(jobs.map((job) => job.run()));
    results.forEach((result, i) => {
      const key = jobs[i].key;
      if (result.status === 'fulfilled') {
        this.logger.log(`Housekeeping job "${key}": ${result.value}`);
      } else {
        this.logger.error(
          `Housekeeping job "${key}" failed: ${
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          }`
        );
      }
    });
  }

  /**
   * Close engage replies that have sat in QUEUE past their target's TTL.
   *
   * The gap this fills: a queued reply has NO expiry of its own. The
   * opportunity sweep above only touches `status: 'NEW'` state rows, and a
   * reply that has been drafted moved its state to AUTO_QUEUED — so a reply the
   * extension can never post is offered again every time its lease expires, for
   * as long as the row exists. Seen in production at six days and counting,
   * costing a send slot on every rotation.
   *
   * `claimDueEngageReplies` orders by least-recently-attempted, which stops one
   * such row from starving the queue; this is what eventually removes it. The
   * two are complements: ordering bounds the DAMAGE, this bounds the LIFETIME.
   *
   * The cutoff is the platform's own opportunity TTL, reused deliberately
   * rather than given a knob of its own. That number already answers "how long
   * is a post here still worth replying to", and a reply older than its
   * target's actionable window has nothing to be sent into — publishing it
   * would land a comment on a conversation that finished days ago.
   *
   * Two clocks, mirroring the opportunity sweep, either of which expires it:
   *   • post.createdAt          — how long the draft has been waiting to go out
   *   • opportunity.postPublishedAt — how old the target post itself is
   *
   * ERROR, not deleted: the row is the record that credit was spent generating
   * this reply, and the message says why it stopped. `releaseId`/`claimedAt` are
   * cleared with it so nothing is left holding a lease on a post that will never
   * be handed out again.
   */
  private async _closeStaleQueuedReplies(): Promise<string> {
    const ttlDays = await this._scanConfig.getOpportunityTtlDaysMap();
    const now = Date.now();

    let total = 0;
    const parts: string[] = [];
    for (const platform of SCANNABLE_PLATFORMS) {
      const cutoff = opportunityExpiryCutoff(platform, ttlDays, now);
      if (!cutoff) continue;
      const staleWhere: Prisma.PostWhereInput = {
        state: 'QUEUE',
        sendIntentId: null,
        releaseId: null,
        AND: [legacyExecutionWhere()],
        deletedAt: null,
        // Belt and braces with `state`: a reply that went out gains a URL, so
        // a half-written commit cannot be swept up here as if it were stuck.
        releaseURL: null,
        // `is` rather than `isNot: null` — it both requires the reply to
        // exist (so a plain scheduled POST is never touched by this) and
        // scopes it to the platform in one condition.
        engageSentReply: { is: { opportunity: { platform } } },
        // Only replies whose send time has ARRIVED. Without this the sweep
        // reaches a reply a user SCHEDULED for the future: `scheduleReply`
        // creates it with `type: 'schedule'`, `source: 'engage'` and a future
        // publishDate, and `createOrUpdatePost` writes `state: 'QUEUE'` — so
        // it satisfies every other predicate here. Cancelling it would flip it
        // to ERROR before it was ever due, and `claimPostForPublishing`
        // requires `state: 'QUEUE'`, so it could never be sent afterwards. The
        // user would be told it "waited past the TTL without going out" about
        // a reply that never had its turn.
        //
        // This costs the sweep nothing: the auto-queued replies it exists for
        // are created with `publishDate: new Date()`, so they are always
        // already due. A scheduled reply is merely spared until its slot
        // passes — after which it is swept like any other if it still fails.
        //
        // The house sweep for the same job on the same table takes the same
        // position and goes further: `markStaleQueuePostsAsError` measures
        // `publishDate` and excludes `source: 'engage'` outright, which is
        // exactly why scheduled engage replies were safe before this job.
        publishDate: { lte: new Date(now) },
        OR: [
          { createdAt: { lt: cutoff } },
          {
            engageSentReply: {
              is: { opportunity: { postPublishedAt: { lt: cutoff } } },
            },
          },
        ],
      };
      // Read the reply ids BEFORE closing the posts: once they are ERROR the
      // predicate no longer matches, and the SentReply is the unit the user was
      // told about. Only rows this pass actually closed are announced below.
      const candidates = await this._post.model.post.findMany({
        where: staleWhere,
        select: { id: true },
      });
      const staleError =
        'Expired in queue: this reply waited past the platform’s ' +
        'opportunity TTL without going out, so the conversation it was ' +
        'written for is no longer current. It was not sent.';
      const { count } = await this._post.model.post.updateMany({
        where: staleWhere,
        data: {
          state: 'ERROR',
          error: staleError,
          // `claimedAt` is deliberately preserved — it is the reply-side input
          // to getLastPlatformWriteAt (the platform write floor), not merely a
          // lease column. See EngageRepository.markOpportunityTargetGone.
          releaseId: null,
        },
      });
      total += count;
      if (count) parts.push(`${platform}=${count}@${ttlDays[platform]}d`);
      if (count) {
        // A candidate that published between the read and the write stays
        // PUBLISHED and must not be reported as a failure.
        const closed = await this._post.model.post.findMany({
          where: {
            id: { in: candidates.map((p) => p.id) },
            state: 'ERROR',
            error: staleError,
          },
          select: {
            organizationId: true,
            projectId: true,
            engageSentReply: { select: { id: true } },
          },
        });
        await this._notifyRepliesExpired(closed, platform);
      }
    }

    return `closed ${total} stale queued engage replies${
      parts.length ? ` (${parts.join(', ')})` : ''
    }`;
  }

  /**
   * Announce replies this sweep closed without sending.
   *
   * This is the only terminal path for a generated, already-paid-for reply that
   * nobody sent, so without it the user's only clue is a row quietly turning
   * into ERROR. Same event and per-reply dedup key as the on-demand failure
   * paths (`engage.reply_failed:{sentReplyId}`), so a reply already reported
   * through one of those is not announced twice.
   */
  private async _notifyRepliesExpired(
    closed: Array<{
      organizationId: string;
      projectId: string | null;
      engageSentReply: { id: string } | null;
    }>,
    platform: string
  ): Promise<void> {
    for (const post of closed) {
      const reply = post.engageSentReply;
      if (!reply) continue;
      await this._aiseeNotificationClient.notify({
        organizationId: post.organizationId,
        eventKey: AiseeNotificationEvent.ENGAGE_REPLY_FAILED,
        dedupKey: `engage.reply_failed:${reply.id}`,
        data: {
          platform,
          sent_reply_id: reply.id,
          project_id: post.projectId || undefined,
        },
        channel: AiseeNotificationChannel.ENGAGE,
      });
    }
  }

  /**
   * Delete scan cursors for units the enumerator no longer produces.
   *
   * Nothing else ever deletes an EngageScanCursor row, so every change to WHAT
   * GETS ENUMERATED leaves a layer behind: a keyword deleted or disabled, a
   * platform dropped from the scan allowlist, and above all the legacy
   * null-project config that `253cce37` excluded from scanning — every one of
   * its cursors froze mid-SCANNING on the day it shipped, with nothing left to
   * claim them. None of it blocks anything (the lease reclaims an expired row on
   * sight), but it accumulates: 53 rows, the oldest 71 days old, drowning the
   * stuck-cursor diagnostic in rows nobody could act on.
   *
   * A SWEEP rather than a hook on each delete path, deliberately. The dominant
   * cause here is not a user deleting a keyword — it is the enumeration rule
   * itself changing, which no delete hook can observe. A sweep keyed on "is this
   * unit still produced" catches every cause, including the ones nobody has
   * thought of yet.
   *
   * The live set is what makes it safe: a unit still being enumerated keeps its
   * cursor however old the row looks, so the TTL only decides how long a
   * genuinely dead row lingers.
   */
  private async _deleteOrphanedScanCursors(): Promise<string> {
    const ttlDays = await this._scanConfig.getScanCursorOrphanTtlDays();
    // 0 disables the sweep — the safe reading of a misconfigured deletion
    // window is "delete nothing".
    if (ttlDays <= 0) return 'skipped (orphan TTL disabled)';

    const cutoff = dayjs.utc().subtract(ttlDays, 'day').toDate();
    const live = await this._engageRepository.getLiveScanUnitKeys();
    const { deleted, examined } =
      await this._engageRepository.deleteOrphanedScanCursors(cutoff, live);

    return `deleted ${deleted} orphaned scan cursors (examined ${examined} older than ${ttlDays}d)`;
  }

  // Opportunity TTL is system-wide (not per-org) but per-PLATFORM, so this is
  // one updateMany per platform rather than one for everything. It is a durable
  // backstop for the opportunistic per-org sweep that also runs inline during an
  // active scan tick (engage-scan.activity.ts) — that sweep only fires for orgs
  // the scan happens to touch, so an org scanned exclusively via the extension
  // path (or not visited in a while) would otherwise never age its
  // opportunities out.
  //
  // Two clocks reach the same cutoff, and either one expires the row:
  //   • state.createdAt      — how long THIS org has held the opportunity
  //   • postPublishedAt      — how old the underlying post itself is
  // The second matches the ingest gate, which refuses to persist a post already
  // published before the cutoff; without it a post ingested just inside the
  // window would live up to twice its TTL.
  private async _expireStaleOpportunities(): Promise<string> {
    const ttlDays = await this._scanConfig.getOpportunityTtlDaysMap();
    const now = Date.now();

    let total = 0;
    const parts: string[] = [];
    for (const platform of SCANNABLE_PLATFORMS) {
      const cutoff = opportunityExpiryCutoff(platform, ttlDays, now);
      if (!cutoff) continue;
      const { count } = await this._oppState.model.engageOpportunityState.updateMany({
        where: {
          status: 'NEW',
          opportunity: { platform },
          OR: [
            { createdAt: { lt: cutoff } },
            { opportunity: { postPublishedAt: { lt: cutoff } } },
          ],
        },
        data: { status: 'EXPIRED' },
      });
      total += count;
      if (count) parts.push(`${platform}=${count}@${ttlDays[platform]}d`);
    }

    // Catch-all for rows whose platform is no longer scannable (a platform
    // retired from SCANNABLE_PLATFORMS still has stored opportunities). Without
    // it those rows would sit in NEW forever now that the sweep is per-platform.
    const legacyCutoff = dayjs.utc().subtract(DEFAULT_OPPORTUNITY_TTL_DAYS, 'day').toDate();
    const { count: orphaned } =
      await this._oppState.model.engageOpportunityState.updateMany({
        where: {
          status: 'NEW',
          opportunity: { platform: { notIn: [...SCANNABLE_PLATFORMS] } },
          OR: [
            { createdAt: { lt: legacyCutoff } },
            { opportunity: { postPublishedAt: { lt: legacyCutoff } } },
          ],
        },
        data: { status: 'EXPIRED' },
      });
    total += orphaned;
    if (orphaned) parts.push(`other=${orphaned}@${DEFAULT_OPPORTUNITY_TTL_DAYS}d`);

    return `expired ${total} stale NEW opportunities${parts.length ? ` (${parts.join(', ')})` : ''}`;
  }
}

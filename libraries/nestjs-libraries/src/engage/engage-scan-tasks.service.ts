import { Injectable, Logger } from '@nestjs/common';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';
import {
  EngageScanLeaseService,
  normalizeKeyword,
  normalizeUsername,
  ScanCursorSnapshot,
} from '@gitroom/nestjs-libraries/engage/engage-scan-lease.service';
import { EngageScanIngestService } from '@gitroom/nestjs-libraries/engage/engage-scan-ingest.service';
import {
  EngageScanConfigService,
  EngageScanPacing,
  ScanPlatform,
} from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';
import { EngageEntitlementService } from '@gitroom/nestjs-libraries/engage/engage-entitlement.service';
import { RawPost } from '@gitroom/nestjs-libraries/engage/engage-scorer';
import {
  EngageScanTask,
  ScanTaskPlatform,
  ScanTaskType,
} from '@gitroom/nestjs-libraries/engage/scan/scan-task.types';

// Platforms the extension can scan. Keyword units fan out to each (a keyword has
// no platform of its own); channel/tracked carry their own platform.
const SCAN_PLATFORMS: ScanTaskPlatform[] = (
  process.env.ENGAGE_SUPPORTED_PLATFORMS ?? 'x,reddit'
)
  .split(',')
  .map((p) => p.trim().toLowerCase())
  .filter((p): p is ScanTaskPlatform => p === 'x' || p === 'reddit');

// Default batch size handed back per call — small so a browser never over-leases
// units it won't get to (a stuck lease only frees on the stale-reclaim TTL).
const DEFAULT_WANT = 2;
const MAX_WANT = 5;

export interface CompletedUnitInput {
  taskId: string;
  posts: RawPost[];
  nextCursor?: { lastSeenExternalId?: string | null; lastSeenAt?: Date | null };
  exhausted?: boolean;
}

/**
 * Drives the extension scan loop: a single entry point that (optionally)
 * INGESTS a completed unit's posts and then CLAIMS the next batch of due units
 * for this org. The returned tasks are computed at call time, so any unit
 * another browser (or the workflow) just scanned is already excluded — the
 * cross-org dedup the whole design hinges on.
 */
@Injectable()
export class EngageScanTasksService {
  private readonly logger = new Logger(EngageScanTasksService.name);

  constructor(
    private readonly _engageRepo: EngageRepository,
    private readonly _lease: EngageScanLeaseService,
    private readonly _ingest: EngageScanIngestService,
    private readonly _config: EngageScanConfigService,
    private readonly _entitlement: EngageEntitlementService
  ) {}

  /**
   * Back-attribute existing global opportunities to this org without any
   * platform fetch — the cross-org "initial" path. Call when an org newly
   * subscribes (engage setup / keyword|channel|tracked added) so its feed
   * immediately reflects opportunities other orgs already populated, rather than
   * waiting for the next incremental scan to surface nothing. Returns the number
   * of per-org states written. No-op when the org has no enabled config.
   */
  async backfillFromExisting(
    orgId: string,
    opts: { windowDays?: number; limit?: number } = {}
  ): Promise<number> {
    const ctx = await this._engageRepo.getEnabledOrgContext(orgId);
    if (!ctx) return 0;

    const windowDays = opts.windowDays ?? (await this._entitlement.getMetricsWindowDays(orgId));
    const since = new Date(Date.now() - windowDays * 86_400_000);
    const platforms = SCAN_PLATFORMS as string[];
    const opportunities = await this._engageRepo.getRecentGlobalOpportunities(
      platforms,
      since,
      opts.limit ?? 1000
    );
    return this._ingest.attributeExisting(ctx as any, opportunities as any);
  }

  /** Complete (if any) + claim next batch. Bootstrap = call with no `completed`. */
  async sync(
    orgId: string,
    body: { completed?: CompletedUnitInput; want?: number }
  ): Promise<{ accepted: number; nextTasks: EngageScanTask[] }> {
    let accepted = 0;
    if (body.completed) {
      accepted = await this.ingestCompleted(body.completed);
    }
    const want = Math.min(Math.max(1, body.want ?? DEFAULT_WANT), MAX_WANT);
    const nextTasks = await this.claimNext(orgId, want);
    return { accepted, nextTasks };
  }

  /**
   * Ingest a completed unit: validate the lease token → fan out the posts to
   * every subscribing org (server-side keyword match + persist) → advance the
   * cursor (server-DERIVED, not trusting the client) and release the lease.
   */
  private async ingestCompleted(completed: CompletedUnitInput): Promise<number> {
    const unit = await this._engageRepo.findScanCursorByToken(completed.taskId);
    if (!unit) {
      // Invalid / expired / rotated token, or the lease was reclaimed — ignore.
      this.logger.warn(`Ingest with stale/invalid lease token; dropped`);
      return 0;
    }

    const posts = completed.posts ?? [];
    const nextCursor = this._deriveCursor(posts, completed.nextCursor);

    let ctxs;
    try {
      ctxs = await this._engageRepo.getOrgContextsForUnit(
        unit.platform,
        unit.scanType as 'keyword' | 'channel' | 'tracked',
        unit.scanKey
      );
    } catch (err) {
      // Could not even resolve subscribers — release WITHOUT advancing so the
      // unit is retried, rather than stranding the shared lease for the TTL.
      this.logger.error(
        `Scan ingest: subscriber resolution failed for ${unit.platform}/${unit.scanType}/${unit.scanKey}: ${(err as Error).message}`
      );
      await this._lease.releaseByToken(completed.taskId).catch(() => undefined);
      return 0;
    }

    // Isolate per org: one org's transient ingest failure (LLM/DB) must NOT abort
    // the whole fan-out or strand the SHARED global lease — others still persist,
    // and the cursor still advances + releases below.
    let accepted = 0;
    for (const ctx of ctxs) {
      try {
        accepted += await this._ingest.ingestForOrg(ctx as any, posts);
      } catch (err) {
        this.logger.error(
          `Scan ingest fan-out failed for org=${(ctx as any).organizationId}: ${(err as Error).message}`
        );
      }
    }

    await this._lease
      .completeByToken(completed.taskId, nextCursor)
      .catch(() => undefined);
    return accepted;
  }

  /** Enumerate this org's due units, claim up to `want`, build instructions. */
  private async claimNext(
    orgId: string,
    want: number
  ): Promise<EngageScanTask[]> {
    const ctx = await this._engageRepo.getEnabledOrgContext(orgId);
    if (!ctx) return [];

    const cadenceMs =
      (await this._entitlement.getScanIntervalHours(orgId)) * 3_600_000;
    const pacing = await this._config.getPacing();
    const units = this._enumerateUnits(ctx);

    const tasks: EngageScanTask[] = [];
    for (const u of units) {
      if (tasks.length >= want) break;
      const snap = await this._lease.claim({
        platform: u.platform,
        scanType: u.scanType,
        scanKey: u.scanKey,
        cadenceMs,
      });
      if (snap) tasks.push(this._buildTask(snap, pacing));
    }
    return tasks;
  }

  /** Org config → flat list of global scan units (keyword × platform, channel,
   * tracked). Keyword text is normalised to the global scanKey. */
  private _enumerateUnits(ctx: {
    keywords: { keyword: string; enabled: boolean }[];
    monitoredChannels: { platform: string; channelId: string }[];
    trackedAccounts: { platform: string; username: string }[];
  }): { platform: ScanTaskPlatform; scanType: ScanTaskType; scanKey: string }[] {
    const units: {
      platform: ScanTaskPlatform;
      scanType: ScanTaskType;
      scanKey: string;
    }[] = [];

    // ENGAGE_SUPPORTED_PLATFORMS is a hard allowlist that gates EVERY unit type
    // (keyword/channel/tracked), so an operator can fully kill a platform — e.g.
    // `ENGAGE_SUPPORTED_PLATFORMS=reddit` to stop all X scanning (X via the
    // user's personal session is anti-automation-risky) without a code change.
    const supported = new Set<ScanTaskPlatform>(SCAN_PLATFORMS);

    for (const kw of ctx.keywords) {
      if (!kw.enabled) continue;
      const scanKey = normalizeKeyword(kw.keyword);
      if (!scanKey) continue;
      for (const platform of SCAN_PLATFORMS) {
        units.push({ platform, scanType: 'keyword', scanKey });
      }
    }
    for (const c of ctx.monitoredChannels) {
      if (
        (c.platform === 'x' || c.platform === 'reddit') &&
        supported.has(c.platform)
      ) {
        units.push({
          platform: c.platform,
          scanType: 'channel',
          scanKey: c.channelId,
        });
      }
    }
    for (const a of ctx.trackedAccounts) {
      if (
        (a.platform === 'x' || a.platform === 'reddit') &&
        supported.has(a.platform)
      ) {
        units.push({
          platform: a.platform,
          scanType: 'tracked',
          // Normalized so this shares ONE cursor with the workflow writer + the
          // status reader (they all key tracked accounts via normalizeUsername).
          scanKey: normalizeUsername(a.platform, a.username),
        });
      }
    }
    return units;
  }

  /** Build the client instruction from a claimed snapshot + pacing config. */
  private _buildTask(
    snap: ScanCursorSnapshot,
    pacing: EngageScanPacing
  ): EngageScanTask {
    const platform = snap.platform as ScanPlatform;
    // First scan of a unit (no cursor yet) does the deeper "initial" lookback.
    const phase =
      snap.lastSeenExternalId || snap.lastSeenAt ? 'incremental' : 'initial';
    const page = pacing.extension[platform][phase];
    return {
      taskId: snap.leaseToken, // the client only ever sees the rotating token
      platform: snap.platform as ScanTaskPlatform,
      scanType: snap.scanType as ScanTaskType,
      scanKey: snap.scanKey,
      cursor: {
        lastSeenExternalId: snap.lastSeenExternalId,
        lastSeenAt: snap.lastSeenAt ? snap.lastSeenAt.toISOString() : null,
      },
      pacing: {
        maxPages: page.maxPages,
        pageSize: page.pageSize,
        pageDelayMs: page.pageDelayMs,
        pageJitterMs: page.jitterMs,
        interUnitDelayMs: pacing.extension.interUnit.delayMs,
        interUnitJitterMs: pacing.extension.interUnit.jitterMs,
        hourlyRequestCap: pacing.extension.session.hourlyRequestCap,
      },
    };
  }

  /**
   * Server-side cursor derivation: the newest post the extension returned (by
   * publish time) becomes the resume point. NEVER trusts a client-sent cursor to
   * move PAST that — a malicious client must not be able to advance the cursor
   * beyond real data and skip posts. The client cursor is only used to fill a
   * gap when no posts were returned (incremental no-op).
   */
  private _deriveCursor(
    posts: RawPost[],
    clientCursor?: { lastSeenExternalId?: string | null; lastSeenAt?: Date | null },
    now: number = Date.now()
  ): { lastSeenExternalId: string | null; lastSeenAt: Date | null } {
    // Only NON-FUTURE posts may advance the cursor. The shared global cursor is
    // resumed from `lastSeenExternalId`/`lastSeenAt`; a forged future-dated post
    // (client-controlled postPublishedAt) would otherwise jump the cursor past
    // real data and make every other org's next incremental scan skip genuine
    // posts. Future-dated entries are ignored entirely (id AND timestamp).
    const eligible = posts.filter((p) => p.postPublishedAt.getTime() <= now);
    if (eligible.length) {
      let newest = eligible[0];
      for (const p of eligible) {
        if (p.postPublishedAt > newest.postPublishedAt) newest = p;
      }
      return {
        lastSeenExternalId: newest.externalPostId,
        lastSeenAt: newest.postPublishedAt,
      };
    }
    // No eligible (non-future) posts → do not advance from posts.
    return {
      lastSeenExternalId: clientCursor?.lastSeenExternalId ?? null,
      lastSeenAt: clientCursor?.lastSeenAt ?? null,
    };
  }
}

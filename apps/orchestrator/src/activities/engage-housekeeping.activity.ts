import { Injectable, Logger } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  DEFAULT_OPPORTUNITY_TTL_DAYS,
  EngageScanConfigService,
  SCANNABLE_PLATFORMS,
  opportunityExpiryCutoff,
} from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';
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
    private _scanConfig: EngageScanConfigService
  ) {}

  private get _jobs(): MaintenanceJob[] {
    return [
      {
        key: 'engage-opportunity-expiry',
        run: () => this._expireStaleOpportunities(),
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

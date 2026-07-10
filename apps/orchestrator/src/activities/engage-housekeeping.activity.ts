import { Injectable, Logger } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { EngageScanConfigService } from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';
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

  // Opportunity TTL is a single system-wide setting (not per-org), so one
  // global updateMany covers every org. This is a durable backstop for the
  // opportunistic per-org sweep that also runs inline during an active scan
  // tick (engage-scan.activity.ts) — that sweep only fires for orgs the scan
  // happens to touch, so an org scanned exclusively via the extension path (or
  // not visited in a while) would otherwise never age its opportunities out.
  private async _expireStaleOpportunities(): Promise<string> {
    const ttlDays = await this._scanConfig.getOpportunityTtlDays();
    const cutoff = dayjs.utc().subtract(ttlDays, 'day').toDate();
    const { count } = await this._oppState.model.engageOpportunityState.updateMany({
      where: { status: 'NEW', createdAt: { lt: cutoff } },
      data: { status: 'EXPIRED' },
    });
    return `expired ${count} stale NEW opportunities (ttlDays=${ttlDays})`;
  }
}

import { Global, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';

@Injectable()
export class InfiniteWorkflowRegister implements OnModuleInit {
  constructor(private _temporalService: TemporalService) {}

  async onModuleInit(): Promise<void> {
    if (!!process.env.RUN_CRON) {
      const client = this._temporalService.client?.getRawClient();
      if (!client) return;

      // Start infinite workflows with USE_EXISTING to avoid restarting already running ones
      // Engage scan and post/engage metrics are now PURELY EVENT-DRIVEN (page
      // visit / extension submission), so there are no scheduled analytics jobs
      // here. The former daily aggregators (dataTicksSyncWorkflow /
      // engageDataTicksWorkflow) were removed; their capabilities remain on
      // demand via the admin endpoints (DataTicksService.syncDailyTicks) and
      // scripts/backfill-engage-data-ticks.ts. engageHousekeepingCronWorkflow
      // below is the one deliberate exception: it only does cheap, all-DB
      // hygiene (no upstream API calls), so a plain wall-clock tick is correct
      // there (and it bounds its own event history via continueAsNew).
      const infiniteWorkflows = [
        { workflowId: 'missing-post-workflow', name: 'missingPostWorkflow' },
        { workflowId: 'refresh-workflow-recovery', name: 'refreshWorkflowRecoveryWorkflow' },
        // Hourly engage DB-housekeeping cron (currently: engage opportunity TTL
        // expiry). Add new engage maintenance jobs to EngageHousekeepingActivity's
        // registry rather than adding another workflow here.
        { workflowId: 'engage-housekeeping-cron', name: 'engageHousekeepingCronWorkflow' },
      ];

      for (const wf of infiniteWorkflows) {
        try {
          await client.workflow?.start(wf.name, {
            workflowId: wf.workflowId,
            taskQueue: 'main',
            workflowIdConflictPolicy: 'USE_EXISTING',
          });
        } catch (err) {
          console.error(`Failed to start ${wf.name}:`, err);
        }
      }
    }
  }
}

@Global()
@Module({
  imports: [],
  controllers: [],
  providers: [InfiniteWorkflowRegister],
  get exports() {
    return this.providers;
  },
})
export class InfiniteWorkflowRegisterModule {}

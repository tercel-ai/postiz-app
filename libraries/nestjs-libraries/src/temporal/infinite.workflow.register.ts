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
      const infiniteWorkflows = [
        { workflowId: 'missing-post-workflow', name: 'missingPostWorkflow' },
        { workflowId: 'refresh-workflow-recovery', name: 'refreshWorkflowRecoveryWorkflow' },
        // Post analytics sync: disabled by default; set POST_ANALYSE_ENABLE=true to enable.
        ...(process.env.POST_ANALYSE_ENABLE === 'true'
          ? [{ workflowId: 'data-ticks-sync-workflow', name: 'dataTicksSyncWorkflow' }]
          : []),
        // Engage: daily aggregation of EngageDataTicks (all orgs, global singleton).
        // DISABLED by default — EngageDataTicks is currently write-only (the dashboard
        // endpoints read the Post table directly for same-day freshness), so this job
        // produces no read value. The aggregate is a pure derivation of Post keyed by
        // publishDate and is fully backfillable on demand via
        // scripts/backfill-engage-data-ticks.ts. Set ENGAGE_DATA_TICKS=true to re-enable
        // (only needed once historical Post rows are pruned, or a true long-horizon
        // retention store is required).
        ...(process.env.ENGAGE_DATA_TICKS === 'true'
          ? [{ workflowId: 'engage-data-ticks-workflow', name: 'engageDataTicksWorkflow' }]
          : []),
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

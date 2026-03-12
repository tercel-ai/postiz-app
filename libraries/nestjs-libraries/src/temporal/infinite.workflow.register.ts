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
        { workflowId: 'data-ticks-sync-workflow', name: 'dataTicksSyncWorkflow' },
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

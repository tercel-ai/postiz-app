import { TemporalModule } from 'nestjs-temporal-core';
import { socialIntegrationList } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import {
  SOCIAL_MERGED_TASK_QUEUE,
  computeRootWorkerSpecs,
  getEnabledProviderAllowlist,
  getTemporalWorkerMode,
  isProviderEnabled,
} from '@gitroom/nestjs-libraries/temporal/task-queue';

export const getTemporalModule = (
  isWorkers: boolean,
  path?: string,
  activityClasses?: any[]
) => {
  const mode = getTemporalWorkerMode();
  const allowlist = getEnabledProviderAllowlist();
  const enabledProviders = socialIntegrationList.filter((p) =>
    isProviderEnabled(p.identifier, allowlist)
  );

  if (isWorkers) {
    const enabledList = allowlist
      ? enabledProviders.map((p) => p.identifier).join(', ') || '<none>'
      : 'all';
    // eslint-disable-next-line no-console
    console.log(
      `[Temporal] Worker mode=${mode}, enabled providers: ${enabledList}`
    );
  }

  const mainWorker = {
    taskQueue: 'main',
    workflowsPath: path!,
    activityClasses: activityClasses!,
    autoStart: true,
  };

  const rootWorkerSpecs = computeRootWorkerSpecs(enabledProviders);

  const socialWorkers =
    mode === 'per-provider'
      ? Array.from(rootWorkerSpecs.entries()).map(([root, spec]) => ({
          taskQueue: root,
          workflowsPath: path!,
          activityClasses: activityClasses!,
          autoStart: true,
          ...(spec.maxConcurrentJob
            ? {
                workerOptions: {
                  maxConcurrentActivityTaskExecutions: spec.maxConcurrentJob,
                },
              }
            : {}),
        }))
      : [
          {
            taskQueue: SOCIAL_MERGED_TASK_QUEUE,
            workflowsPath: path!,
            activityClasses: activityClasses!,
            autoStart: true,
            workerOptions: {
              // Sum of enabled providers' maxConcurrentJob; per-provider rate
              // limiting must be enforced elsewhere if needed.
              maxConcurrentActivityTaskExecutions:
                enabledProviders.reduce(
                  (sum, integration) =>
                    sum + (integration.maxConcurrentJob || 1),
                  0
                ) || 10,
            },
          },
        ];

  return TemporalModule.register({
    isGlobal: true,
    connection: {
      address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
      namespace: process.env.TEMPORAL_NAMESPACE || 'default',
    },
    taskQueue: 'main',
    logLevel: 'error',
    ...(isWorkers ? { workers: [mainWorker, ...socialWorkers] } : {}),
  });
};

import { proxyActivities, sleep } from '@temporalio/workflow';
import { IntegrationsActivity } from '@gitroom/orchestrator/activities/integrations.activity';

const { getIntegrationsById, refreshToken, restartLostRefreshWorkflows } =
  proxyActivities<IntegrationsActivity>({
    startToCloseTimeout: '10 minute',
    retry: {
      maximumAttempts: 3,
      backoffCoefficient: 1,
      initialInterval: '2 minutes',
    },
  });

export async function refreshTokenWorkflow({
  organizationId,
  integrationId,
}: {
  integrationId: string;
  organizationId: string;
}) {
  while (true) {
    let integration = await getIntegrationsById(integrationId, organizationId);
    if (
      !integration ||
      integration.deletedAt ||
      integration.inBetweenSteps ||
      integration.refreshNeeded
    ) {
      return false;
    }

    // Permanent tokens (e.g. OAuth 1.0a) have no tokenExpiration. There is
    // nothing to refresh — exit cleanly so the workflow doesn't loop forever.
    if (!integration.tokenExpiration) {
      return false;
    }

    const today = new Date();
    const endDate = new Date(integration.tokenExpiration);

    // Refresh 5 minutes before expiry to avoid clock skew / scheduling jitter.
    const REFRESH_BUFFER_MS = 5 * 60 * 1000;
    const minMax = Math.max(0, endDate.getTime() - today.getTime() - REFRESH_BUFFER_MS);
    if (minMax > 0) {
      await sleep(minMax);
    }
    // If minMax === 0 the token is already expired or within the buffer window —
    // fall through and refresh immediately. refreshProcess will set refreshNeeded
    // if the token is genuinely dead.

    // while we were sleeping, the integration might have been deleted
    integration = await getIntegrationsById(integrationId, organizationId);
    if (
      !integration ||
      integration.deletedAt ||
      integration.inBetweenSteps ||
      integration.refreshNeeded
    ) {
      return false;
    }

    try {
      await refreshToken(integration);
    } catch (err) {
      // The activity failed after all Temporal retries (transient: DB outage,
      // network error, etc.). Do NOT let the workflow enter FAILED state — a
      // permanently failed workflow is never auto-restarted by Temporal, which
      // would leave the token expired forever.
      //
      // Instead, sleep and retry on the next loop iteration:
      //   - If the failure was transient, the next attempt will succeed.
      //   - If refreshProcess managed to set refreshNeeded=true before the
      //     error, the loop guard above will exit cleanly on the next iteration.
      console.warn(
        `[refreshTokenWorkflow] refreshToken activity failed for integration=${integrationId}. Will retry after 10 min. Error: ${(err as any)?.cause?.message || (err as any)?.message || err}`
      );
      await sleep('10 minutes');
    }
  }
}

// Recovery workflow: scan for integrations whose refreshTokenWorkflow has
// silently died (workflow FAILED / never started) and restart them.
// Runs on the same infinite-workflow cadence as missingPostWorkflow (hourly).
export async function refreshWorkflowRecoveryWorkflow() {
  await restartLostRefreshWorkflows();
  while (true) {
    await sleep('1 hour');
    await restartLostRefreshWorkflows();
  }
}

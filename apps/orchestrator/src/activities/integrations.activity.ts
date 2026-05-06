import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { Integration } from '@prisma/client';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';

@Injectable()
@Activity()
export class IntegrationsActivity {
  constructor(
    private _integrationService: IntegrationService,
    private _integrationManager: IntegrationManager,
    private _refreshIntegrationService: RefreshIntegrationService
  ) {}

  @ActivityMethod()
  async getIntegrationsById(id: string, orgId: string) {
    return this._integrationService.getIntegrationById(orgId, id);
  }

  @ActivityMethod()
  async refreshToken(integration: Integration) {
    return this._refreshIntegrationService.refresh(integration);
  }

  /**
   * Recovery scan: find integrations whose refreshTokenWorkflow has silently
   * died (workflow FAILED / never started) and restart it.
   * Runs hourly from refreshWorkflowRecoveryWorkflow.
   */
  @ActivityMethod()
  async restartLostRefreshWorkflows(): Promise<void> {
    const integrations = await this._integrationService.getIntegrationsNeedingRefreshWorkflow();
    for (const integration of integrations) {
      const provider = this._integrationManager.getSocialIntegration(
        integration.providerIdentifier
      );
      if (!provider?.refreshCron) continue;
      try {
        // USE_EXISTING: don't terminate a workflow that's already running correctly —
        // only start one if there's no running workflow (i.e., it FAILED or was never started).
        await this._refreshIntegrationService.startRefreshWorkflow(
          integration.organizationId,
          integration.id,
          provider,
          'USE_EXISTING'
        );
      } catch (err) {
        console.warn(
          `[refreshRecovery] failed to restart workflow for integration=${integration.id}: ${(err as Error)?.message || err}`
        );
      }
    }
  }
}

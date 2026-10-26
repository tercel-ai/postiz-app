import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { SendCoordinatorService } from '@gitroom/nestjs-libraries/extension/send-coordinator.service';
import { SendModeService } from '@gitroom/nestjs-libraries/extension/send-mode.service';
import { LegacyIdentityReconciliationService } from '@gitroom/nestjs-libraries/extension/legacy-identity-reconciliation.service';

@Injectable()
export class SendModeTransitionReconciliationService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(
    SendModeTransitionReconciliationService.name
  );
  private timer?: NodeJS.Timeout;
  private running = false;
  private identityTimer?: NodeJS.Timeout;
  private identityRunning = false;

  constructor(
    private readonly modes: SendModeService,
    private readonly coordinator: SendCoordinatorService,
    @Optional()
    private readonly identities?: LegacyIdentityReconciliationService
  ) {}

  onApplicationBootstrap(): void {
    const run = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.modes.reconcilePendingTransitions();
        for (const pending of await this.modes.pendingReallocations()) {
          try {
            const issues = await this.coordinator.reallocateUnsentLegacy(
              pending.organizationId,
              pending.userId
            );
            await this.modes.recordReallocationIssues(
              pending.organizationId,
              issues
            );
          } catch (error) {
            this.logger.error(
              `Sending mode reallocation failed for organization ${pending.organizationId}`,
              error instanceof Error ? error.stack : error
            );
          }
        }
      } catch (error) {
        this.logger.error(
          'Sending mode transition reconciliation failed',
          error instanceof Error ? error.stack : error
        );
      } finally {
        this.running = false;
      }
    };
    void run();
    this.timer = setInterval(() => void run(), 15_000);
    this.timer.unref();

    const identities = this.identities;
    if (identities) {
      const reconcileIdentities = async () => {
        if (this.identityRunning) return;
        this.identityRunning = true;
        try {
          await identities.reconcilePendingControlledOrganizations();
        } catch (error) {
          this.logger.error(
            'Legacy identity reconciliation failed',
            error instanceof Error ? error.stack : error
          );
        } finally {
          this.identityRunning = false;
        }
      };
      void reconcileIdentities();
      this.identityTimer = setInterval(
        () => void reconcileIdentities(),
        15_000
      );
      this.identityTimer.unref();
    }
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.identityTimer) clearInterval(this.identityTimer);
  }
}

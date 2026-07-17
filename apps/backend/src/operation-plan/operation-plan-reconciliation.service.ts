import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { OperationPlanService } from '@gitroom/nestjs-libraries/database/prisma/operation-plan/operation-plan.service';

@Injectable()
export class OperationPlanReconciliationService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OperationPlanReconciliationService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly operationPlanService: OperationPlanService) {}

  onApplicationBootstrap(): void {
    const intervalMs = Number(
      process.env.OPERATION_PLAN_RECONCILIATION_INTERVAL_MS ?? 60_000
    );
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    const run = () => {
      this.operationPlanService.reconcileBillingPending().catch((error) => {
        this.logger.error(
          'Operation plan billing reconciliation failed',
          error instanceof Error ? error.stack : error
        );
      });
    };
    run();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

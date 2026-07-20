import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { OperationPlanService } from '@gitroom/nestjs-libraries/database/prisma/operation-plan/operation-plan.service';

// Re-drives operation-plan rows stuck in GENERATING — the background generate +
// bill job never advanced them past the initial stub (worker crash, interrupted
// deploy). Mirrors OperationPlanReconciliationService (setInterval on boot), but
// for the GENERATING stage rather than BILLING_PENDING.
@Injectable()
export class OperationPlanGenerationSweeperService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OperationPlanGenerationSweeperService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly operationPlanService: OperationPlanService) {}

  onApplicationBootstrap(): void {
    const intervalMs = Number(
      process.env.OPERATION_PLAN_GENERATION_SWEEP_INTERVAL_MS ?? 60_000
    );
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    // A row must sit untouched this long before it is considered stuck. This MUST
    // exceed the worst-case generation time, or the sweep would re-drive a plan
    // that is merely slow (double LLM cost; billing stays deduped by the
    // operation_plan:{id} key). Generation is bounded to (maxRetries + 1) × timeout
    // = 2 × 8min = 16min (see OPERATION_PLAN_GEN_TIMEOUT_MS / _MAX_RETRIES), so
    // 20min stays safely above it. If you loosen that bound, raise this too.
    const staleMs = Number(
      process.env.OPERATION_PLAN_GENERATION_STALE_MS ?? 1_200_000
    );
    const run = () => {
      this.operationPlanService.resumeStuckGenerations(staleMs).catch((error) => {
        this.logger.error(
          'Operation plan generation sweep failed',
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

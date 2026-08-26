import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { OperationPlanService } from '@gitroom/nestjs-libraries/database/prisma/operation-plan/operation-plan.service';

// Re-drives operation-plan rows stuck READY with no materialized Posts, or
// with Posts that materialized but never got auto-committed — the status
// write and _materializePlanPosts (create -> align -> auto-commit) are
// separate awaits with no transaction between them, so a worker crash (or
// interrupted deploy) anywhere in that sequence can leave a plan permanently
// short of what it should have produced. Mirrors
// OperationPlanGenerationSweeperService / OperationPlanReconciliationService
// (setInterval on boot), but for this third stuck state.
@Injectable()
export class OperationPlanMaterializationSweeperService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OperationPlanMaterializationSweeperService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly operationPlanService: OperationPlanService) {}

  onApplicationBootstrap(): void {
    const intervalMs = Number(
      process.env.OPERATION_PLAN_MATERIALIZATION_SWEEP_INTERVAL_MS ?? 60_000
    );
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    // A row must sit READY-with-no-posts this long before it is considered
    // stuck. Materialization itself (one createMany + best-effort alignment)
    // is fast, but the auto-commit it now also runs can start one Temporal
    // workflow per post for a large plan — this MUST stay comfortably above
    // that worst case, or the sweep would race a merely-slow commit still in
    // flight rather than a genuinely crashed one. 10 minutes is a wide margin
    // over what materialize+align+commit should ever actually take.
    const staleMs = Number(
      process.env.OPERATION_PLAN_MATERIALIZATION_STALE_MS ?? 600_000
    );
    // Upper bound on how far back automatic retry reaches. A plan that
    // materialized+committed successfully never touches `updatedAt` again, so
    // without this cap the sweep's oldest-first, limited-take query would fill
    // up forever with old, perfectly-fine plans and never reach a newly-stuck
    // one — see findStaleReadyPlans. 48h is generous enough to survive an
    // extended outage while still keeping the "no action needed" backlog
    // bounded; a plan that stays stuck with DRAFT posts past this age is
    // treated as legitimately not-yet-automated, not crashed, and falls back
    // to the existing manual paths (toggling Automation, an explicit commit).
    const maxAgeMs = Number(
      process.env.OPERATION_PLAN_MATERIALIZATION_MAX_AGE_MS ?? 172_800_000
    );
    const run = () => {
      this.operationPlanService.resumeIncompleteMaterializations(staleMs, maxAgeMs).catch((error) => {
        this.logger.error(
          'Operation plan materialization sweep failed',
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

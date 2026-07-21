-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: allow multiple OperationPlans per task.
--
-- Originally a task could own at most one plan, enforced by
-- UNIQUE(organizationId, taskId) (see operation-plan.sql). The product now
-- supports re-planning the same task with different parameters (project /
-- startsAt / endsAt / platforms), each producing a brand-new plan that
-- coexists with the earlier ones. Same-parameter idempotency (retry-safety) is
-- enforced in application code — OperationPlanService.create reuses an existing
-- plan only when every parameter matches — so the DB no longer needs the unique
-- guard. We keep a plain index for the by-task lookup.
--
-- NOTE: the schema is applied via `prisma db push`; this file is the manual
-- record of the change, matching the convention of the other files here.
-- ─────────────────────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS "OperationPlan_organizationId_taskId_key";

CREATE INDEX IF NOT EXISTS "OperationPlan_organizationId_taskId_idx"
  ON "OperationPlan"("organizationId", "taskId");

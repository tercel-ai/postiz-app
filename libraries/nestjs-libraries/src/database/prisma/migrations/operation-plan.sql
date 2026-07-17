-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: OperationPlan and campaign attribution on Post
-- (aisee-live-geo-growth-plan.md §5).
--
-- No aiseeUserId column: billing calls resolve the org's Aisee user on demand
-- via AiseeCreditService.resolveOwnerUserId(organizationId), matching every
-- other billing-related table in this codebase. No idempotencyKey column:
-- taskId already serves that role via UNIQUE(organizationId, taskId). No
-- durationDays column on either table: derivable from startsAt/endsAt (also
-- preserved, unparsed, in planPayload). No billingTaskId column: it is the
-- deterministic string `operation_plan:${id}`, computed wherever needed.
--
-- Order: OperationPlan (new table) → Post (alter existing, FK to OperationPlan).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE "OperationPlanStatus" AS ENUM ('GENERATING', 'BILLING_PENDING', 'READY', 'BILLING_FAILED', 'FAILED');

CREATE TABLE IF NOT EXISTS "OperationPlan" (
  "id"                   TEXT NOT NULL,
  "organizationId"       TEXT NOT NULL,
  "projectId"            TEXT NOT NULL,
  "taskId"               TEXT NOT NULL,
  "sourceTaskVersion"    TEXT,
  "platforms"            TEXT[] NOT NULL,
  "generatorVersion"     TEXT NOT NULL,
  "campaignId"           TEXT NOT NULL,
  "startsAt"             TIMESTAMP(3) NOT NULL,
  "endsAt"               TIMESTAMP(3) NOT NULL,
  "status"               "OperationPlanStatus" NOT NULL DEFAULT 'GENERATING',
  "planPayload"          JSONB NOT NULL,
  "sourceResultHash"     TEXT NOT NULL,
  "billingTransactionId" TEXT,
  "creditAmount"         TEXT,
  "errorCode"            TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OperationPlan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OperationPlan_organizationId_taskId_key"
  ON "OperationPlan"("organizationId", "taskId");

CREATE INDEX IF NOT EXISTS "OperationPlan_organizationId_projectId_idx"
  ON "OperationPlan"("organizationId", "projectId");

CREATE INDEX IF NOT EXISTS "OperationPlan_campaignId_idx"
  ON "OperationPlan"("campaignId");

ALTER TABLE "OperationPlan"
  ADD CONSTRAINT "OperationPlan_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Post: two attribution columns only. projectId is the project-scoping filter
-- (also used by manual project posts with no operationPlanId), operationPlanId
-- links a generated post to its plan. Other campaign metadata (campaignId,
-- campaignDayIndex, campaignTag, themeKey) lives in the existing
-- Post.settings JSON, not columns; taskId is derivable via operationPlanId ->
-- OperationPlan.taskId; sourceScore stays only in OperationPlan.planPayload.
-- None are stored on Post as columns. Both new columns nullable — ordinary
-- posts are unaffected.
ALTER TABLE "Post"
  ADD COLUMN IF NOT EXISTS "projectId" TEXT,
  ADD COLUMN IF NOT EXISTS "operationPlanId" TEXT;

-- No DB-level (campaign, day, integration) unique index — campaignDayIndex lives
-- in settings JSON. Idempotent materialization is enforced by the generation
-- service (check-before-insert keyed by operationPlanId + settings.campaignDayIndex
-- + integrationId).
CREATE INDEX IF NOT EXISTS "Post_projectId_idx"
  ON "Post"("projectId");

CREATE INDEX IF NOT EXISTS "Post_operationPlanId_idx"
  ON "Post"("operationPlanId");

ALTER TABLE "Post"
  ADD CONSTRAINT "Post_operationPlanId_fkey"
  FOREIGN KEY ("operationPlanId") REFERENCES "OperationPlan"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

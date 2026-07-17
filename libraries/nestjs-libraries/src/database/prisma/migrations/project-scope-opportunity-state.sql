-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: project-scope EngageOpportunityState
-- (project-scoped-post-engage-design.md §3.3).
--
-- EngageOpportunityState swaps its composite PRIMARY KEY (organizationId,
-- opportunityId) for a surrogate `id` PK plus a
-- UNIQUE(organizationId, projectId, opportunityId) index. A primary key column
-- cannot be nullable, and projectId must stay nullable through the backfill
-- (design doc §11 step 3) — Postgres unique indexes, unlike PKs, tolerate
-- multiple NULL projectId rows, which is what lets a legacy row and later
-- per-project rows for the same (organizationId, opportunityId) coexist.
-- Collapse to a true composite PK once projectId is required (§11 step 8).
--
-- No per-keyword hit ledger (EngageKeywordHit was cut): matchedKeywords (already
-- on this table) is the single source for per-keyword supply analytics, rebuilt
-- wholesale each re-scan; isCurrentlyMatched drives eligibleCount as a single-
-- table COUNT.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Surrogate id, backfilled for existing rows.
ALTER TABLE "EngageOpportunityState" ADD COLUMN IF NOT EXISTS "id" TEXT;
UPDATE "EngageOpportunityState" SET "id" = gen_random_uuid()::text WHERE "id" IS NULL;
ALTER TABLE "EngageOpportunityState" ALTER COLUMN "id" SET NOT NULL;

-- 2. New scoped columns.
ALTER TABLE "EngageOpportunityState"
  ADD COLUMN IF NOT EXISTS "projectId" TEXT,
  ADD COLUMN IF NOT EXISTS "isCurrentlyMatched" BOOLEAN NOT NULL DEFAULT true;

-- 3. Swap the PK for a surrogate id, add the scoped unique index.
ALTER TABLE "EngageOpportunityState" DROP CONSTRAINT "EngageOpportunityState_pkey";
ALTER TABLE "EngageOpportunityState" ADD CONSTRAINT "EngageOpportunityState_pkey" PRIMARY KEY ("id");

CREATE UNIQUE INDEX IF NOT EXISTS "EngageOpportunityState_organizationId_projectId_opportunit_key"
  ON "EngageOpportunityState"("organizationId", "projectId", "opportunityId");

CREATE INDEX IF NOT EXISTS "EngageOpportunityState_organizationId_projectId_idx"
  ON "EngageOpportunityState"("organizationId", "projectId");

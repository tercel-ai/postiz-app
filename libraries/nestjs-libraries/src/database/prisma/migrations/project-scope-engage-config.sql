-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: project-scope EngageConfig, EngageKeyword, EngageXReplyAccount
-- (project-scoped-post-engage-design.md §3.1).
--
-- projectId is added NULLABLE. Existing rows keep projectId = NULL until the
-- backfill step (design doc §11 step 3) assigns each a legacy/default project.
-- Do not require projectId NOT NULL until that backfill has run.
-- ─────────────────────────────────────────────────────────────────────────────

-- EngageConfig: allow multiple projects per org.
ALTER TABLE "EngageConfig"
  ADD COLUMN IF NOT EXISTS "projectId" TEXT;

DROP INDEX IF EXISTS "EngageConfig_organizationId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "EngageConfig_organizationId_projectId_key"
  ON "EngageConfig"("organizationId", "projectId");

CREATE INDEX IF NOT EXISTS "EngageConfig_organizationId_idx"
  ON "EngageConfig"("organizationId");

-- EngageXReplyAccount: an integration may now belong to more than one project's
-- reply-account list. Cross-project duplicate-reply prevention is deferred with
-- EngageReplyClaim (§3.5), not enforced on this table.
DROP INDEX IF EXISTS "EngageXReplyAccount_integrationId_key";

CREATE INDEX IF NOT EXISTS "EngageXReplyAccount_integrationId_idx"
  ON "EngageXReplyAccount"("integrationId");

-- Engage post-content trigram index.
--
-- `prisma db push` (the project's provisioning workflow — see package.json
-- "prisma-db-push") only materializes schema-declared objects. It cannot create
-- a pg_trgm extension or a gin_trgm_ops index, so this index — which backs the
-- ILIKE keyword preview in EngageRepository.getKeywordPosts against the GLOBAL
-- (cross-org, unbounded) EngageOpportunity table — must be created out-of-band.
--
-- This file is executed right after `prisma db push` via the "prisma-db-push"
-- npm script, so a fresh database provisioned by the documented workflow always
-- has the index. Idempotent — safe to run repeatedly.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "EngageOpportunity_postContent_trgm_idx"
  ON "EngageOpportunity" USING GIN ("postContent" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "EngageOpportunity_platform_externalPostUrl_idx"
  ON "EngageOpportunity"("platform", "externalPostUrl");

-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: split EngageOpportunity into global + per-org state tables.
--
-- Changes:
--   1. Rename EngageConfig.setupCompleted → enabled
--   2. Make EngageKeyword.type nullable (was NOT NULL DEFAULT 'CORE')
--   3. Add new columns to EngageOpportunity (authorAvatarUrl, metricBookmarks,
--      metricViews, metricShares, metricSaves, rawData)
--   4. Create EngageOpportunityState (per-org: status, bookmarked, score,
--      scoreKeyword, scoreTracked)
--   5. Migrate per-org columns from EngageOpportunity → EngageOpportunityState
--   6. Deduplicate EngageOpportunity to one global row per (platform, externalPostId)
--   7. Drop per-org columns + old unique/indexes; add new global unique
--   8. Update EngageSentReply unique constraint
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Rename setupCompleted to enabled
ALTER TABLE "EngageConfig" RENAME COLUMN "setupCompleted" TO "enabled";

-- 2. Make EngageKeyword.type nullable
ALTER TABLE "EngageKeyword" ALTER COLUMN "type" DROP NOT NULL;
ALTER TABLE "EngageKeyword" ALTER COLUMN "type" DROP DEFAULT;

-- 3. Add new columns to EngageOpportunity
ALTER TABLE "EngageOpportunity"
  ADD COLUMN IF NOT EXISTS "authorAvatarUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "metricBookmarks" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "metricViews"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "metricShares"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "metricSaves"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rawData"         JSONB;

-- 4. Create EngageOpportunityState
CREATE TABLE IF NOT EXISTS "EngageOpportunityState" (
  "organizationId" TEXT NOT NULL,
  "opportunityId"  TEXT NOT NULL,
  "status"         "EngageOpportunityStatus" NOT NULL DEFAULT 'NEW',
  "bookmarked"     BOOLEAN  NOT NULL DEFAULT false,
  "score"          INTEGER  NOT NULL DEFAULT 0,
  "scoreKeyword"   INTEGER  NOT NULL DEFAULT 0,
  "scoreTracked"   INTEGER  NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EngageOpportunityState_pkey" PRIMARY KEY ("organizationId","opportunityId")
);

-- 5. Migrate per-org data from old EngageOpportunity rows into EngageOpportunityState.
--    When the same externalPostId was stored once per org, we pick the highest-score
--    row per (platform, externalPostId) as the canonical global row and collect all
--    per-org state rows.
WITH canonical AS (
  SELECT DISTINCT ON (platform, "externalPostId")
    id   AS canonical_id,
    platform,
    "externalPostId"
  FROM "EngageOpportunity"
  ORDER BY platform, "externalPostId", score DESC, id
)
INSERT INTO "EngageOpportunityState"
  ("organizationId", "opportunityId", "status", "bookmarked",
   "score", "scoreKeyword", "scoreTracked", "createdAt", "updatedAt")
SELECT
  eo."organizationId",
  c.canonical_id,
  eo."status",
  eo."bookmarked",
  eo."score",
  eo."scoreKeyword",
  eo."scoreTracked",
  eo."createdAt",
  eo."updatedAt"
FROM "EngageOpportunity" eo
JOIN canonical c
  ON c.platform = eo.platform
 AND c."externalPostId" = eo."externalPostId"
ON CONFLICT DO NOTHING;

-- 6a. Re-point EngageSentReply to canonical opportunity ids (handles dedup).
WITH canonical AS (
  SELECT DISTINCT ON (platform, "externalPostId")
    id AS canonical_id,
    platform,
    "externalPostId"
  FROM "EngageOpportunity"
  ORDER BY platform, "externalPostId", score DESC, id
)
UPDATE "EngageSentReply" sr
SET "opportunityId" = c.canonical_id
FROM "EngageOpportunity" eo
JOIN canonical c
  ON c.platform = eo.platform
 AND c."externalPostId" = eo."externalPostId"
WHERE sr."opportunityId" = eo.id
  AND sr."opportunityId" <> c.canonical_id;

-- 6b. Delete non-canonical EngageOpportunity rows (safe: FKs updated above).
WITH canonical AS (
  SELECT DISTINCT ON (platform, "externalPostId")
    id
  FROM "EngageOpportunity"
  ORDER BY platform, "externalPostId", score DESC, id
)
DELETE FROM "EngageOpportunity"
WHERE id NOT IN (SELECT id FROM canonical);

-- 7a. Drop old FK and per-org indexes on EngageOpportunity.
ALTER TABLE "EngageOpportunity"
  DROP CONSTRAINT IF EXISTS "EngageOpportunity_organizationId_fkey";

DROP INDEX IF EXISTS "EngageOpportunity_organizationId_platform_externalPostId_key";
DROP INDEX IF EXISTS "EngageOpportunity_organizationId_idx";
DROP INDEX IF EXISTS "EngageOpportunity_organizationId_status_idx";
DROP INDEX IF EXISTS "EngageOpportunity_organizationId_platform_idx";
DROP INDEX IF EXISTS "EngageOpportunity_organizationId_score_idx";
DROP INDEX IF EXISTS "EngageOpportunity_organizationId_scoreKeyword_idx";
DROP INDEX IF EXISTS "EngageOpportunity_organizationId_scoreHeat_idx";
DROP INDEX IF EXISTS "EngageOpportunity_organizationId_scoreAuthority_idx";
DROP INDEX IF EXISTS "EngageOpportunity_organizationId_scoreTracked_idx";
DROP INDEX IF EXISTS "EngageOpportunity_organizationId_bookmarked_idx";
DROP INDEX IF EXISTS "EngageOpportunity_organizationId_postPublishedAt_idx";

-- 7b. Drop per-org columns from EngageOpportunity.
ALTER TABLE "EngageOpportunity"
  DROP COLUMN IF EXISTS "organizationId",
  DROP COLUMN IF EXISTS "status",
  DROP COLUMN IF EXISTS "bookmarked",
  DROP COLUMN IF EXISTS "score",
  DROP COLUMN IF EXISTS "scoreKeyword",
  DROP COLUMN IF EXISTS "scoreTracked",
  DROP COLUMN IF EXISTS "scoreBreakdown";

-- 7c. Add new global unique constraint and indexes.
CREATE UNIQUE INDEX IF NOT EXISTS "EngageOpportunity_platform_externalPostId_key"
  ON "EngageOpportunity"("platform", "externalPostId");

CREATE INDEX IF NOT EXISTS "EngageOpportunity_scoreHeat_idx"
  ON "EngageOpportunity"("scoreHeat");

CREATE INDEX IF NOT EXISTS "EngageOpportunity_scoreAuthority_idx"
  ON "EngageOpportunity"("scoreAuthority");

CREATE INDEX IF NOT EXISTS "EngageOpportunity_postPublishedAt_idx"
  ON "EngageOpportunity"("postPublishedAt");

CREATE INDEX "EngageOpportunity_intentTags_gin_idx"
  ON "EngageOpportunity" USING GIN ("intentTags");

-- 8. Add EngageOpportunityState FK constraints and indexes.
ALTER TABLE "EngageOpportunityState"
  ADD CONSTRAINT "EngageOpportunityState_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EngageOpportunityState"
  ADD CONSTRAINT "EngageOpportunityState_opportunityId_fkey"
    FOREIGN KEY ("opportunityId") REFERENCES "EngageOpportunity"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "EngageOpportunityState_organizationId_status_idx"
  ON "EngageOpportunityState"("organizationId", "status");

CREATE INDEX IF NOT EXISTS "EngageOpportunityState_organizationId_score_idx"
  ON "EngageOpportunityState"("organizationId", "score");

CREATE INDEX IF NOT EXISTS "EngageOpportunityState_organizationId_bookmarked_idx"
  ON "EngageOpportunityState"("organizationId", "bookmarked");

CREATE INDEX IF NOT EXISTS "EngageOpportunityState_opportunityId_idx"
  ON "EngageOpportunityState"("opportunityId");

-- 9. Update EngageSentReply unique constraint (was: one per opportunity globally,
--    now: one per org per opportunity so different orgs can each reply).
ALTER TABLE "EngageSentReply" DROP CONSTRAINT IF EXISTS "EngageSentReply_opportunityId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "EngageSentReply_organizationId_opportunityId_key"
  ON "EngageSentReply"("organizationId", "opportunityId");

-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: EngageSentReply project attribution + matched-keyword snapshot
-- (project-scoped-post-engage-design.md §3.3bis).
--
-- These two columns make daily reply-count checks (aggregate and per-keyword) a
-- single-table query, so no separate per-day plan/counter table is needed. Daily
-- reply TARGETS are not stored in a table at all — they live in
-- OperationPlan.planPayload and are read at execution time (see §3.4).
--
-- Cut from an earlier draft of this migration (never applied): EngageReplyPolicy
-- (targets → now read from planPayload), EngageIntegrationCapacityBucket +
-- EngageReplyAllocationSlot (cross-project capacity coordination → deferred with
-- EngageReplyClaim, §3.4/§3.5), and EngageReplyDailyPlan/Revision (→ live COUNT).
-- ─────────────────────────────────────────────────────────────────────────────

-- projectId: which project sent this reply. Nullable during migration, same
-- rationale as EngageConfig.projectId.
ALTER TABLE "EngageSentReply"
  ADD COLUMN IF NOT EXISTS "projectId" TEXT;

CREATE INDEX IF NOT EXISTS "EngageSentReply_organizationId_projectId_createdAt_idx"
  ON "EngageSentReply"("organizationId", "projectId", "createdAt");

-- matchedKeywords: send-time snapshot of which keywords this opportunity matched
-- (same values as EngageOpportunityState.matchedKeywords), so per-keyword daily
-- counts are a single-table COUNT(*)/unnest against this table. A permanent
-- historical fact, never updated after the fact even if the keyword is later
-- renamed or disabled.
ALTER TABLE "EngageSentReply"
  ADD COLUMN IF NOT EXISTS "matchedKeywords" TEXT[] NOT NULL DEFAULT '{}';

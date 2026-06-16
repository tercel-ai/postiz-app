-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: add EngageOpportunityState.generationHistory
--
-- Append-only audit log of every AI reply draft an org generated for an
-- opportunity. Each successful generation pushes one JSON entry (content + input
-- params + credits charged + the BillingRecord.taskId it links to), so a user who
-- regenerates several times keeps every version. Per-org (lives on the per-org
-- state row, not the shared opportunity). Nullable — back-fills lazily; an
-- opportunity with no generations stays NULL.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "EngageOpportunityState"
  ADD COLUMN IF NOT EXISTS "generationHistory" JSONB;

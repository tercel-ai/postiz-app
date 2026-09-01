-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: record replies the PLATFORM removed after we published them.
--
-- The extension posts a reply, waits a few seconds, and re-reads it from a
-- LOGGED-OUT view (extension utils/liveness/). Reddit shows a removed comment
-- to its own author untouched — score included — so only the logged-out view
-- can tell the difference, and until now nothing looked: the reply was recorded
-- as a success, charged for, and counted in the stats while nobody could read
-- it.
--
-- Both columns are NULLABLE with no default and no backfill. NULL means "still
-- standing, or never checked", which is the correct reading for every row that
-- predates the check — we have no evidence about those either way, and
-- inventing some would be worse than admitting we do not know.
--
-- Deliberately NOT a new Post.state value. The four states describe how far OUR
-- publish got, and a removed reply got all the way: it really was submitted and
-- really did exist. Removal is what the platform did afterwards — a different
-- axis. Folding it into `state` would break the things that read it: ERROR is
-- the precondition retryPost checks (so the UI would offer to re-send content
-- that was just removed, through the OAuth path), and changeState(ERROR) nulls
-- releaseId, discarding the id an investigation starts from. DRAFT is worse
-- still: it reads as "never sent" and invites a duplicate.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "EngageSentReply"
  ADD COLUMN IF NOT EXISTS "removedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "removedReason" TEXT;

-- Serves both the `removedAt: null` filters the metrics and dashboard queries
-- now carry, and the removal-rate reads that come next (per-subreddit rates,
-- and the run-of-'gone'-across-communities pattern that indicates a shadowban).
CREATE INDEX IF NOT EXISTS "EngageSentReply_organizationId_removedAt_idx"
  ON "EngageSentReply"("organizationId", "removedAt");

-- Migration: Add source column to Post
-- Date: 2026-03-23
-- Context: Track which entry point created the post (calendar UI vs chat agent)
--          so we can distinguish posts by origin in analytics and reporting.

ALTER TABLE "Post"
    ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'calendar';

CREATE INDEX IF NOT EXISTS "Post_source_idx" ON "Post"("source");

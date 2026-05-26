-- Migration: Add picture column to EngageTrackedAccount
-- Date: 2026-05-25
-- Context: Store the tracked account's profile avatar URL (backfilled during scan
--          from the X user lookup) so the Signal Feed / settings UI can render the
--          real avatar instead of username initials. Mirrors Integration.picture.

ALTER TABLE "EngageTrackedAccount"
    ADD COLUMN IF NOT EXISTS "picture" TEXT;

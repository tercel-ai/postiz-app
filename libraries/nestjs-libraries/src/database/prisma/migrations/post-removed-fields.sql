-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: record when a PLATFORM removed a Post after the extension
-- published it, for any extension-published post regardless of Post.source.
--
-- Sibling of engage-sent-reply-removed.sql, one layer down. That migration
-- covers ENGAGE REPLIES (EngageSentReply rows); this one covers the general
-- case — an operation-plan / calendar-scheduled post published in-browser
-- (source='calendar', never 'engage') has no EngageSentReply row to carry the
-- fact on, so it has to live on Post itself.
--
-- Both nullable, no default, no backfill. NULL means "still standing, or never
-- checked" — the correct reading for every row published before this check
-- existed.
--
-- `state` is deliberately untouched by this migration and by every writer of
-- these columns: a removed post really was published, so PUBLISHED stays
-- accurate; see the schema.prisma comment on these columns for why ERROR/DRAFT
-- are each wrong in their own way.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "Post"
  ADD COLUMN IF NOT EXISTS "removedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "removedReason" TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: extension session health on Integration, separate from OAuth health.
--
-- `disabled`/`refreshNeeded` only track the 'api' send path's OAuth token —
-- they say nothing about whether the user's browser is currently signed into
-- this account for the 'extension' send path (extensionRouteBranches() never
-- looks at them). Confirmed by observation: a `refreshNeeded=true` integration
-- published successfully via the extension, because the flag is simply
-- irrelevant to that path.
--
-- These columns let the extension's hourly session-maintenance job report
-- what it already probes locally (aisee-browser-extension's PlatformLoginEntry,
-- see IntegrationService.reportExtensionSession):
--   activeSessionClient       — which client (PublishMethod: API or EXTENSION)
--                               this integration is currently confirmed reachable
--                               through. Every integration starts at API (how
--                               every one of them is actually authorized); a
--                               matching extension report flips it to EXTENSION,
--                               and a later report showing the browser signed
--                               into a different account on the same platform
--                               (or no one) flips it back to API. NOT a record
--                               of how the account was originally connected.
--   extensionSessionCheckedAt — when that reading was taken. Deliberately not
--                               `updatedAt` (touched by unrelated writes like
--                               disableChannel/updateOnCustomerName) — staleness
--                               is derived from THIS column at read time, not
--                               stored.
--   metadata                  — loosely-typed diagnostic extras, starting with
--                               `extensionSessionHandle` (the handle actually
--                               seen logged in for the platform, kept even on
--                               rows that didn't match — "browser is signed
--                               into @X" is worth saying even when nothing here
--                               is @X). Unrelated to the legacy `additionalSettings`
--                               column, which this migration does not touch.
--
-- activeSessionClient defaults every existing row to API (accurate: every
-- integration that predates this feature is, in fact, only known to work via
-- OAuth). The other two columns are nullable with no default/backfill — NULL
-- means "never reported", the correct reading for every pre-existing row.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "Integration"
  ADD COLUMN IF NOT EXISTS "activeSessionClient" "PublishMethod" NOT NULL DEFAULT 'API',
  ADD COLUMN IF NOT EXISTS "extensionSessionCheckedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "metadata" JSONB;

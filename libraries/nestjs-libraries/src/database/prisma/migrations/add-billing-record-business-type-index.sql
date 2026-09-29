-- Migration: Composite index on BillingRecord(businessType, createdAt)
-- Date: 2026-09-29
-- Context: The admin credit-consumption views filter by business scene, and
--          `businessType` is the leading column of every scene predicate
--          (see billing-records.query.ts scenePredicate), usually combined with
--          a createdAt window. `businessType` had no index at all, so both
--          GET /admin/billing/records and GET /admin/billing/stats scanned the
--          table for exactly the query the scene filter was built around.
--
-- HOW THIS IS NORMALLY APPLIED: it is NOT. The index is declared in
-- schema.prisma as `@@index([businessType, createdAt])`, so `pnpm run
-- prisma-db-push` creates it like any other declared index. This file exists as
-- the written record of the change, the same role as its siblings in this
-- directory (none of which are wired into a script either — only
-- ../engage-indexes.sql is, because it holds indexes Prisma cannot express).
--
-- WHEN TO RUN IT BY HAND INSTEAD: `prisma db push` issues a plain CREATE INDEX,
-- which holds a lock that blocks writes for its duration. BillingRecord gains a
-- row per AI call, so on a large live ledger create it concurrently FIRST — push
-- then sees it already present and does nothing:
--   CREATE INDEX CONCURRENTLY "BillingRecord_businessType_createdAt_idx"
--     ON "BillingRecord"("businessType", "createdAt");
-- (CONCURRENTLY cannot run inside a transaction block.)

CREATE INDEX IF NOT EXISTS "BillingRecord_businessType_createdAt_idx"
    ON "BillingRecord"("businessType", "createdAt");

-- Migration: Denormalise LLM token usage onto BillingRecord
-- Date: 2026-09-29
-- Context: GET /admin/billing/stats reports token usage per business scene. The
--          numbers live in the `costItems` TEXT column, so reading them meant
--          casting it to jsonb and expanding the array FOR EVERY ROW of the
--          filtered set — a cast this server (PostgreSQL 15) has no safe guard
--          for (16's `IS JSON` would), and which no index can serve. These
--          columns let the same figures be summed directly.
--
-- HOW THIS IS NORMALLY APPLIED: it is NOT. The columns are declared in
-- schema.prisma, so `pnpm run prisma-db-push` adds them like any other field.
-- This file is the written record, the same role as its siblings here.
--
-- ORDER MATTERS: push these columns FIRST, then run
-- backfill-billing-record-token-columns.sql. Between the two, /stats falls back
-- to reading costItems for rows whose columns are still NULL, so the figures stay
-- correct throughout — `chargesWithTokenData` on each scene says how many rows
-- the backfill has reached.

ALTER TABLE "BillingRecord"
    ADD COLUMN IF NOT EXISTS "totalTokens" INTEGER;

ALTER TABLE "BillingRecord"
    ADD COLUMN IF NOT EXISTS "promptTokens" INTEGER;

ALTER TABLE "BillingRecord"
    ADD COLUMN IF NOT EXISTS "completionTokens" INTEGER;

ALTER TABLE "BillingRecord"
    ADD COLUMN IF NOT EXISTS "cachedPromptTokens" INTEGER;

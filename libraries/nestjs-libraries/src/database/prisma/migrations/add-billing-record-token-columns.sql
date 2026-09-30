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
-- ORDER MATTERS, AND IT INCLUDES THE APP: every BillingRecord write path now
-- names these four columns in its Prisma payload, so a build deployed AHEAD of the
-- push cannot write a billing row at all. Push, then deploy, then backfill. (The
-- charge path refuses rather than charging past a schema error — see
-- STRUCTURAL_DB_ERROR_CODES in aisee-credit.service.ts — so the failure is a
-- missed charge, not a silent one, but it is still a failure.)
--
-- Push these columns FIRST, then run
-- backfill-billing-record-token-columns.sql. Between the two, /stats falls back
-- to reading costItems for rows whose columns are still NULL, so the figures stay
-- correct throughout. Progress is reported by the backfill script's own
-- `remaining` NOTICE, NOT by `chargesWithTokenData` on a scene: while the fallback
-- is working that field equals `count`, so watching it would say "done" before the
-- backfill had run at all.

ALTER TABLE "BillingRecord"
    ADD COLUMN IF NOT EXISTS "totalTokens" INTEGER;

ALTER TABLE "BillingRecord"
    ADD COLUMN IF NOT EXISTS "promptTokens" INTEGER;

ALTER TABLE "BillingRecord"
    ADD COLUMN IF NOT EXISTS "completionTokens" INTEGER;

ALTER TABLE "BillingRecord"
    ADD COLUMN IF NOT EXISTS "cachedPromptTokens" INTEGER;

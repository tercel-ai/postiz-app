-- Migration: Add subType and data columns to BillingRecord
-- Date: 2026-03-20
-- Context: Fine-grained sub-type categorization and flexible business context
--          for billing records. Also supports 'internal' status for unified
--          BillingRecord creation across all billing modes.

ALTER TABLE "BillingRecord"
    ADD COLUMN IF NOT EXISTS "subType" TEXT;

ALTER TABLE "BillingRecord"
    ADD COLUMN IF NOT EXISTS "data" JSONB;

CREATE INDEX IF NOT EXISTS "BillingRecord_subType_idx" ON "BillingRecord"("subType");

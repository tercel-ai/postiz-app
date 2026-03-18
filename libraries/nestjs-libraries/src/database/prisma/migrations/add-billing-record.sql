-- Migration: Add BillingRecord table for Aisee billing audit trail
-- Date: 2026-03-18
-- Context: When BILL_TYPE=third, billing goes through Aisee (../aisee-core).
--          BillingRecord stores a local audit row for every credit deduction,
--          created BEFORE calling Aisee so its id (postizBillingId) can be
--          sent to Aisee for cross-system reconciliation.

CREATE TABLE IF NOT EXISTS "BillingRecord" (
    "id"                TEXT NOT NULL DEFAULT gen_random_uuid(),
    "organizationId"    TEXT NOT NULL,
    "transactionId"     TEXT,
    "taskId"            TEXT NOT NULL,
    "amount"            TEXT NOT NULL,
    "businessType"      TEXT NOT NULL,
    "description"       TEXT NOT NULL,
    "costItems"         TEXT NOT NULL DEFAULT '[]',
    "relatedId"         TEXT,
    "status"            TEXT NOT NULL DEFAULT 'pending',
    "remainingBalance"  TEXT,
    "debtAmount"        TEXT,
    "error"             TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BillingRecord_taskId_key" ON "BillingRecord"("taskId");
CREATE INDEX IF NOT EXISTS "BillingRecord_organizationId_idx" ON "BillingRecord"("organizationId");
CREATE INDEX IF NOT EXISTS "BillingRecord_createdAt_idx" ON "BillingRecord"("createdAt");
CREATE INDEX IF NOT EXISTS "BillingRecord_status_idx" ON "BillingRecord"("status");
CREATE INDEX IF NOT EXISTS "BillingRecord_relatedId_idx" ON "BillingRecord"("relatedId");

ALTER TABLE "BillingRecord"
    ADD CONSTRAINT "BillingRecord_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

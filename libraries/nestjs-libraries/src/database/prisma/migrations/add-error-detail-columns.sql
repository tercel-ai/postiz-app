-- Migration: Add detailed error columns to Errors
-- Date: 2026-05-11
-- Context: Scheduled posts frequently fail with 401 / [ApiResponseError]
--          at night / on weekends when no user activity refreshes tokens.
--          Currently `Errors.message` is a single concatenated string
--          (type + code + first 3 stack lines + details). For triage we need
--          the full stack and structured fields so 401-spikes can be sliced
--          by platform and code.

ALTER TABLE "Errors"
    ADD COLUMN IF NOT EXISTS "stack"   TEXT,
    ADD COLUMN IF NOT EXISTS "code"    TEXT,
    ADD COLUMN IF NOT EXISTS "type"    TEXT,
    ADD COLUMN IF NOT EXISTS "details" TEXT;

CREATE INDEX IF NOT EXISTS "Errors_code_idx"          ON "Errors"("code");
CREATE INDEX IF NOT EXISTS "Errors_platform_code_idx" ON "Errors"("platform","code");

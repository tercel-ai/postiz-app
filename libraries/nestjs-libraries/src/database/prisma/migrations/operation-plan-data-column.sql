-- Plan-level goal summary for OperationPlan (title, description, baselineScore,
-- targetScore). Nullable so existing plans remain valid. Separate from
-- planPayload (which holds the generated content/engage blob).
ALTER TABLE "OperationPlan" ADD COLUMN IF NOT EXISTS "data" JSONB;

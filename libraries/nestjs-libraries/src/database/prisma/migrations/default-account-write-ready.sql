-- Apply through the deployment pipeline after reviewing the target database.
-- Existing enabled, disabled, and quarantined rows retain their current values.
ALTER TABLE "AccountWriteState"
    ALTER COLUMN "rolloutReady" SET DEFAULT true;

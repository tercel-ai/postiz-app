-- Step 1: add column with default so existing rows get a non-null placeholder
ALTER TABLE "EngageSentReply"
  ADD COLUMN "inputData" JSONB NOT NULL DEFAULT '{}';

-- Step 2: backfill from the two individual columns before dropping them
UPDATE "EngageSentReply"
SET "inputData" = jsonb_build_object(
  'strategy',      strategy,
  'brandStrength', "brandStrength"
);

-- Step 3: remove the default (the column will be populated by app code going forward)
ALTER TABLE "EngageSentReply"
  ALTER COLUMN "inputData" DROP DEFAULT;

-- Step 4: drop the old columns
ALTER TABLE "EngageSentReply"
  DROP COLUMN strategy,
  DROP COLUMN "brandStrength";

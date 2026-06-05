CREATE TABLE IF NOT EXISTS "EngageKeywordInitialScan" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "keywordId" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "keyword" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "error" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "EngageKeywordInitialScan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EngageKeywordInitialScan_keywordId_platform_key"
  ON "EngageKeywordInitialScan"("keywordId", "platform");

CREATE INDEX IF NOT EXISTS "EngageKeywordInitialScan_status_platform_createdAt_idx"
  ON "EngageKeywordInitialScan"("status", "platform", "createdAt");

CREATE INDEX IF NOT EXISTS "EngageKeywordInitialScan_organizationId_platform_idx"
  ON "EngageKeywordInitialScan"("organizationId", "platform");

ALTER TABLE "EngageKeywordInitialScan"
  ADD CONSTRAINT "EngageKeywordInitialScan_keywordId_fkey"
  FOREIGN KEY ("keywordId") REFERENCES "EngageKeyword"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "EngageKeywordInitialScan" (
  "id",
  "organizationId",
  "keywordId",
  "platform",
  "keyword",
  "status",
  "attempts",
  "createdAt",
  "updatedAt"
)
SELECT
  md5(random()::text || clock_timestamp()::text || k."id"),
  k."organizationId",
  k."id",
  'reddit',
  k."keyword",
  'PENDING',
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "EngageKeyword" k
WHERE k."enabled" = true
ON CONFLICT ("keywordId", "platform") DO NOTHING;

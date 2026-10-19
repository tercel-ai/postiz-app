-- Apply through the deployment pipeline after add-send-coordination.sql.
-- The agent prepares this migration only; it must not be executed automatically.
CREATE TABLE IF NOT EXISTS "SendClaimCursor" (
  "extensionNodeId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "action" TEXT NOT NULL CHECK ("action" IN ('POST', 'REPLY')),
  "afterPublishDate" TIMESTAMP(3),
  "afterPostId" TEXT,
  "cycleStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  PRIMARY KEY ("extensionNodeId", "action"),
  FOREIGN KEY ("extensionNodeId", "organizationId")
    REFERENCES "ExtensionNode"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK (("afterPublishDate" IS NULL) = ("afterPostId" IS NULL))
);

CREATE INDEX IF NOT EXISTS "Post_controlled_claim_scan_idx"
  ON "Post" ("organizationId", "publishDate", "id")
  WHERE "state" = 'QUEUE' AND "parentPostId" IS NULL AND "deletedAt" IS NULL
    AND "executionProtocol" = 'ACCOUNT_BOUND_V1' AND "publishMethod" = 'EXTENSION';

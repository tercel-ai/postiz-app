-- Prepared migration only. Never execute from an agent session.
-- Apply after the six account/node/policy migrations through the deployment pipeline.
-- Confirm the datasource is aisee_postiz_dev before deployment.
-- AccountWriteState.rolloutReady remains FALSE until actor aliases, legacy in-flight
-- requests, and every producer sharing the affected project budgets are audited.

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "contentUnitId" TEXT,
ADD COLUMN     "sendIntentId" TEXT;

-- CreateTable
CREATE TABLE "SendIntent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contentUnitId" TEXT NOT NULL,
    "rootPostId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "sendOrigin" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "integrationId" TEXT,
    "canonicalAccountKey" TEXT,
    "target" JSONB,
    "routeRevision" INTEGER NOT NULL DEFAULT 0,
    "contentRevision" INTEGER NOT NULL DEFAULT 1,
    "fencingVersion" INTEGER NOT NULL DEFAULT 0,
    "activeExecutionId" TEXT,
    "policySnapshot" JSONB NOT NULL,
    "context" JSONB,
    "hasConfirmedSegments" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SendIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SendExecution" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sendIntentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "canonicalAccountKey" TEXT NOT NULL,
    "target" JSONB NOT NULL,
    "context" JSONB,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "requestKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "executorKey" TEXT NOT NULL,
    "extensionNodeId" TEXT,
    "nodeCredentialVersion" INTEGER,
    "sessionRevision" INTEGER,
    "leaseTokenHash" TEXT,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "fencingVersion" INTEGER NOT NULL,
    "routeRevision" INTEGER NOT NULL,
    "contentRevision" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "gapMs" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "lastProgressAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolutionRevision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SendExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SendSegment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "segmentIndex" INTEGER NOT NULL,
    "postId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "challengeHash" TEXT,
    "challengeIssuedAt" TIMESTAMP(3),
    "challengeExpiresAt" TIMESTAMP(3),
    "evidenceSessionRevision" INTEGER,
    "evidenceObservedAt" TIMESTAMP(3),
    "probeId" TEXT,
    "permitHash" TEXT,
    "submitBefore" TIMESTAMP(3),
    "authorizedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "result" JSONB,

    CONSTRAINT "SendSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountWriteState" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "canonicalAccountKey" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "rolloutReady" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "dailyWriteLimit" INTEGER,
    "identityIntegrationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "activeExecutionId" TEXT,
    "nextWriteNotBefore" TIMESTAMP(3),
    "firstConfirmedAt" TIMESTAMP(3),
    "lastConfirmedAt" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AccountWriteState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SendQuotaBucket" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "limit" INTEGER NOT NULL,
    "confirmedUnits" INTEGER NOT NULL DEFAULT 0,
    "heldUnits" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SendQuotaBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SendQuotaReservation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "segmentIndex" INTEGER NOT NULL,
    "bucketId" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'HELD',
    "policyVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "SendQuotaReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SendOutcomeEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "segmentIndex" INTEGER NOT NULL,
    "eventId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SendOutcomeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SendIntent_activeExecutionId_key" ON "SendIntent"("activeExecutionId");

-- CreateIndex
CREATE INDEX "SendIntent_organizationId_projectId_status_idx" ON "SendIntent"("organizationId", "projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SendIntent_id_organizationId_key" ON "SendIntent"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "SendIntent_organizationId_contentUnitId_key" ON "SendIntent"("organizationId", "contentUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "SendIntent_rootPostId_organizationId_key" ON "SendIntent"("rootPostId", "organizationId");

-- CreateIndex
CREATE INDEX "SendExecution_organizationId_sendIntentId_status_idx" ON "SendExecution"("organizationId", "sendIntentId", "status");

-- CreateIndex
CREATE INDEX "SendExecution_extensionNodeId_status_idx" ON "SendExecution"("extensionNodeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SendExecution_id_organizationId_key" ON "SendExecution"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "SendExecution_organizationId_kind_requestKey_key" ON "SendExecution"("organizationId", "kind", "requestKey");

-- CreateIndex
CREATE INDEX "SendSegment_organizationId_postId_idx" ON "SendSegment"("organizationId", "postId");

-- CreateIndex
CREATE UNIQUE INDEX "SendSegment_executionId_segmentIndex_key" ON "SendSegment"("executionId", "segmentIndex");

-- CreateIndex
CREATE INDEX "AccountWriteState_organizationId_integrationId_idx" ON "AccountWriteState"("organizationId", "integrationId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountWriteState_organizationId_canonicalAccountKey_key" ON "AccountWriteState"("organizationId", "canonicalAccountKey");

-- CreateIndex
CREATE INDEX "SendQuotaBucket_organizationId_windowStart_idx" ON "SendQuotaBucket"("organizationId", "windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "SendQuotaBucket_id_organizationId_key" ON "SendQuotaBucket"("id", "organizationId");

-- CreateIndex
CREATE INDEX "SendQuotaReservation_organizationId_state_idx" ON "SendQuotaReservation"("organizationId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "SendQuotaReservation_executionId_segmentIndex_bucketId_key" ON "SendQuotaReservation"("executionId", "segmentIndex", "bucketId");

-- CreateIndex
CREATE UNIQUE INDEX "SendOutcomeEvent_executionId_segmentIndex_eventId_key" ON "SendOutcomeEvent"("executionId", "segmentIndex", "eventId");

-- CreateIndex
CREATE INDEX "Post_sendIntentId_idx" ON "Post"("sendIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "Post_id_organizationId_key" ON "Post"("id", "organizationId");

-- AddForeignKey
ALTER TABLE "SendIntent" ADD CONSTRAINT "SendIntent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendIntent" ADD CONSTRAINT "SendIntent_rootPostId_organizationId_fkey" FOREIGN KEY ("rootPostId", "organizationId") REFERENCES "Post"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendIntent" ADD CONSTRAINT "SendIntent_activeExecutionId_organizationId_fkey" FOREIGN KEY ("activeExecutionId", "organizationId") REFERENCES "SendExecution"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendExecution" ADD CONSTRAINT "SendExecution_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendExecution" ADD CONSTRAINT "SendExecution_sendIntentId_organizationId_fkey" FOREIGN KEY ("sendIntentId", "organizationId") REFERENCES "SendIntent"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendSegment" ADD CONSTRAINT "SendSegment_executionId_organizationId_fkey" FOREIGN KEY ("executionId", "organizationId") REFERENCES "SendExecution"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountWriteState" ADD CONSTRAINT "AccountWriteState_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountWriteState" ADD CONSTRAINT "AccountWriteState_activeExecutionId_organizationId_fkey" FOREIGN KEY ("activeExecutionId", "organizationId") REFERENCES "SendExecution"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendQuotaBucket" ADD CONSTRAINT "SendQuotaBucket_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendQuotaReservation" ADD CONSTRAINT "SendQuotaReservation_executionId_organizationId_fkey" FOREIGN KEY ("executionId", "organizationId") REFERENCES "SendExecution"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendQuotaReservation" ADD CONSTRAINT "SendQuotaReservation_bucketId_organizationId_fkey" FOREIGN KEY ("bucketId", "organizationId") REFERENCES "SendQuotaBucket"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendOutcomeEvent" ADD CONSTRAINT "SendOutcomeEvent_executionId_organizationId_fkey" FOREIGN KEY ("executionId", "organizationId") REFERENCES "SendExecution"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_sendIntentId_organizationId_fkey" FOREIGN KEY ("sendIntentId", "organizationId") REFERENCES "SendIntent"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A single constraint spans API and extension executions.
CREATE UNIQUE INDEX "SendExecution_one_active_content" ON "SendExecution" ("organizationId", "sendIntentId")
WHERE "status" IN ('RESERVED', 'SENDING', 'RECONCILING');

ALTER TABLE "SendIntent" ADD CONSTRAINT "SendIntent_action_check" CHECK ("action" IN ('POST', 'REPLY'));
ALTER TABLE "SendIntent" ADD CONSTRAINT "SendIntent_origin_check" CHECK ("sendOrigin" IN ('MANUAL', 'AUTOMATION'));
ALTER TABLE "SendExecution" ADD CONSTRAINT "SendExecution_kind_check" CHECK ("kind" IN ('API', 'EXTENSION'));
ALTER TABLE "SendExecution" ADD CONSTRAINT "SendExecution_action_check" CHECK ("action" IN ('POST', 'REPLY'));
ALTER TABLE "SendSegment" ADD CONSTRAINT "SendSegment_index_check" CHECK ("segmentIndex" >= 0);
ALTER TABLE "SendSegment" ADD CONSTRAINT "SendSegment_status_check" CHECK ("status" IN ('PENDING', 'AUTHORIZED', 'CONFIRMED', 'UNKNOWN', 'NOT_SUBMITTED'));
ALTER TABLE "SendQuotaBucket" ADD CONSTRAINT "SendQuotaBucket_counts_check" CHECK ("limit" >= 0 AND "heldUnits" >= 0 AND "confirmedUnits" >= 0 AND "windowEnd" > "windowStart");
ALTER TABLE "SendQuotaReservation" ADD CONSTRAINT "SendQuotaReservation_units_check" CHECK ("units" > 0 AND "segmentIndex" >= 0 AND "state" IN ('HELD', 'COMMITTED', 'RELEASED'));
ALTER TABLE "AccountWriteState" ADD CONSTRAINT "AccountWriteState_limit_check" CHECK ("dailyWriteLimit" IS NULL OR "dailyWriteLimit" >= 0);

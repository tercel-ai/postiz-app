-- Preparation only: apply through the project's reviewed deployment pipeline.
-- Confirm the target database is aisee_postiz_dev before applying this file.
-- This expansion keeps the legacy account identity constraint unchanged.
-- Account namespace auditing and the replacement unique key are a later migration.
-- AlterTable
ALTER TABLE "Integration" ADD COLUMN     "identityNamespace" TEXT;

-- CreateTable
CREATE TABLE "ExtensionNode" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "registeredByUserId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "browser" TEXT NOT NULL,
    "credentialHash" TEXT NOT NULL,
    "credentialSalt" TEXT NOT NULL,
    "credentialVersion" INTEGER NOT NULL DEFAULT 1,
    "registrationRequestId" TEXT NOT NULL,
    "registrationRequestHash" TEXT NOT NULL,
    "registrationExpiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "lastReportSequence" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "extensionVersion" TEXT,
    "protocolVersion" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtensionNode_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExtensionNode_nodeId_check" CHECK ("nodeId" ~ '^[0-9a-f]{64}$')
);

-- CreateTable
CREATE TABLE "ExtensionNodeSession" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "extensionNodeId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "integrationId" TEXT,
    "accountIdentity" JSONB NOT NULL,
    "lastVerifiedIdentity" JSONB,
    "verificationStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "sessionRevision" INTEGER NOT NULL DEFAULT 1,
    "reportSequence" INTEGER NOT NULL,
    "observedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "verificationExpiresAt" TIMESTAMP(3),
    "evidenceKind" TEXT NOT NULL,
    "probeId" TEXT,
    "identityObservedAt" TIMESTAMP(3),

    CONSTRAINT "ExtensionNodeSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtensionNodeReportReceipt" (
    "id" TEXT NOT NULL,
    "extensionNodeId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "requestHash" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtensionNodeReportReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExtensionNode_organizationId_registeredByUserId_status_idx" ON "ExtensionNode"("organizationId", "registeredByUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionNode_organizationId_registeredByUserId_nodeId_key" ON "ExtensionNode"("organizationId", "registeredByUserId", "nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionNode_id_organizationId_key" ON "ExtensionNode"("id", "organizationId");

-- CreateIndex
CREATE INDEX "ExtensionNodeSession_organizationId_integrationId_idx" ON "ExtensionNodeSession"("organizationId", "integrationId");

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionNodeSession_extensionNodeId_platform_key" ON "ExtensionNodeSession"("extensionNodeId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionNodeReportReceipt_extensionNodeId_sequence_key" ON "ExtensionNodeReportReceipt"("extensionNodeId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_id_organizationId_key" ON "Integration"("id", "organizationId");

-- AddForeignKey
ALTER TABLE "ExtensionNode" ADD CONSTRAINT "ExtensionNode_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionNode" ADD CONSTRAINT "ExtensionNode_registeredByUserId_fkey" FOREIGN KEY ("registeredByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionNodeSession" ADD CONSTRAINT "ExtensionNodeSession_extensionNodeId_organizationId_fkey" FOREIGN KEY ("extensionNodeId", "organizationId") REFERENCES "ExtensionNode"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionNodeSession" ADD CONSTRAINT "ExtensionNodeSession_integrationId_organizationId_fkey" FOREIGN KEY ("integrationId", "organizationId") REFERENCES "Integration"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionNodeReportReceipt" ADD CONSTRAINT "ExtensionNodeReportReceipt_extensionNodeId_fkey" FOREIGN KEY ("extensionNodeId") REFERENCES "ExtensionNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


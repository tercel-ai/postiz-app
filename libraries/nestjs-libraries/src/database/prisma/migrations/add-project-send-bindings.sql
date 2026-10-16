-- Prepared only. Apply through the deployment migration pipeline after validating the database name.
-- CreateTable
CREATE TABLE "ProjectSendBinding" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "integrationId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectSendBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SendMutationReceipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SendMutationReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectSendBinding_organizationId_integrationId_idx" ON "ProjectSendBinding"("organizationId", "integrationId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSendBinding_organizationId_projectId_platform_action_key" ON "ProjectSendBinding"("organizationId", "projectId", "platform", "action");

-- CreateIndex
CREATE UNIQUE INDEX "SendMutationReceipt_organizationId_userId_operation_request_key" ON "SendMutationReceipt"("organizationId", "userId", "operation", "requestId");

-- AddForeignKey
ALTER TABLE "ProjectSendBinding" ADD CONSTRAINT "ProjectSendBinding_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSendBinding" ADD CONSTRAINT "ProjectSendBinding_integrationId_organizationId_fkey" FOREIGN KEY ("integrationId", "organizationId") REFERENCES "Integration"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSendBinding" ADD CONSTRAINT "ProjectSendBinding_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendMutationReceipt" ADD CONSTRAINT "SendMutationReceipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendMutationReceipt" ADD CONSTRAINT "SendMutationReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


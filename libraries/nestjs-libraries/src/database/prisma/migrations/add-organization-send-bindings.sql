-- Prepared only. Apply through the deployment migration pipeline after validating aisee_postiz_dev.
-- Requires add-extension-nodes.sql, add-project-send-bindings.sql and add-plan-execution-routes.sql.
CREATE TABLE "OrganizationSendBinding" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "integrationId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrganizationSendBinding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationSendBinding_organizationId_platform_action_key"
ON "OrganizationSendBinding"("organizationId", "platform", "action");
CREATE INDEX "OrganizationSendBinding_organizationId_integrationId_idx"
ON "OrganizationSendBinding"("organizationId", "integrationId");

ALTER TABLE "OrganizationSendBinding" ADD CONSTRAINT "OrganizationSendBinding_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrganizationSendBinding" ADD CONSTRAINT "OrganizationSendBinding_integrationId_organizationId_fkey"
FOREIGN KEY ("integrationId", "organizationId") REFERENCES "Integration"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrganizationSendBinding" ADD CONSTRAINT "OrganizationSendBinding_updatedByUserId_fkey"
FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Legacy account selections are not inferred from nullable integrationId.
-- Existing queued snapshots retain their historical routing; audit before controlled execution.
ALTER TABLE "Post"
ADD COLUMN "accountSelectionMode" TEXT,
ADD COLUMN "bindingSource" TEXT,
ADD COLUMN "bindingSourceRevision" INTEGER,
ADD COLUMN "accountResolution" TEXT;

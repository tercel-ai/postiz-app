-- Apply through the deployment migration pipeline after add-extension-nodes.sql.
-- Existing personal sessions retain the empty slot; each company has its own slot.
BEGIN;
ALTER TABLE "ExtensionNodeSession" ADD COLUMN "actorKey" TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX "ExtensionNodeSession_extensionNodeId_platform_actorKey_key"
  ON "ExtensionNodeSession"("extensionNodeId", "platform", "actorKey");
DROP INDEX "ExtensionNodeSession_extensionNodeId_platform_key";
ALTER TABLE "ExtensionNodeSession" ADD CONSTRAINT "ExtensionNodeSession_actorKey_check"
  CHECK ("actorKey" = '' OR
    ("platform" = 'linkedin' AND "actorKey" ~ '^linkedin[.]organization_id:[1-9][0-9]*$'));
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_linkedin_organization_identity_check"
  CHECK ("identityNamespace" <> 'linkedin.organization_id' OR
    ("providerIdentifier" = 'linkedin-page' AND "internalId" ~ '^[1-9][0-9]*$')) NOT VALID;
COMMIT;

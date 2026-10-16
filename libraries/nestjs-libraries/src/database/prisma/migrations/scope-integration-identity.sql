-- Prepared only. Apply through the deployment migration pipeline after validating the database name.
-- No Integration IDs, OAuth credentials, posts, or project assignments are replaced.
-- Keep the legacy unique index during expand deployment. It still protects old
-- application binaries whose unique lookup is (organizationId, internalId).
-- Remove it only with contract-integration-identity.sql after old writers stop.

-- Preserve unknown identities as legacy; do not infer a platform namespace.
UPDATE "Integration" SET "identityNamespace" = 'legacy' WHERE "identityNamespace" IS NULL;

-- AlterTable
ALTER TABLE "Integration" ALTER COLUMN "identityNamespace" SET NOT NULL,
ALTER COLUMN "identityNamespace" SET DEFAULT 'legacy';

-- CreateIndex
CREATE UNIQUE INDEX "Integration_organizationId_providerIdentifier_identityNames_key" ON "Integration"("organizationId", "providerIdentifier", "identityNamespace", "internalId");


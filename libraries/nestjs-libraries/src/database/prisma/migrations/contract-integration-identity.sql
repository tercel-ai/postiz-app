-- Prepared contract migration only. Never execute from an agent session.
-- This is NOT part of the initial expand migration sequence.
-- Prerequisites: scope-integration-identity.sql has succeeded; every backend and
-- worker uses the provider/namespace-scoped identity lookup; all older binaries
-- and legacy writers have been stopped; identity aliases/duplicates were audited.
-- Deploying this while old binaries run can make their account lookup ambiguous.
DROP INDEX "Integration_organizationId_internalId_key";

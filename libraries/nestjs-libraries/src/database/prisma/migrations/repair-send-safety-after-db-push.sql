-- Prepared only. Apply manually or through the reviewed deployment pipeline.
-- For a database already synchronized to the current schema by db push.
-- Prerequisite: both indexes below and all eighteen CHECKs are absent.
-- Stop application writers and retain a backup before applying the complete file.
-- Existing data must satisfy the validated checks and active-execution uniqueness.
-- Any conflict aborts the transaction; no data is repaired or removed automatically.
-- Do not rerun base table/column migrations or recreate the completed profile index.
-- Prepare with pnpm migration:prepare:send-safety --output <new.sql>.

BEGIN;

SET LOCAL search_path = pg_catalog, public;

DO $$
DECLARE
  expected_database text := current_setting('postiz.expected_database', true);
BEGIN
  IF expected_database IS NULL OR btrim(expected_database) = '' THEN
    RAISE EXCEPTION 'Expected database is missing; prepare this migration from DATABASE_URL first';
  END IF;
  IF current_database() <> expected_database THEN
    RAISE EXCEPTION 'Expected database %, connected to %; refusing send safety repair',
      expected_database, current_database();
  END IF;
END $$;

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

CREATE INDEX "Post_controlled_claim_scan_idx"
  ON "Post" ("organizationId", "publishDate", "id")
  WHERE "state" = 'QUEUE' AND "parentPostId" IS NULL AND "deletedAt" IS NULL
    AND "executionProtocol" = 'ACCOUNT_BOUND_V1' AND "publishMethod" = 'EXTENSION';

ALTER TABLE "ExtensionNode" ADD CONSTRAINT "ExtensionNode_nodeId_check"
  CHECK ("nodeId" ~ '^[0-9a-f]{64}$');

ALTER TABLE "Integration" ADD CONSTRAINT "Integration_x_rest_id_canonical_check"
  CHECK ("identityNamespace" <> 'x.rest_id' OR
    ("providerIdentifier" = 'x' AND "internalId" ~ '^[1-9][0-9]*$')) NOT VALID;
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_reddit_user_id_canonical_check"
  CHECK ("identityNamespace" <> 'reddit.user_id' OR
    ("providerIdentifier" = 'reddit' AND "internalId" ~ '^[a-z0-9]+$')) NOT VALID;

ALTER TABLE "ExtensionNodeSession" ADD CONSTRAINT "ExtensionNodeSession_actorKey_check"
  CHECK ("actorKey" = '' OR
    ("platform" = 'linkedin' AND "actorKey" ~ '^linkedin[.]organization_id:[1-9][0-9]*$'));
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_linkedin_organization_identity_check"
  CHECK ("identityNamespace" <> 'linkedin.organization_id' OR
    ("providerIdentifier" = 'linkedin-page' AND "internalId" ~ '^[1-9][0-9]*$')) NOT VALID;

ALTER TABLE "ProjectSendOwner" ADD CONSTRAINT "ProjectSendOwner_action_check"
  CHECK ("action" IN ('POST', 'REPLY'));

ALTER TABLE "SendClaimCursor" ADD CONSTRAINT "SendClaimCursor_action_check"
  CHECK ("action" IN ('POST', 'REPLY'));
ALTER TABLE "SendClaimCursor" ADD CONSTRAINT "SendClaimCursor_revision_check"
  CHECK ("revision" >= 0);
ALTER TABLE "SendClaimCursor" ADD CONSTRAINT "SendClaimCursor_check"
  CHECK (("afterPublishDate" IS NULL) = ("afterPostId" IS NULL));

COMMIT;

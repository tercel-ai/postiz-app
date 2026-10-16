-- Prepared only. Apply through the deployment pipeline after checking the target
-- is aisee_postiz_dev and completing the eight expand migrations in the design.
-- NOT VALID preserves existing rows for identity audit. New/updated known
-- identities must already be canonical; legacy identities remain isolated.
-- This does not infer namespaces, merge rows, rewrite references, or remove data.
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_x_rest_id_canonical_check"
  CHECK ("identityNamespace" <> 'x.rest_id' OR
    ("providerIdentifier" = 'x' AND "internalId" ~ '^[1-9][0-9]*$')) NOT VALID;
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_reddit_user_id_canonical_check"
  CHECK ("identityNamespace" <> 'reddit.user_id' OR
    ("providerIdentifier" = 'reddit' AND "internalId" ~ '^[a-z0-9]+$')) NOT VALID;
-- Validate existing rows separately only after identity conflicts and in-flight
-- legacy references have been audited. Never run this file from an agent session.

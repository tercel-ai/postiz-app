-- Migration: Add providerIdentifier column to Post
-- Date: 2026-07-31
-- Context: Post.providerIdentifier becomes the persisted source of truth for a
--          post's platform. Previously this was resolved ad hoc at read time via
--          `integration?.providerIdentifier || settings.__type` scattered across
--          posts.service.ts/posts.repository.ts. Backfill: prefer the bound
--          integration's providerIdentifier; fall back to settings.__type for
--          posts with no bound account (extension-published operation-plan posts).
--          settings.__type stays as the provider-settings discriminator only.
-- NOTE: the backfill below is REQUIRED, not optional — schedulePosts/changeDate/
--       startWorkflow no longer parse settings.__type, so an accountless row left
--       with providerIdentifier NULL cannot be scheduled or published.

ALTER TABLE "Post"
    ADD COLUMN IF NOT EXISTS "providerIdentifier" TEXT;

-- Prefer the bound integration's providerIdentifier.
UPDATE "Post" p
SET "providerIdentifier" = i."providerIdentifier"
FROM "Integration" i
WHERE p."integrationId" = i.id
  AND p."providerIdentifier" IS NULL;

-- No bound integration: fall back to settings.__type. settings is a free-form
-- TEXT column written by JSON.stringify, but a single legacy malformed row must
-- not abort the whole backfill — go through an exception-safe cast instead of a
-- bare ::jsonb.
CREATE OR REPLACE FUNCTION pg_temp.try_jsonb(t text) RETURNS jsonb AS $$
BEGIN
  RETURN t::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

UPDATE "Post" p
SET "providerIdentifier" = NULLIF(pg_temp.try_jsonb(p.settings) ->> '__type', '')
WHERE p."providerIdentifier" IS NULL
  AND p.settings IS NOT NULL;

CREATE INDEX IF NOT EXISTS "Post_providerIdentifier_idx" ON "Post" ("providerIdentifier");

-- Apply through the deployment pipeline or manually after reviewing the
-- duplicate cleanup preview. Agents must not execute this migration.
-- This migration does not delete, merge, or reassign any account data.
-- Prepare with pnpm migration:prepare:profile-uniqueness --output <new.sql>.
-- The offline preparer derives the expected database from DATABASE_URL.
BEGIN;

DO $$
DECLARE
  expected_database text := current_setting('postiz.expected_database', true);
BEGIN
  IF expected_database IS NULL OR btrim(expected_database) = '' THEN
    RAISE EXCEPTION 'Expected database is missing; prepare this migration from DATABASE_URL first';
  END IF;
  IF current_database() <> expected_database THEN
    RAISE EXCEPTION 'Expected database %, connected to %; refusing profile uniqueness migration',
      expected_database, current_database();
  END IF;
END $$;

-- Match normalizeHandle: trim ECMAScript whitespace, lowercase, then remove
-- one leading @ and one leading u/. Personal/company providers stay separate.
CREATE FUNCTION postiz_normalized_integration_profile(value text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT regexp_replace(
    regexp_replace(
      lower(btrim(value, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')),
      '^@', ''
    ), '^u/', ''
  );
$$;

-- Disabled accounts still reserve their profile. Deleted accounts retain
-- history, but must pass the same uniqueness check before being restored.
-- Existing active duplicates make this transaction fail without changing data.
CREATE UNIQUE INDEX "Integration_org_provider_profile_active_key"
  ON "Integration" (
    "organizationId",
    "providerIdentifier",
    postiz_normalized_integration_profile("profile")
  )
  WHERE "deletedAt" IS NULL
    AND "type" = 'social'
    AND nullif(postiz_normalized_integration_profile("profile"), '') IS NOT NULL;

COMMIT;

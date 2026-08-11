-- Migration: Fold EngageMonitoredChannel into EngageTrackedAccount
-- Date: 2026-08-11
-- Context: The two scan-target tables were ~85% identical, already drew from ONE
--          per-platform "priority accounts" entitlement pool, and both fed the
--          same isFromTrackedAccount scoring signal. Their platform allowlists
--          OVERLAPPED (x and reddit were valid in both), so an API caller could
--          create rows no scanner could serve: a reddit "tracked account" was
--          fetched as /r/<username>, an x "channel" was searched as a bare
--          keyword. After the merge the scope is derived from `platform`
--          (scanTypeFor: reddit => channel, everything else => tracked), which
--          makes those states unrepresentable.
--
-- Field mapping: channelId -> username, channelName -> displayName,
--                lastScannedAt -> lastCheckedAt, audienceSize/metadata as-is.
--                Row ids are PRESERVED, so any external reference to a channel
--                id still resolves.
--
-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║  ⚠  THE DEPLOY ITSELF DROPS "EngageMonitoredChannel".                  ║
-- ║                                                                        ║
-- ║  `pnpm run pm2-run:prod` chains `prisma-db-push`, which is             ║
-- ║  `prisma db push --accept-data-loss`. This model has been REMOVED      ║
-- ║  from schema.prisma, so ANY db push drops the source table.            ║
-- ║                                                                        ║
-- ║  STEP 2 MUST COMPLETE BEFORE ANY `prisma db push`. Deploying first     ║
-- ║  destroys every monitored channel and the backfill then silently       ║
-- ║  copies zero rows; recovery needs a database restore. STEP 2's own     ║
-- ║  precondition guard aborts if the source table is already gone.        ║
-- ╚════════════════════════════════════════════════════════════════════════╝
--
-- RUN ORDER (each step aborts loudly rather than proceeding on bad state):
--   1. STEP 0 — audit. Enforced: it RAISES on a broken premise, it does not
--      just print. Read the NOTICEs it emits either way.
--   2. STEP 1 + STEP 2 + STEP 2b + STEP 2c — add columns, backfill, reconcile
--      channel cursors, canonicalise the pre-existing tracked rows. Safe to run
--      while the OLD code is still deployed.
--   3. STEP 3 — uncomment and run the DROP. Do it NOW, not later: while the
--      source table survives, a stray re-run of STEP 2 would resurrect
--      channels a user has since deleted through the new code (which deletes
--      from EngageTrackedAccount and never touches the old table).
--   4. Deploy the new code (`pnpm run pm2-run:prod`).
--
-- Re-runnability: every step is idempotent and safe to re-run BETWEEN step 1
-- and step 3. After step 3 the precondition guard turns a re-run into a clean
-- abort. There is no window in which a re-run silently changes data.

-- ─── SHARED NORMALIZATION ───────────────────────────────────────────────────
--
-- ONE definition of the scan-target key, used by the audits (STEP 0), the
-- backfill (STEP 2) and the cursor reconciliation (STEP 2b). Previously each
-- of those spelled its own subset, so an audit could report "no collision"
-- while the backfill's ON CONFLICT arbiter still collided and silently dropped
-- a channel row.
--
-- Mirrors normalizeUsername() in
-- libraries/nestjs-libraries/src/engage/engage-scan-lease.service.ts EXACTLY:
--   trim → strip ^@ → strip ^/?[ur]/ → strip /+$ → lowercase,
-- and only for the case-insensitive platforms; every other platform keeps its
-- key verbatim (opaque ids such as a Bluesky DID or a YouTube channelId).
-- Keep the two in sync — a divergence here mis-keys production rows.

-- The exact character set JS String.prototype.trim() strips (ECMA-262
-- WhiteSpace u LineTerminator), enumerated explicitly. Spelling it
-- `[[:space:]]` covers ASCII only under a UTF-8 collation — the parity spec
-- (engage-normalize-sql-parity.spec.ts) caught U+202F surviving that class,
-- which would have backfilled a key the application enumerates differently.
CREATE OR REPLACE FUNCTION engage_js_trim(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(
    p_text,
    E'\t\n\u000B\f\r \u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'
  )
$$;

CREATE OR REPLACE FUNCTION engage_normalize_target_key(p_platform text, p_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN lower(p_platform) IN
         ('x', 'reddit', 'threads', 'instagram', 'tiktok', 'devto', 'medium')
    THEN lower(
           regexp_replace(
             regexp_replace(
               regexp_replace(engage_js_trim(p_key), '^@', ''),
             '^/?[ur]/', '', 'i'),
           '/+$', '')
         )
    ELSE engage_js_trim(p_key)
  END
$$;

-- ─── STEP 0: audit (ENFORCED — raises, does not merely print) ───────────────

DO $$
DECLARE
  v_bad_channel   bigint;
  v_bad_tracked   bigint;
  v_dup_channel   bigint;
  v_cross_collide bigint;
  v_total_channel bigint;
BEGIN
  IF to_regclass('"EngageMonitoredChannel"') IS NULL THEN
    RAISE NOTICE 'STEP 0: EngageMonitoredChannel is already gone — nothing to audit.';
    RETURN;
  END IF;

  SELECT count(*) INTO v_total_channel FROM "EngageMonitoredChannel";

  -- 0a. Scope premise: the merge derives the scope from `platform`, so a
  --     non-reddit channel row (or a reddit tracked row) has no representable
  --     home in the merged table. AddMonitoredChannelDto.platform was a bare
  --     @IsString(), so these rows are storable in principle — hence the check.
  --
  --     IDEMPOTENCE: a reddit row in EngageTrackedAccount is only a violation
  --     when it did NOT come from this backfill. After STEP 2 runs, every
  --     migrated channel IS a reddit row there — the backfill preserves ids, so
  --     matching on id tells the two apart. Without this exclusion the audit
  --     rejects the very state its own backfill produces, and a re-run (e.g. to
  --     reach STEP 3) fails instead of reporting "already done".
  SELECT count(*) INTO v_bad_channel
  FROM "EngageMonitoredChannel" WHERE lower("platform") <> 'reddit';

  SELECT count(*) INTO v_bad_tracked
  FROM "EngageTrackedAccount" t
  WHERE lower(t."platform") = 'reddit'
    AND NOT EXISTS (
      SELECT 1 FROM "EngageMonitoredChannel" c WHERE c."id" = t."id"
    );

  IF v_bad_channel > 0 OR v_bad_tracked > 0 THEN
    RAISE EXCEPTION
      'STEP 0a FAILED: % non-reddit channel row(s) and % reddit tracked row(s). '
      'The "one scope per platform" premise does not hold on this database — '
      'stop and re-plan; do NOT run STEP 2.', v_bad_channel, v_bad_tracked;
  END IF;

  -- 0b. Two channels in one config whose NORMALIZED keys collide. The backfill's
  --     ON CONFLICT arbiter would keep one and silently discard the other.
  SELECT count(*) INTO v_dup_channel FROM (
    SELECT 1
    FROM "EngageMonitoredChannel" c
    GROUP BY c."configId", c."platform",
             engage_normalize_target_key(c."platform", c."channelId")
    HAVING count(*) > 1
  ) d;

  -- 0c. A channel whose normalized key already exists as a tracked account on
  --     the same config+platform. Compared with the EXACT arbiter expression
  --     (t.username as stored, not lower(t.username)) so this tests precisely
  --     what the unique index will test — no false negatives, no false alarms.
  --     `platform` is lowered on BOTH sides to match what STEP 2 now writes.
  --
  --     IDEMPOTENCE, same reason as 0a: after STEP 2 every channel matches its
  --     OWN backfilled row on this join. A row colliding with itself is not a
  --     collision, so exclude the id-identical pair.
  SELECT count(*) INTO v_cross_collide
  FROM "EngageMonitoredChannel" c
  JOIN "EngageTrackedAccount" t
    ON t."configId" = c."configId"
   AND lower(t."platform") = lower(c."platform")
   AND t."username" = engage_normalize_target_key(c."platform", c."channelId")
   AND t."id" <> c."id";

  IF v_dup_channel > 0 OR v_cross_collide > 0 THEN
    RAISE EXCEPTION
      'STEP 0b/0c FAILED: % intra-channel key collision group(s) and % '
      'channel-vs-tracked collision(s). The backfill would silently discard '
      'those channel rows — resolve them by hand first.',
      v_dup_channel, v_cross_collide;
  END IF;

  RAISE NOTICE 'STEP 0 PASSED: % channel row(s) ready to migrate.', v_total_channel;
END $$;

-- Informational breakdown (safe to skip; the enforced checks above already ran).
SELECT 'channel' AS source, "platform", count(*) AS rows
FROM "EngageMonitoredChannel" GROUP BY "platform"
UNION ALL
SELECT 'tracked', "platform", count(*)
FROM "EngageTrackedAccount" GROUP BY "platform"
ORDER BY 1, 2;

-- ─── STEP 1: widen EngageTrackedAccount ─────────────────────────────────────
--
-- Constant DEFAULT ⇒ no table rewrite on PG 11+ (prod is pinned to postgres:16).

ALTER TABLE "EngageTrackedAccount"
    ADD COLUMN IF NOT EXISTS "audienceSize" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "metadata" JSONB;

-- Name matches Prisma's generated name for @@index([configId, platform, enabled]),
-- so a later `db push` will not create a duplicate.
CREATE INDEX IF NOT EXISTS "EngageTrackedAccount_configId_platform_enabled_idx"
    ON "EngageTrackedAccount" ("configId", "platform", "enabled");

-- ─── STEP 2: backfill channel rows ──────────────────────────────────────────

-- Precondition guard: the deploy drops the source table, so a missing table
-- here means the deploy already ran and every channel row is gone. Abort
-- rather than "succeed" by copying nothing.
DO $$ BEGIN
  IF to_regclass('"EngageMonitoredChannel"') IS NULL THEN
    RAISE EXCEPTION
      'STEP 2 ABORTED: "EngageMonitoredChannel" does not exist. Either the '
      'backfill already completed and STEP 3 dropped it (nothing to do), or a '
      '`prisma db push` ran BEFORE this migration and destroyed the source '
      'rows (restore the database before retrying).';
  END IF;
END $$;

INSERT INTO "EngageTrackedAccount" (
    "id", "configId", "organizationId", "platform", "username", "displayName",
    "audienceSize", "enabled", "lastCheckedAt", "metadata", "createdAt", "updatedAt"
)
SELECT
    c."id",
    c."configId",
    c."organizationId",
    -- CANONICALISED, like the application's write boundary does (normalizePlatform
    -- in engage-scan-target.ts). STEP 0a tolerates 'Reddit' because it tests
    -- lower(platform), so a legacy mixed-case row reaches here; copying it
    -- verbatim would produce a row that `scanTypeFor` (which lowercases) calls a
    -- channel while every SQL predicate on the merged table — all case-sensitive
    -- `in`/`notIn` over CHANNEL_SCOPE_PLATFORMS — calls an author target.
    lower(c."platform"),
    engage_normalize_target_key(c."platform", c."channelId"),
    c."channelName",
    c."audienceSize",
    c."enabled",
    c."lastScannedAt",
    c."metadata",
    c."createdAt",
    c."updatedAt"
FROM "EngageMonitoredChannel" c
ON CONFLICT ("configId", "platform", "username") DO NOTHING;

-- Verify. This LEFT JOIN (on id, so it catches every ON CONFLICT skip) is the
-- load-bearing check — it RAISES instead of printing, because an operator
-- scrolling past a row of output is exactly how a dropped channel goes unnoticed.
DO $$
DECLARE
  v_missing bigint;
BEGIN
  SELECT count(*) INTO v_missing
  FROM "EngageMonitoredChannel" c
  LEFT JOIN "EngageTrackedAccount" t ON t."id" = c."id"
  WHERE t."id" IS NULL;

  IF v_missing > 0 THEN
    RAISE EXCEPTION
      'STEP 2 FAILED: % channel row(s) did not land in EngageTrackedAccount. '
      'Run the SELECT below to list them, resolve the key collision, then '
      're-run STEP 2. Do NOT deploy until this reports zero.', v_missing;
  END IF;

  RAISE NOTICE 'STEP 2 PASSED: every channel row landed with its id preserved.';
END $$;

-- Diagnostic for the failure above (run by hand if STEP 2 raised):
--   SELECT c."id", c."configId", c."platform", c."channelId"
--   FROM "EngageMonitoredChannel" c
--   LEFT JOIN "EngageTrackedAccount" t ON t."id" = c."id"
--   WHERE t."id" IS NULL;

-- Post-condition: no backfilled key may be a value the NEW write path would
-- reject. The write boundary is buildScanTargetKey (engage-scan-target.ts),
-- which validates a CHANNEL-scope key against SUBREDDIT_NAME_RE
-- (^[a-z0-9_]{2,21}$) — NOT the reddit username alphabet, which also admits '-'
-- and runs to 30 chars. Testing the looser rule here would let a key through
-- that the API then refuses: the row could never be re-created, and because
-- setupEngage runs every submitted channel through the same boundary inside its
-- transaction, an org holding such a key gets a 400 on POST /engage/setup for a
-- payload it cannot correct from the UI.
--
-- This is also the ONLY detector for drift between engage_normalize_target_key
-- and normalizeUsername, so it must test what the application tests.
DO $$
DECLARE
  v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad
  FROM "EngageTrackedAccount"
  WHERE lower("platform") = 'reddit'
    AND "username" !~ '^[a-z0-9_]{2,21}$';

  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'STEP 2 FAILED: % reddit row(s) hold a username the application would '
      'reject (buildScanTargetKey / SUBREDDIT_NAME_RE). Either '
      'engage_normalize_target_key drifted from normalizeUsername, or a legacy '
      'channelId was never a valid subreddit name. List them with: SELECT id, '
      '"configId", "username" FROM "EngageTrackedAccount" WHERE '
      'lower("platform") = ''reddit'' AND "username" !~ ''^[a-z0-9_]{2,21}$'';',
      v_bad;
  END IF;
END $$;

-- ─── STEP 2b: normalize channel scan cursors ────────────────────────────────
--
-- Channel units used to key their cursor on the RAW channelId; after the merge
-- both scopes key on the normalized value, so a cursor stored as 'ProjSub'
-- would be orphaned and its unit rescanned from scratch. Delete the ones whose
-- normalized twin already exists (keeping the fresher cursor), then rename the
-- rest. The DELETE's tie-break is a strict total order, so each group collapses
-- to exactly one row — it can never delete both or neither, and the UPDATE that
-- follows therefore cannot violate @@unique([platform, scanType, scanKey]).
--
-- A cursor currently held by a live extension lease may be deleted; that
-- submission is discarded and the unit rescans its freshness window once
-- (ingest dedups the results). Accepted.

DELETE FROM "EngageScanCursor" a
USING "EngageScanCursor" b
WHERE a."scanType" = 'channel'
  AND b."scanType" = 'channel'
  AND a."platform" = b."platform"
  AND a."id" <> b."id"
  AND engage_normalize_target_key(a."platform", a."scanKey")
    = engage_normalize_target_key(b."platform", b."scanKey")
  AND (a."lastScannedAt" IS NULL AND b."lastScannedAt" IS NOT NULL
       OR a."lastScannedAt" < b."lastScannedAt"
       OR (a."lastScannedAt" IS NOT DISTINCT FROM b."lastScannedAt" AND a."id" > b."id"));

UPDATE "EngageScanCursor"
SET "scanKey" = engage_normalize_target_key("platform", "scanKey")
WHERE "scanType" = 'channel'
  AND "scanKey" <> engage_normalize_target_key("platform", "scanKey");

-- ─── STEP 2c: normalize PRE-EXISTING tracked-scope rows ─────────────────────
--
-- STEP 2 normalises the rows it INSERTS; nothing so far touches the rows that
-- were already in EngageTrackedAccount. Those came from the old
-- addTrackedAccount, which validated the NORMALISED form but stored the RAW DTO
-- value — so '@Alice', ' alice ' and 'u/alice' are all present in production.
--
-- After the merge, "username holds the canonical scan-unit key" is a table-wide
-- invariant that the new code relies on: getOrgContextsForUnit resolves
-- subscribers with `equals … insensitive`, which bridges case but NOT a leading
-- '@' or 'u/'. A raw row is enumerated as a scan unit (the enumerator
-- normalises), gets scanned and paid for, then fans out to zero subscribers —
-- the account silently produces no opportunities and loses its +5 scoreTracked.
-- This migration is the change set's only reconciliation vehicle for this table,
-- so it is where the split gets closed.
--
-- Collapse-then-rename, same shape as STEP 2b: the unique index is
-- (configId, platform, username), so colliding rows must go before the rename.
-- Keeps the enabled row, then the more recently updated one, then the smaller id
-- — a strict total order, so each group collapses to exactly one survivor.

DELETE FROM "EngageTrackedAccount" a
USING "EngageTrackedAccount" b
WHERE lower(a."platform") NOT IN ('reddit')          -- tracked scope only
  AND a."configId" = b."configId"
  AND lower(a."platform") = lower(b."platform")
  AND a."id" <> b."id"
  AND engage_normalize_target_key(a."platform", a."username")
    = engage_normalize_target_key(b."platform", b."username")
  AND (a."enabled" < b."enabled"
       OR (a."enabled" = b."enabled" AND a."updatedAt" < b."updatedAt")
       OR (a."enabled" = b."enabled" AND a."updatedAt" IS NOT DISTINCT FROM b."updatedAt"
           AND a."id" > b."id"));

UPDATE "EngageTrackedAccount"
SET "platform" = lower("platform"),
    "username" = engage_normalize_target_key("platform", "username")
WHERE "platform" <> lower("platform")
   OR "username" <> engage_normalize_target_key("platform", "username");

-- Tracked-scope cursors were keyed by the NORMALISED username all along (the
-- enumerator normalises), so they already match and need no rewrite — unlike
-- the channel cursors STEP 2b had to move.

-- Verify: every row now carries its canonical key, so the invariant the merged
-- code depends on holds for the whole table, not just the half we inserted.
DO $$
DECLARE
  v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad
  FROM "EngageTrackedAccount"
  WHERE "platform" <> lower("platform")
     OR "username" <> engage_normalize_target_key("platform", "username");

  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'STEP 2c FAILED: % row(s) still hold a non-canonical platform/username.', v_bad;
  END IF;

  RAISE NOTICE 'STEP 2c PASSED: every scan-target row holds its canonical key.';
END $$;

-- ─── STEP 3: drop the old table (run NOW — see RUN ORDER note 3) ────────────

-- DROP TABLE IF EXISTS "EngageMonitoredChannel";

-- ─── Cleanup (optional, after STEP 3) ───────────────────────────────────────

-- DROP FUNCTION IF EXISTS engage_normalize_target_key(text, text);

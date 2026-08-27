-- Indexes backing the platform write floor (EngageRepository.getLastPlatformWriteAt).
--
-- WHY THIS FILE EXISTS SEPARATELY FROM THE SCHEMA
--
-- Both indexes ARE declared in schema.prisma, so a fresh database provisioned by
-- `pnpm run prisma-db-push` already has them and this file is unnecessary there.
-- It exists for the UPGRADE of a database that already holds data.
--
-- `prisma db push` issues a plain `CREATE INDEX`, which takes an ACCESS EXCLUSIVE
-- lock for the duration of the build. `Post` is the largest table in the schema,
-- so on a production-sized instance that blocks every write to it — including the
-- publish queue's own claims — for as long as the build takes.
--
-- `CREATE INDEX CONCURRENTLY` does not take that lock. It cannot run inside a
-- transaction block, which is why it cannot live in engage-indexes.sql (executed
-- as one file by `prisma db execute`) and must be run by hand, statement by
-- statement, BEFORE the deploy. `db push` then finds both indexes already present
-- and does nothing.
--
-- Index names match Prisma's own convention exactly — `{Model}_{fields}_idx` —
-- so `db push` recognises them as the schema-declared ones. A different name
-- would leave push creating a duplicate under its own name, with the lock this
-- file exists to avoid.
--
-- Usage (run each statement on its own, not as a file):
--   psql "$DATABASE_URL" -c 'CREATE INDEX CONCURRENTLY ...'
--
-- If a CONCURRENTLY build fails it leaves an INVALID index behind; drop it
-- (`DROP INDEX CONCURRENTLY "<name>"`) and re-run. Check with:
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;

-- The post side of the write clock: last extension-claimed, non-engage post on
-- this platform for this org. Without it the query filters a single-column index
-- and sorts the survivors, once per platform per extension reply poll.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Post_organizationId_providerIdentifier_claimedAt_idx"
  ON "Post"("organizationId", "providerIdentifier", "claimedAt");

-- The reply side. getLastPlatformWriteAt deliberately drops the project scope —
-- the throttle belongs to the platform account, not to one project — so the
-- existing (organizationId, projectId, createdAt) composite cannot serve it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "EngageSentReply_organizationId_createdAt_idx"
  ON "EngageSentReply"("organizationId", "createdAt");

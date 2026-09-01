/**
 * Backfill `Post.referenceOpportunityId` onto existing Engage reply posts.
 *
 * WHY THIS EXISTS
 * ----------------
 * docs/engage/reference-post-generation.md §4.2 added `referenceOpportunityId`
 * as the ONE queryable column for "does this post trace back to an
 * EngageOpportunity" — used going forward by the reference-post generation
 * feature. Existing Engage REPLY posts (source='engage') already carry this
 * link, just under a different name: `EngageSentReply.opportunityId`. This
 * script copies that existing link onto the new column so it means the same
 * thing everywhere, instead of "check referenceOpportunityId" for one kind of
 * post and "join EngageSentReply" for another.
 *
 * This is pure data hygiene, not a correctness fix: reply behavior never
 * depended on this column and does not start depending on it here —
 * `EngageSentReply.opportunityId` remains the authoritative link for replies
 * (see §4.4). Safe to skip entirely if you don't care about querying reply
 * posts through the new column; the reference-post generation feature itself
 * does not require this backfill to function.
 *
 * WHAT IT WRITES
 * ---------------
 * Post.referenceOpportunityId ← EngageSentReply.opportunityId, for every
 * Post that has a EngageSentReply row and currently has NULL
 * referenceOpportunityId. Idempotent: a second run matches zero rows.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-reference-opportunity.ts
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-reference-opportunity.ts --execute
 *
 * Dry run (the default) only lists matching rows (grouped by org) and writes
 * nothing.
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { PrismaClient, Prisma } from '@prisma/client';

interface CliArgs {
  orgId: string | null;
  dryRun: boolean;
}

function printHelp(): void {
  console.log(`
Usage: npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-reference-opportunity.ts [options]

Optional:
  --org <id>   Limit to a single organization
  --dry-run    List matching rows and write nothing (default)
  --execute    Also persist Post.referenceOpportunityId
  --help       Show this help message

Copies EngageSentReply.opportunityId onto Post.referenceOpportunityId for
every reply post that does not have it set yet. See the file header for why.
`);
}

export function parseArgs(argv: string[]): CliArgs {
  let orgId: string | null = null;
  let dryRun = true;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--org':
        orgId = argv[++i] ?? null;
        break;
      case '--execute':
        dryRun = false;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        printHelp();
        process.exit(1);
    }
  }
  return { orgId, dryRun };
}

interface Candidate {
  postId: string;
  opportunityId: string;
  organizationId: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  const orgFilter = args.orgId
    ? Prisma.sql`AND esr."organizationId" = ${args.orgId}`
    : Prisma.empty;

  // Listed, not just counted — same reasoning as
  // cleanup-broken-url-opportunities.ts: a bare COUNT(*) says nothing an
  // operator could act on, and updating by this exact id list (rather than
  // re-running the same WHERE clause inside the UPDATE) guarantees --execute
  // touches precisely what --dry-run just reported.
  const candidates = await prisma.$queryRaw<Candidate[]>(Prisma.sql`
    SELECT p.id AS "postId", esr."opportunityId", esr."organizationId"
    FROM "Post" p
    JOIN "EngageSentReply" esr ON esr."postId" = p.id
    WHERE p."referenceOpportunityId" IS NULL
    ${orgFilter}
  `);

  console.log(`Reply posts missing referenceOpportunityId: ${candidates.length}`);
  if (!candidates.length) {
    await prisma.$disconnect();
    return;
  }

  const byOrg = new Map<string, number>();
  for (const c of candidates) {
    byOrg.set(c.organizationId, (byOrg.get(c.organizationId) ?? 0) + 1);
  }
  if (byOrg.size > 1) {
    console.log('\n── By organization ───────────────────────────');
    for (const [org, n] of [...byOrg].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${org}  ${n}`);
    }
  }

  if (args.dryRun) {
    console.log('\n(dry run — pass --execute to write)');
    await prisma.$disconnect();
    return;
  }

  let written = 0;
  for (const c of candidates) {
    await prisma.post.update({
      where: { id: c.postId },
      data: { referenceOpportunityId: c.opportunityId },
    });
    written++;
  }
  console.log(`\nRows updated: ${written}`);
  await prisma.$disconnect();
}

// Guarded so the spec can import parseArgs without running a backfill as a
// side effect of the import.
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

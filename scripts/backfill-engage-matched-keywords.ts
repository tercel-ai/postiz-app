/**
 * Backfill EngageOpportunityState.matchedKeywords for rows persisted before the
 * field existed (they default to an empty array). The signal-feed card and the
 * sent-list card only render the "# keyword" chips when matchedKeywords is
 * non-empty, so existing opportunities show no chips until a scan re-upserts
 * them. This script fills them immediately by re-matching each opportunity's
 * postContent against its org's CURRENT enabled keywords — the same thing the
 * scan's phase-2 upsert does on its next run.
 *
 * Match semantics reuse engage-scorer.ts `postMatchesKeyword` verbatim (ASCII
 * word-boundary vs CJK substring), so backfilled hits match scan-time hits.
 * Only enabled keywords count (mirrors scorePost's `k.enabled && ...` filter).
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-matched-keywords.ts --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-matched-keywords.ts --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-matched-keywords.ts --org <orgId> --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-matched-keywords.ts --all --execute   # also recompute non-empty rows
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { PrismaClient } from '@prisma/client';
import { postMatchesKeyword } from '@gitroom/nestjs-libraries/engage/engage-scorer';

interface CliArgs {
  orgId: string | null;
  dryRun: boolean;
  all: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let orgId: string | null = null;
  let dryRun = true;
  let all = false;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--org':
        orgId = args[++i] ?? null;
        if (!orgId) { console.error('--org requires a value'); process.exit(1); }
        break;
      case '--execute': dryRun = false; break;
      case '--dry-run': dryRun = true; break;
      case '--all': all = true; break;
      case '--help':
        console.log('Usage: backfill-engage-matched-keywords.ts [--org <id>] [--all] [--dry-run|--execute]');
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }
  return { orgId, dryRun, all };
}

/** Enabled keyword texts for an org (mirrors scorePost's enabled-only filter). */
async function enabledKeywords(
  prisma: PrismaClient,
  organizationId: string
): Promise<string[]> {
  const rows = await prisma.engageKeyword.findMany({
    where: { organizationId, enabled: true },
    select: { keyword: true },
  });
  return rows.map((r) => r.keyword);
}

/** Same-set comparison so a no-op write is skipped (order-independent). */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('=== Backfill EngageOpportunityState.matchedKeywords ===\n');
  console.log(`Mode:  ${args.dryRun ? 'DRY RUN (no changes)' : 'EXECUTE'}`);
  console.log(`Org:   ${args.orgId ?? 'all'}`);
  console.log(`Scope: ${args.all ? 'all rows (recompute)' : 'rows with no keywords yet (incl. legacy NULL)'}\n`);

  const prisma = new PrismaClient();

  // NOTE: we do NOT pre-filter with `matchedKeywords: { isEmpty: true }`. Rows
  // created before the column existed are SQL NULL (db push added the String[]
  // nullable, no default), and Prisma's `isEmpty` compiles to a cardinality
  // predicate that does not match NULL — it would silently skip every legacy
  // row. Instead we fetch all rows (optionally org-scoped) and decide per-row
  // using the client value, which Prisma normalizes NULL → [] (so length === 0
  // catches both NULL and empty {}). For the bounded engage tables this full
  // scan is fine; it is a one-off backfill.
  const rows = await prisma.engageOpportunityState.findMany({
    where: {
      ...(args.orgId ? { organizationId: args.orgId } : {}),
    },
    select: {
      organizationId: true,
      opportunityId: true,
      matchedKeywords: true,
      opportunity: { select: { postContent: true } },
    },
  });

  console.log(`Found ${rows.length} state row${rows.length === 1 ? '' : 's'} to process.\n`);

  const keywordCache = new Map<string, string[]>();
  let matched = 0;   // rows that resolved to >=1 keyword
  let unchanged = 0; // rows already correct (no write needed)
  let empty = 0;     // rows that match no current enabled keyword
  let written = 0;

  for (const r of rows) {
    if (!keywordCache.has(r.organizationId)) {
      keywordCache.set(r.organizationId, await enabledKeywords(prisma, r.organizationId));
    }
    // Skip rows that already carry keywords unless --all forces a recompute.
    // r.matchedKeywords is [] for both legacy NULL and empty {} (Prisma normalizes).
    if (!args.all && r.matchedKeywords.length > 0) {
      unchanged++;
      continue;
    }

    const keywords = keywordCache.get(r.organizationId)!;
    const content = r.opportunity?.postContent ?? '';
    const hits = keywords.filter((kw) => postMatchesKeyword(content, kw));

    if (hits.length === 0) {
      empty++;
      continue; // leave as [] — no current enabled keyword matches this post
    }
    if (sameSet(hits, r.matchedKeywords)) {
      unchanged++;
      continue;
    }

    matched++;
    console.log(
      `  [${r.organizationId.slice(0, 8)}] opp=${r.opportunityId.slice(0, 8)}  -> [${hits.join(', ')}]`
    );

    if (!args.dryRun) {
      await prisma.engageOpportunityState.update({
        where: {
          organizationId_opportunityId: {
            organizationId: r.organizationId,
            opportunityId: r.opportunityId,
          },
        },
        data: { matchedKeywords: hits },
      });
      written++;
    }
  }

  console.log(
    `\n${args.dryRun ? 'Would fill' : 'Filled'}: ${matched}, ` +
    `already-correct: ${unchanged}, no-current-match: ${empty}` +
    (args.dryRun ? '\n\n--- DRY RUN. Re-run with --execute to write. ---' : `, written: ${written}`)
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

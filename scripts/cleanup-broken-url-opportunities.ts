/**
 * Retire EngageOpportunity rows whose stored address is not a single post AND
 * that never cost anyone anything.
 *
 * WHY THESE ROWS EXIST
 *   The extension's LinkedIn scraper used to take a card's first link matching
 *   [href*="/posts/"]. On a card authored by a company page that link is the
 *   page's own "Posts" TAB (…/company/<slug>/posts/) — it sits in the card
 *   header, before the real permalink, and querySelector returns matches in
 *   document order. So company-authored rows were stored pointing at a post
 *   LIST, which has no comment box: every reply against them failed to post.
 *   The scraper is fixed; these rows keep the bad address until something acts.
 *
 * THE SPLIT THIS SCRIPT ENFORCES
 *   Rows that DID cost something are never touched here. Someone paid for those
 *   reply drafts and they failed to send only because the address was wrong, so
 *   the address gets repaired (extension options → Engage opportunities) and the
 *   queued replies go out. Deleting them would destroy paid work.
 *   Rows that cost nothing are deletable: an engage opportunity is perishable,
 *   and a re-scan re-ingests whatever still matters with a correct address.
 *
 * WHAT COUNTS AS "COST SOMETHING" — three independent signals, ANY of which
 * spares a row. One is not enough:
 *
 *   1. An EngageSentReply row (a reply was sent, or is queued to be).
 *   2. A non-empty EngageOpportunityState.generationHistory.
 *   3. ANY BillingRecord with businessType='engage_reply' and relatedId=<id>,
 *      whatever its status.
 *
 *   (3) is the authoritative ledger and the reason (2) alone is unsafe:
 *   generationHistory was added later, so legacy paid generations have it as
 *   SQL NULL (see backfill-engage-generation-history.ts). Judging by (2) alone
 *   would read those as free and delete them.
 *
 *   Status is deliberately NOT filtered in (3), even though 'released' means the
 *   reservation was given back. releaseReplyGeneration is called from two places
 *   in the auto-reply flow (engage-auto-reply.service.ts): when generateDraft
 *   throws — nothing was produced — AND when queueAutoReply fails to persist a
 *   draft that WAS already generated. The second case burned a real generation,
 *   and it is indistinguishable from the first in the data: same 'released'
 *   status, no EngageSentReply, no generationHistory. Since a draft that exists
 *   must never be deleted and the two cases cannot be told apart, the presence
 *   of the charge row alone spares the opportunity. The cost of being wrong in
 *   this direction is a dead row left behind; in the other direction it is
 *   destroying generated work.
 *
 * DELETION
 *   Hard delete, so nothing is left referencing a row nobody can reach.
 *   EngageOpportunityState is onDelete: Cascade and goes with it. EngageSentReply
 *   is deliberately NOT cascaded in the schema, so if a spared-row check ever
 *   missed something, Postgres refuses the delete instead of silently taking the
 *   paid reply with it — the transaction aborts and nothing is lost.
 *   BillingRecord is intentionally left alone: it is an accounting ledger keyed
 *   by relatedId, not a child row, and it must survive the thing it billed for.
 *
 * USAGE
 *   npx tsx scripts/cleanup-broken-url-opportunities.ts                      # dry run, linkedin
 *   npx tsx scripts/cleanup-broken-url-opportunities.ts --platform=quora
 *   npx tsx scripts/cleanup-broken-url-opportunities.ts --platform=all
 *   npx tsx scripts/cleanup-broken-url-opportunities.ts --limit=50 --execute
 *   npx tsx scripts/cleanup-broken-url-opportunities.ts --soft --execute     # deletedAt instead
 *
 * FLAGS
 *   --platform=<name|all>  Default 'linkedin'.
 *   --limit=<n>            Cap the batch; useful for a cautious first run.
 *   --execute              Actually delete. Without it nothing is written.
 *   --soft                 Set deletedAt instead of removing rows. Leaves the
 *                          related rows in place, so it does NOT satisfy "clean
 *                          up the related records" — offered for a reversible
 *                          first pass.
 *   --verbose              List every row, not just a sample.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { PrismaClient, Prisma } from '@prisma/client';

/** Addresses that are NOT a single post, and so can never be replied to. */
const BROKEN_URL_SQL = Prisma.sql`
  (
    "externalPostUrl" IS NULL
    OR "externalPostUrl" = ''
    OR "externalPostUrl" ~ '^https?://(www\\.)?linkedin\\.com/(company|school|showcase)/'
  )
`;

interface Candidate {
  id: string;
  platform: string;
  externalPostId: string;
  externalPostUrl: string;
  postContent: string;
  postPublishedAt: Date;
}

interface Args {
  platform: string | null;
  limit: number | null;
  execute: boolean;
  soft: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const platformRaw = get('platform') ?? 'linkedin';
  const limitRaw = get('limit');
  return {
    platform: platformRaw === 'all' ? null : platformRaw,
    limit: limitRaw ? Math.max(1, parseInt(limitRaw, 10)) : null,
    execute: argv.includes('--execute'),
    soft: argv.includes('--soft'),
    verbose: argv.includes('--verbose'),
  };
}

/**
 * Rows with a broken address, split by whether anything was ever charged or
 * generated against them.
 *
 * The three spare-signals are evaluated in SQL rather than in JS so a row is
 * never classified from a partially-loaded relation.
 */
async function loadCandidates(
  prisma: PrismaClient,
  args: Args
): Promise<{ deletable: Candidate[]; spared: Candidate[] }> {
  const platformFilter = args.platform
    ? Prisma.sql`AND o."platform" = ${args.platform}`
    : Prisma.empty;

  const paidSignals = Prisma.sql`
    EXISTS (SELECT 1 FROM "EngageSentReply" r WHERE r."opportunityId" = o."id")
    OR EXISTS (
      SELECT 1 FROM "EngageOpportunityState" s
      WHERE s."opportunityId" = o."id"
        AND s."generationHistory" IS NOT NULL
        AND jsonb_typeof(s."generationHistory") = 'array'
        AND jsonb_array_length(s."generationHistory") > 0
    )
    OR EXISTS (
      SELECT 1 FROM "BillingRecord" b
      WHERE b."relatedId" = o."id"
        AND b."businessType" = 'engage_reply'
    )
  `;

  // Listed, not just counted: these are the rows that actually need doing
  // something about — each one is a broken address someone already paid to
  // reply to. A bare count tells an operator nothing about what to repair.
  const spared = await prisma.$queryRaw<Candidate[]>(Prisma.sql`
    SELECT o."id", o."platform", o."externalPostId", o."externalPostUrl",
           o."postContent", o."postPublishedAt"
    FROM "EngageOpportunity" o
    WHERE o."deletedAt" IS NULL
      AND ${BROKEN_URL_SQL}
      ${platformFilter}
      AND (${paidSignals})
    ORDER BY o."postPublishedAt" DESC
  `);

  const deletable = await prisma.$queryRaw<Candidate[]>(Prisma.sql`
    SELECT o."id", o."platform", o."externalPostId", o."externalPostUrl",
           o."postContent", o."postPublishedAt"
    FROM "EngageOpportunity" o
    WHERE o."deletedAt" IS NULL
      AND ${BROKEN_URL_SQL}
      ${platformFilter}
      AND NOT (${paidSignals})
    ORDER BY o."postPublishedAt" DESC
    ${args.limit ? Prisma.sql`LIMIT ${args.limit}` : Prisma.empty}
  `);

  return { deletable, spared };
}

function summarise(rows: Candidate[]): Map<string, number> {
  const byPlatform = new Map<string, number>();
  for (const r of rows) {
    byPlatform.set(r.platform, (byPlatform.get(r.platform) ?? 0) + 1);
  }
  return byPlatform;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  console.log('=== Broken-address opportunity clean-up ===');
  console.log(`platform : ${args.platform ?? '(all)'}`);
  console.log(`mode     : ${args.execute ? (args.soft ? 'SOFT DELETE' : 'HARD DELETE') : 'dry run'}`);
  console.log(`limit    : ${args.limit ?? '(none)'}\n`);

  try {
    const { deletable, spared } = await loadCandidates(prisma, args);

    console.log(
      `${spared.length} row(s) SPARED — they have replies, generation history, or an ` +
        'engage_reply charge of any status.\n'
    );
    if (spared.length) {
      // An id that is a plain number came from a card's data-urn and can be
      // resolved back to a real address; an `sdui-` id is a hash of the search
      // card's wrapper and encodes nothing, so no address can be rebuilt from
      // it. The split decides whether the panel can repair a row at all.
      const repairable = spared.filter((r) => /^\d+$/.test(r.externalPostId));
      console.log('  These are the rows that need repairing, not deleting:');
      for (const r of spared) {
        const kind = /^\d+$/.test(r.externalPostId) ? 'repairable' : 'NO ID    ';
        console.log(
          `    [${kind}] ${r.externalPostId.padEnd(24)} ${(r.externalPostUrl || '(no url)').slice(0, 55)}`
        );
      }
      console.log(
        `\n  ${repairable.length} of ${spared.length} have a numeric post id, so the ` +
          'extension can resolve their real address\n  (options → Engage ' +
          'opportunities → Probe, then Apply). The rest carry only a synthetic\n' +
          '  SDUI token and cannot be repaired automatically — handle those by hand.\n'
      );
    }

    if (deletable.length === 0) {
      console.log('Nothing to delete.');
      return;
    }

    console.log(`${deletable.length} row(s) deletable, by platform:`);
    for (const [platform, count] of summarise(deletable)) {
      console.log(`  ${platform.padEnd(12)} ${count}`);
    }

    const shown = args.verbose ? deletable : deletable.slice(0, 10);
    console.log(`\n${args.verbose ? 'All rows' : 'Sample'}:`);
    for (const r of shown) {
      console.log(
        `  ${r.platform.padEnd(10)} ${r.externalPostId.padEnd(24)} ` +
          `${(r.externalPostUrl || '(no url)').slice(0, 60).padEnd(60)} ` +
          `${r.postContent.replace(/\s+/g, ' ').slice(0, 40)}`
      );
    }
    if (!args.verbose && deletable.length > shown.length) {
      console.log(`  … ${deletable.length - shown.length} more (--verbose to list)`);
    }

    if (!args.execute) {
      console.log('\n[DRY RUN] Nothing written. Pass --execute to apply.');
      return;
    }

    const ids = deletable.map((r) => r.id);

    if (args.soft) {
      const result = await prisma.engageOpportunity.updateMany({
        where: { id: { in: ids } },
        data: { deletedAt: new Date() },
      });
      console.log(`\nSoft-deleted ${result.count} row(s).`);
      console.log(
        'Related rows were left in place — soft delete only hides the parent. ' +
          'Re-run without --soft to remove them for real.'
      );
      return;
    }

    // EngageOpportunityState cascades. EngageSentReply does not, by design: if
    // anything slipped through the spare-signals check, Postgres raises a
    // foreign-key violation here and the whole delete aborts rather than
    // destroying a paid reply.
    const result = await prisma.engageOpportunity.deleteMany({
      where: { id: { in: ids } },
    });
    console.log(`\nDeleted ${result.count} opportunity row(s) (states cascaded).`);
    console.log('BillingRecord rows were intentionally left untouched — an accounting');
    console.log('ledger must outlive what it billed for.');
  } catch (err: any) {
    if (err?.code === 'P2003' || /foreign key/i.test(String(err?.message))) {
      console.error(
        '\nRefused: a row still has a referencing record (most likely an ' +
          'EngageSentReply). Nothing was deleted. This is the safety net working — ' +
          'investigate before forcing anything.'
      );
    }
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Restore published/errored clones that were incorrectly soft-deleted
 * when their parent recurring post was cancelled or edited.
 *
 * Root cause: deletePost() and createOrUpdatePost() used to soft-delete
 * ALL posts in a group, including PUBLISHED and ERROR clones.
 * Fixed in this commit — this script recovers historical data.
 *
 * Safety checks:
 *   - Only restores clones (sourcePostId is not null)
 *   - Only PUBLISHED or ERROR state (actually posted to platform or failed)
 *   - Excludes clones whose integration was deleted (would show broken data)
 *   - Dry-run by default
 *
 * Usage:
 *   npx ts-node scripts/restore-deleted-clones.ts --dry-run
 *   npx ts-node scripts/restore-deleted-clones.ts --execute
 *   npx ts-node scripts/restore-deleted-clones.ts --org <orgId> --dry-run
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const orgFlag = args.indexOf('--org');
  const orgId = orgFlag !== -1 ? args[orgFlag + 1] : undefined;

  if (dryRun) {
    console.log('=== DRY RUN (pass --execute to apply changes) ===\n');
  }

  // Find clones that:
  // 1. Have a sourcePostId (are clones of a recurring post)
  // 2. Were in PUBLISHED or ERROR state
  // 3. Are currently soft-deleted (deletedAt is not null)
  // 4. Their integration still exists and is not deleted
  const affectedClones = await prisma.post.findMany({
    where: {
      sourcePostId: { not: null },
      deletedAt: { not: null },
      OR: [
        { state: 'PUBLISHED' },
        { state: 'ERROR' },
      ],
      integration: {
        deletedAt: null,
      },
      ...(orgId ? { organizationId: orgId } : {}),
    },
    select: {
      id: true,
      sourcePostId: true,
      state: true,
      publishDate: true,
      deletedAt: true,
      releaseURL: true,
      organizationId: true,
      group: true,
      integration: {
        select: {
          name: true,
          providerIdentifier: true,
        },
      },
    },
    orderBy: { publishDate: 'desc' },
  });

  if (affectedClones.length === 0) {
    console.log('No incorrectly deleted clones found. Nothing to restore.');
    return;
  }

  // Summary stats
  const publishedCount = affectedClones.filter((c) => c.state === 'PUBLISHED').length;
  const errorCount = affectedClones.filter((c) => c.state === 'ERROR').length;
  console.log(
    `Found ${affectedClones.length} deleted clone(s) to restore ` +
    `(${publishedCount} PUBLISHED, ${errorCount} ERROR):\n`
  );

  // Group by org for readability
  const byOrg = new Map<string, typeof affectedClones>();
  for (const clone of affectedClones) {
    const list = byOrg.get(clone.organizationId) || [];
    list.push(clone);
    byOrg.set(clone.organizationId, list);
  }

  for (const [org, clones] of byOrg) {
    console.log(`  Org ${org}: ${clones.length} clone(s)`);
    for (const c of clones) {
      console.log(
        `    ${c.id} | ${c.state.padEnd(9)} | ${c.publishDate.toISOString().slice(0, 10)} | ` +
        `${c.integration?.providerIdentifier || '?'}/${c.integration?.name || '?'} | ` +
        `deleted=${c.deletedAt?.toISOString().slice(0, 19)} | ` +
        `url=${c.releaseURL || 'none'}`
      );
    }
    console.log();
  }

  if (dryRun) {
    console.log(`Dry run complete. Run with --execute to restore these ${affectedClones.length} clone(s).`);
    return;
  }

  // Restore: set deletedAt back to null
  const ids = affectedClones.map((c) => c.id);
  const result = await prisma.post.updateMany({
    where: {
      id: { in: ids },
    },
    data: {
      deletedAt: null,
    },
  });

  console.log(`Restored ${result.count} clone(s).`);
}

main()
  .catch((err) => {
    console.error('Script failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

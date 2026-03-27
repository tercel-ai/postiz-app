/**
 * Fix historical clones that still have sourcePostId set.
 *
 * Two cases:
 *   A) Deleted clones (deletedAt set) — restore + clear sourcePostId
 *   B) Active clones (deletedAt null) — clear sourcePostId only
 *
 * After this script, all PUBLISHED/ERROR clones become standalone posts.
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

  const orgFilter = orgId ? { organizationId: orgId } : {};

  // Case A: deleted clones with sourcePostId
  const deletedClones = await prisma.post.findMany({
    where: {
      sourcePostId: { not: null },
      deletedAt: { not: null },
      state: { in: ['PUBLISHED', 'ERROR'] },
      ...orgFilter,
    },
    select: {
      id: true, state: true, publishDate: true, deletedAt: true,
      releaseURL: true, organizationId: true, group: true,
      integration: { select: { name: true, providerIdentifier: true, deletedAt: true } },
    },
    orderBy: { publishDate: 'desc' },
  });

  // Case B: active clones still referencing sourcePostId
  const orphanedClones = await prisma.post.findMany({
    where: {
      sourcePostId: { not: null },
      deletedAt: null,
      state: { in: ['PUBLISHED', 'ERROR'] },
      ...orgFilter,
    },
    select: {
      id: true, state: true, publishDate: true,
      releaseURL: true, organizationId: true, group: true,
      integration: { select: { name: true, providerIdentifier: true } },
    },
    orderBy: { publishDate: 'desc' },
  });

  // Filter: skip deleted clones whose integration is also deleted
  const restorableDeleted = deletedClones.filter(
    (c) => c.integration && !c.integration.deletedAt
  );
  const skippedDeleted = deletedClones.length - restorableDeleted.length;

  console.log(`Case A: ${restorableDeleted.length} deleted clone(s) to restore`);
  if (skippedDeleted > 0) {
    console.log(`  (skipping ${skippedDeleted} with deleted integrations)`);
  }
  for (const c of restorableDeleted.slice(0, 10)) {
    console.log(
      `  ${c.id} | ${c.state.padEnd(9)} | ${c.publishDate.toISOString().slice(0, 10)} | ` +
      `${c.integration?.providerIdentifier}/${c.integration?.name} | ` +
      `url=${c.releaseURL?.slice(0, 50) || 'none'}`
    );
  }
  if (restorableDeleted.length > 10) {
    console.log(`  ... and ${restorableDeleted.length - 10} more`);
  }

  console.log(`\nCase B: ${orphanedClones.length} active clone(s) with stale sourcePostId`);
  for (const c of orphanedClones.slice(0, 10)) {
    console.log(
      `  ${c.id} | ${c.state.padEnd(9)} | ${c.publishDate.toISOString().slice(0, 10)} | ` +
      `${c.integration?.providerIdentifier}/${c.integration?.name}`
    );
  }
  if (orphanedClones.length > 10) {
    console.log(`  ... and ${orphanedClones.length - 10} more`);
  }

  const totalFixes = restorableDeleted.length + orphanedClones.length;
  if (totalFixes === 0) {
    console.log('\nNothing to fix.');
    return;
  }

  if (dryRun) {
    console.log(`\nDry run complete. ${totalFixes} fix(es) pending. Run with --execute to apply.`);
    return;
  }

  let fixed = 0;

  // Case A: restore + clear sourcePostId
  if (restorableDeleted.length > 0) {
    const result = await prisma.post.updateMany({
      where: { id: { in: restorableDeleted.map((c) => c.id) } },
      data: { deletedAt: null, sourcePostId: null },
    });
    fixed += result.count;
    console.log(`\nCase A: restored ${result.count} deleted clone(s)`);
  }

  // Case B: clear sourcePostId only
  if (orphanedClones.length > 0) {
    const result = await prisma.post.updateMany({
      where: { id: { in: orphanedClones.map((c) => c.id) } },
      data: { sourcePostId: null },
    });
    fixed += result.count;
    console.log(`Case B: detached ${result.count} active clone(s)`);
  }

  console.log(`\nTotal fixed: ${fixed}`);
}

main()
  .catch((err) => {
    console.error('Script failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

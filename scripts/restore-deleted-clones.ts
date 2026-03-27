/**
 * Fix historical clones affected by the recurring post delete bug.
 *
 * Three cases:
 *   A) Deleted clones with sourcePostId set — restore + clear sourcePostId
 *   B) Active clones with stale sourcePostId — clear sourcePostId only
 *   C) Deleted PUBLISHED/ERROR posts in a recurring group with sourcePostId
 *      already null — restore (they were real posts deleted by the old
 *      blanket deletePost that didn't preserve published clones)
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

  // ── Case A: deleted clones with sourcePostId ──
  const deletedWithSource = await prisma.post.findMany({
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

  const caseA = deletedWithSource.filter((c) => c.integration && !c.integration.deletedAt);
  const caseASkipped = deletedWithSource.length - caseA.length;

  // ── Case B: active clones with stale sourcePostId ──
  const caseB = await prisma.post.findMany({
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

  // ── Case C: deleted PUBLISHED/ERROR posts in recurring groups ──
  // These have sourcePostId=null but belong to a group that has/had a
  // recurring original (intervalInDays set). The old deletePost nuked them.
  // Step 1: find all groups that contain a recurring post (deleted or not)
  const recurringGroups = await prisma.post.findMany({
    where: {
      intervalInDays: { not: null },
      ...orgFilter,
    },
    select: { group: true },
    distinct: ['group'],
  });
  const recurringGroupSet = new Set(recurringGroups.map((r) => r.group));

  // Step 2: find deleted PUBLISHED/ERROR posts in those groups
  //         that have sourcePostId=null (not caught by Case A)
  //         and are NOT the original (intervalInDays is null)
  const deletedInRecurringGroups = recurringGroupSet.size > 0
    ? await prisma.post.findMany({
        where: {
          group: { in: [...recurringGroupSet] },
          deletedAt: { not: null },
          sourcePostId: null,
          intervalInDays: null,
          parentPostId: null,
          state: { in: ['PUBLISHED', 'ERROR'] },
          integration: { deletedAt: null },
          ...orgFilter,
        },
        select: {
          id: true, state: true, publishDate: true, deletedAt: true,
          releaseURL: true, organizationId: true, group: true,
          integration: { select: { name: true, providerIdentifier: true } },
        },
        orderBy: { publishDate: 'desc' },
      })
    : [];

  // Exclude any that are also in Case A (shouldn't overlap, but be safe)
  const caseAIds = new Set(caseA.map((c) => c.id));
  const caseC = deletedInRecurringGroups.filter((c) => !caseAIds.has(c.id));

  // ── Report ──
  function printSample(items: any[], maxItems = 10) {
    for (const c of items.slice(0, maxItems)) {
      console.log(
        `  ${c.id} | ${c.state.padEnd(9)} | ${c.publishDate.toISOString().slice(0, 10)} | ` +
        `${c.integration?.providerIdentifier || '?'}/${c.integration?.name || '?'} | ` +
        `url=${c.releaseURL?.slice(0, 50) || 'none'}`
      );
    }
    if (items.length > maxItems) {
      console.log(`  ... and ${items.length - maxItems} more`);
    }
  }

  console.log(`Case A: ${caseA.length} deleted clone(s) with sourcePostId to restore`);
  if (caseASkipped > 0) console.log(`  (skipping ${caseASkipped} with deleted integrations)`);
  printSample(caseA);

  console.log(`\nCase B: ${caseB.length} active clone(s) with stale sourcePostId to detach`);
  printSample(caseB);

  console.log(`\nCase C: ${caseC.length} deleted post(s) in recurring groups to restore`);
  printSample(caseC);

  const totalFixes = caseA.length + caseB.length + caseC.length;
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
  if (caseA.length > 0) {
    const result = await prisma.post.updateMany({
      where: { id: { in: caseA.map((c) => c.id) } },
      data: { deletedAt: null, sourcePostId: null },
    });
    fixed += result.count;
    console.log(`\nCase A: restored ${result.count} deleted clone(s)`);
  }

  // Case B: clear sourcePostId only
  if (caseB.length > 0) {
    const result = await prisma.post.updateMany({
      where: { id: { in: caseB.map((c) => c.id) } },
      data: { sourcePostId: null },
    });
    fixed += result.count;
    console.log(`Case B: detached ${result.count} active clone(s)`);
  }

  // Case C: restore deleted posts in recurring groups
  if (caseC.length > 0) {
    const result = await prisma.post.updateMany({
      where: { id: { in: caseC.map((c) => c.id) } },
      data: { deletedAt: null },
    });
    fixed += result.count;
    console.log(`Case C: restored ${result.count} post(s) from recurring groups`);
  }

  console.log(`\nTotal fixed: ${fixed}`);
}

main()
  .catch((err) => {
    console.error('Script failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

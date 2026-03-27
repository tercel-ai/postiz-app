/**
 * Fix historical data affected by recurring post bugs.
 *
 * Four cases:
 *   A) Deleted clones with sourcePostId set — restore + clear sourcePostId
 *   B) Active clones with stale sourcePostId — clear sourcePostId only
 *   C) Deleted PUBLISHED/ERROR posts in recurring groups — restore
 *   D) Active PUBLISHED/ERROR posts with parentPostId set that are daily
 *      recurring clones (not real thread replies) — clear parentPostId
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

  // ── Case C: deleted PUBLISHED/ERROR in recurring groups ──
  const recurringGroups = await prisma.post.findMany({
    where: { intervalInDays: { not: null }, ...orgFilter },
    select: { group: true },
    distinct: ['group'],
  });
  const recurringGroupSet = new Set(recurringGroups.map((r) => r.group));

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
  const caseAIds = new Set(caseA.map((c) => c.id));
  const caseC = deletedInRecurringGroups.filter((c) => !caseAIds.has(c.id));

  // ── Case D: recurring clones with parentPostId incorrectly set ──
  // These are daily recurring clones that were published as Twitter thread
  // replies instead of standalone posts. Identify them by:
  // - Same group has multiple PUBLISHED posts created on different days
  // - parentPostId points to another post in the SAME group
  // - Not deleted
  const caseDCandidates: Array<{ id: string; group: string; parentPostId: string; state: string; publishDate: Date; createdAt: Date; organizationId: string; integration: any }> = [];

  // Get all groups that have posts with parentPostId set + PUBLISHED state
  const postsWithParent = await prisma.post.findMany({
    where: {
      parentPostId: { not: null },
      deletedAt: null,
      state: { in: ['PUBLISHED', 'ERROR'] },
      releaseURL: { not: null },
      ...orgFilter,
    },
    select: {
      id: true, group: true, parentPostId: true, state: true,
      publishDate: true, createdAt: true, organizationId: true,
      integration: { select: { name: true, providerIdentifier: true } },
    },
  });

  // For each, check if parentPostId points to a post in the same group
  // AND if the group contains posts created on different days (recurring pattern)
  const groupPostMap = new Map<string, typeof postsWithParent>();
  for (const p of postsWithParent) {
    if (!groupPostMap.has(p.group)) {
      groupPostMap.set(p.group, []);
    }
    groupPostMap.get(p.group)!.push(p);
  }

  for (const [group, posts] of groupPostMap) {
    // Get ALL posts in this group to check the pattern
    const allInGroup = await prisma.post.findMany({
      where: { group, deletedAt: null },
      select: { id: true, createdAt: true, parentPostId: true },
    });

    const idsInGroup = new Set(allInGroup.map((p) => p.id));

    // Check: do posts with parentPostId point to posts in the same group?
    const intraGroupReplies = posts.filter((p) => p.parentPostId && idsInGroup.has(p.parentPostId));
    if (intraGroupReplies.length === 0) continue;

    // Check: were posts created on different days? (recurring clone pattern)
    const uniqueDays = new Set(allInGroup.map((p) => p.createdAt.toISOString().slice(0, 10)));
    if (uniqueDays.size < 2) continue; // Same-day = real thread, skip

    // These are recurring clones with parentPostId incorrectly set
    caseDCandidates.push(...intraGroupReplies);
  }

  // Also check: the "original" post in these groups might have parentPostId set too
  const caseDGroups = new Set(caseDCandidates.map((c) => c.group));
  if (caseDGroups.size > 0) {
    const originalsWithParent = await prisma.post.findMany({
      where: {
        group: { in: [...caseDGroups] },
        parentPostId: { not: null },
        deletedAt: null,
        state: { in: ['PUBLISHED', 'ERROR'] },
        id: { notIn: caseDCandidates.map((c) => c.id) },
        ...orgFilter,
      },
      select: {
        id: true, group: true, parentPostId: true, state: true,
        publishDate: true, createdAt: true, organizationId: true,
        integration: { select: { name: true, providerIdentifier: true } },
      },
    });
    caseDCandidates.push(...originalsWithParent);
  }

  // ── Report ──
  function printSample(items: any[], maxItems = 10) {
    for (const c of items.slice(0, maxItems)) {
      console.log(
        `  ${c.id} | ${c.state?.padEnd?.(9) || c.state} | ${c.publishDate.toISOString().slice(0, 10)} | ` +
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

  console.log(`\nCase D: ${caseDCandidates.length} post(s) with incorrect parentPostId to fix`);
  printSample(caseDCandidates);

  const totalFixes = caseA.length + caseB.length + caseC.length + caseDCandidates.length;
  if (totalFixes === 0) {
    console.log('\nNothing to fix.');
    return;
  }

  if (dryRun) {
    console.log(`\nDry run complete. ${totalFixes} fix(es) pending. Run with --execute to apply.`);
    return;
  }

  let fixed = 0;

  if (caseA.length > 0) {
    const result = await prisma.post.updateMany({
      where: { id: { in: caseA.map((c) => c.id) } },
      data: { deletedAt: null, sourcePostId: null },
    });
    fixed += result.count;
    console.log(`\nCase A: restored ${result.count} deleted clone(s)`);
  }

  if (caseB.length > 0) {
    const result = await prisma.post.updateMany({
      where: { id: { in: caseB.map((c) => c.id) } },
      data: { sourcePostId: null },
    });
    fixed += result.count;
    console.log(`Case B: detached ${result.count} active clone(s)`);
  }

  if (caseC.length > 0) {
    const result = await prisma.post.updateMany({
      where: { id: { in: caseC.map((c) => c.id) } },
      data: { deletedAt: null },
    });
    fixed += result.count;
    console.log(`Case C: restored ${result.count} post(s) from recurring groups`);
  }

  if (caseDCandidates.length > 0) {
    const result = await prisma.post.updateMany({
      where: { id: { in: caseDCandidates.map((c) => c.id) } },
      data: { parentPostId: null },
    });
    fixed += result.count;
    console.log(`Case D: cleared parentPostId on ${result.count} post(s)`);
  }

  console.log(`\nTotal fixed: ${fixed}`);
}

main()
  .catch((err) => {
    console.error('Script failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

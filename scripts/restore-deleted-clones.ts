/**
 * Fix historical data affected by recurring post bugs.
 *
 * Cases:
 *   A) Deleted clones with sourcePostId set — restore + clear sourcePostId
 *   B) Active clones with stale sourcePostId — clear sourcePostId only
 *   C) Deleted PUBLISHED/ERROR posts in recurring groups — restore
 *   D) Posts with parentPostId pointing to same-group posts, created on
 *      different days (recurring clones, not real threads) — clear parentPostId
 *   E) Posts with releaseURL set but state=QUEUE — fix state to PUBLISHED
 *   F) Recurring clones with identical publishDate — restore per-clone dates from createdAt
 *
 * Usage:
 *   npx ts-node scripts/restore-deleted-clones.ts --dry-run
 *   npx ts-node scripts/restore-deleted-clones.ts --execute
 *   npx ts-node scripts/restore-deleted-clones.ts --org <orgId> --dry-run
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function printSample(items: any[], maxItems = 10) {
  for (const c of items.slice(0, maxItems)) {
    const platform = c.integration ? `${c.integration.providerIdentifier}/${c.integration.name}` : '?';
    console.log(
      `  ${c.id} | ${String(c.state).padEnd(9)} | ${platform} | ` +
      `pub=${c.publishDate?.toISOString().slice(0, 10) || '?'} | ` +
      `url=${c.releaseURL?.slice(0, 40) || 'none'}`
    );
  }
  if (items.length > maxItems) {
    console.log(`  ... and ${items.length - maxItems} more`);
  }
}

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
    select: { id: true, state: true, publishDate: true, deletedAt: true, releaseURL: true, organizationId: true, group: true, createdAt: true, parentPostId: true, integration: { select: { name: true, providerIdentifier: true, deletedAt: true } } },
    orderBy: { publishDate: 'desc' },
  });
  const caseA = deletedWithSource.filter((c) => c.integration && !c.integration.deletedAt);

  // ── Case B: active clones with stale sourcePostId ──
  const caseB = await prisma.post.findMany({
    where: {
      sourcePostId: { not: null },
      deletedAt: null,
      state: { in: ['PUBLISHED', 'ERROR'] },
      ...orgFilter,
    },
    select: { id: true, state: true, publishDate: true, releaseURL: true, organizationId: true, group: true, createdAt: true, parentPostId: true, integration: { select: { name: true, providerIdentifier: true } } },
    orderBy: { publishDate: 'desc' },
  });

  // ── Case C: deleted PUBLISHED/ERROR in recurring groups ──
  const recurringGroups = await prisma.post.findMany({
    where: { intervalInDays: { not: null }, ...orgFilter },
    select: { group: true },
    distinct: ['group'],
  });
  const recurringGroupSet = new Set(recurringGroups.map((r) => r.group));
  const caseC = recurringGroupSet.size > 0
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
        select: { id: true, state: true, publishDate: true, deletedAt: true, releaseURL: true, organizationId: true, group: true, createdAt: true, parentPostId: true, integration: { select: { name: true, providerIdentifier: true } } },
        orderBy: { publishDate: 'desc' },
      })
    : [];

  // ── Case D+E+F: find groups with multiple posts created on different days ──
  // These are recurring clone groups. Fix parentPostId, state, and publishDate.

  // Find all posts with parentPostId pointing to another post, OR
  // state=QUEUE but releaseURL set (should be PUBLISHED).
  // Scoped to recurring groups only to avoid false positives on normal QUEUE posts.
  const suspectPosts = recurringGroupSet.size > 0 ? await prisma.post.findMany({
    where: {
      group: { in: [...recurringGroupSet] },
      deletedAt: null,
      releaseURL: { not: null },
      ...orgFilter,
      OR: [
        { parentPostId: { not: null } },
        { state: 'QUEUE' },
      ],
    },
    select: {
      id: true, group: true, parentPostId: true, state: true,
      publishDate: true, createdAt: true, organizationId: true, releaseURL: true,
      integration: { select: { name: true, providerIdentifier: true } },
    },
  }) : [];

  // Group by group ID
  const suspectByGroup = new Map<string, typeof suspectPosts>();
  for (const p of suspectPosts) {
    if (!suspectByGroup.has(p.group)) suspectByGroup.set(p.group, []);
    suspectByGroup.get(p.group)!.push(p);
  }

  const caseD: typeof suspectPosts = []; // parentPostId to clear
  const caseE: typeof suspectPosts = []; // state QUEUE → PUBLISHED
  const caseF: Array<{ id: string; newPublishDate: Date; integration?: { name: string; providerIdentifier: string } }> = []; // publishDate to fix

  // Build a lookup map: post id → integration for case F display
  const suspectById = new Map(suspectPosts.map((p) => [p.id, p]));

  for (const [group, posts] of suspectByGroup) {
    // Get ALL posts in this group
    const allInGroup = await prisma.post.findMany({
      where: { group, deletedAt: null },
      select: { id: true, createdAt: true, publishDate: true, parentPostId: true, intervalInDays: true },
      orderBy: { createdAt: 'asc' },
    });

    if (allInGroup.length < 2) continue;

    const idsInGroup = new Set(allInGroup.map((p) => p.id));
    const uniqueDays = new Set(allInGroup.map((p) => p.createdAt.toISOString().slice(0, 10)));

    // Must be created on different days (recurring clone pattern)
    if (uniqueDays.size < 2) continue;

    for (const p of posts) {
      // Case D: parentPostId points to same-group post
      if (p.parentPostId && idsInGroup.has(p.parentPostId)) {
        caseD.push(p);
      }

      // Case E: state=QUEUE but has releaseURL (actually published)
      if (p.state === 'QUEUE' && p.releaseURL) {
        caseE.push(p);
      }
    }

    // Case F: all posts have identical publishDate but different createdAt
    const uniquePublishDates = new Set(allInGroup.map((p) => p.publishDate.getTime()));
    if (uniquePublishDates.size === 1 && uniqueDays.size > 1) {
      // All same publishDate — restore from createdAt
      // The original (has intervalInDays or earliest createdAt) keeps its publishDate
      const original = allInGroup.find((p) => p.intervalInDays !== null) || allInGroup[0];
      for (const p of allInGroup) {
        if (p.id === original.id) continue;
        // Clone's publishDate should be its createdAt date + original's time
        const origTime = original.publishDate;
        const cloneDate = new Date(p.createdAt);
        cloneDate.setUTCHours(origTime.getUTCHours(), origTime.getUTCMinutes(), origTime.getUTCSeconds(), 0);
        if (cloneDate.getTime() !== p.publishDate.getTime()) {
          caseF.push({ id: p.id, newPublishDate: cloneDate, integration: suspectById.get(p.id)?.integration ?? undefined });
        }
      }
    }
  }

  // Also add originals with parentPostId set in Case D groups
  const caseDGroups = new Set(caseD.map((c) => c.group));
  if (caseDGroups.size > 0) {
    const originalsWithParent = await prisma.post.findMany({
      where: {
        group: { in: [...caseDGroups] },
        parentPostId: { not: null },
        deletedAt: null,
        id: { notIn: caseD.map((c) => c.id) },
        ...orgFilter,
      },
      select: {
        id: true, group: true, parentPostId: true, state: true,
        publishDate: true, createdAt: true, organizationId: true, releaseURL: true,
        integration: { select: { name: true, providerIdentifier: true } },
      },
    });
    caseD.push(...originalsWithParent);
  }

  // ── Report ──
  console.log(`Case A: ${caseA.length} deleted clone(s) with sourcePostId to restore`);
  printSample(caseA);

  console.log(`\nCase B: ${caseB.length} active clone(s) with stale sourcePostId to detach`);
  printSample(caseB);

  console.log(`\nCase C: ${caseC.length} deleted post(s) in recurring groups to restore`);
  printSample(caseC);

  console.log(`\nCase D: ${caseD.length} post(s) with incorrect parentPostId to clear`);
  printSample(caseD);

  console.log(`\nCase E: ${caseE.length} post(s) with state=QUEUE but actually published (has releaseURL)`);
  printSample(caseE);

  console.log(`\nCase F: ${caseF.length} post(s) with incorrect publishDate to fix`);
  for (const f of caseF.slice(0, 10)) {
    const platform = f.integration ? `${f.integration.providerIdentifier}/${f.integration.name}` : '?';
    console.log(`  ${f.id} | ${platform} → ${f.newPublishDate.toISOString().slice(0, 19)}`);
  }
  if (caseF.length > 10) console.log(`  ... and ${caseF.length - 10} more`);

  const totalFixes = caseA.length + caseB.length + caseC.length + caseD.length + caseE.length + caseF.length;
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
    const r = await prisma.post.updateMany({ where: { id: { in: caseA.map((c) => c.id) } }, data: { deletedAt: null, sourcePostId: null } });
    fixed += r.count;
    console.log(`\nCase A: restored ${r.count}`);
  }

  if (caseB.length > 0) {
    const r = await prisma.post.updateMany({ where: { id: { in: caseB.map((c) => c.id) } }, data: { sourcePostId: null } });
    fixed += r.count;
    console.log(`Case B: detached ${r.count}`);
  }

  if (caseC.length > 0) {
    const r = await prisma.post.updateMany({ where: { id: { in: caseC.map((c) => c.id) } }, data: { deletedAt: null } });
    fixed += r.count;
    console.log(`Case C: restored ${r.count}`);
  }

  if (caseD.length > 0) {
    const r = await prisma.post.updateMany({ where: { id: { in: caseD.map((c) => c.id) } }, data: { parentPostId: null } });
    fixed += r.count;
    console.log(`Case D: cleared parentPostId on ${r.count}`);
  }

  if (caseE.length > 0) {
    const r = await prisma.post.updateMany({ where: { id: { in: caseE.map((c) => c.id) } }, data: { state: 'PUBLISHED' } });
    fixed += r.count;
    console.log(`Case E: fixed state to PUBLISHED on ${r.count}`);
  }

  if (caseF.length > 0) {
    // publishDate needs per-record update
    for (const f of caseF) {
      await prisma.post.update({ where: { id: f.id }, data: { publishDate: f.newPublishDate } });
    }
    fixed += caseF.length;
    console.log(`Case F: fixed publishDate on ${caseF.length}`);
  }

  console.log(`\nTotal fixed: ${fixed}`);
}

main()
  .catch((err) => {
    console.error('Script failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

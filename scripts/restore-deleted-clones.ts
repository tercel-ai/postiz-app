/**
 * Restore published/errored clones that were incorrectly soft-deleted
 * when their parent recurring post was cancelled or edited.
 *
 * Root cause: deletePost() and createOrUpdatePost() used to soft-delete
 * ALL posts in a group, including PUBLISHED and ERROR clones.
 * Fixed in this commit — this script recovers historical data.
 *
 * Usage:
 *   npx ts-node scripts/restore-deleted-clones.ts --dry-run
 *   npx ts-node scripts/restore-deleted-clones.ts --execute
 *   npx ts-node scripts/restore-deleted-clones.ts --org <orgId> --dry-run
 *   npx ts-node scripts/restore-deleted-clones.ts --diagnose          # show step-by-step filter breakdown
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function diagnose(orgId?: string) {
  console.log('=== DIAGNOSTIC: step-by-step filter breakdown ===\n');

  const orgFilter = orgId ? { organizationId: orgId } : {};

  // Step 1: all soft-deleted posts
  const allDeleted = await prisma.post.count({
    where: { deletedAt: { not: null }, ...orgFilter },
  });
  console.log(`1. All soft-deleted posts: ${allDeleted}`);

  // Step 2: soft-deleted + has sourcePostId (is a clone)
  const deletedClones = await prisma.post.count({
    where: { deletedAt: { not: null }, sourcePostId: { not: null }, ...orgFilter },
  });
  console.log(`2. Soft-deleted clones (sourcePostId not null): ${deletedClones}`);

  // Step 3: + state is PUBLISHED or ERROR
  const deletedPublishedClones = await prisma.post.count({
    where: {
      deletedAt: { not: null },
      sourcePostId: { not: null },
      state: { in: ['PUBLISHED', 'ERROR'] },
      ...orgFilter,
    },
  });
  console.log(`3. + state is PUBLISHED/ERROR: ${deletedPublishedClones}`);

  // Step 4: + integration not deleted
  const withActiveIntegration = await prisma.post.count({
    where: {
      deletedAt: { not: null },
      sourcePostId: { not: null },
      state: { in: ['PUBLISHED', 'ERROR'] },
      integration: { deletedAt: null },
      ...orgFilter,
    },
  });
  console.log(`4. + integration not deleted: ${withActiveIntegration}`);

  // Show some sample deleted clones without the integration filter
  if (deletedPublishedClones > 0 && withActiveIntegration === 0) {
    console.log('\n⚠️  All deleted clones have deleted integrations. Showing samples:');
    const samples = await prisma.post.findMany({
      where: {
        deletedAt: { not: null },
        sourcePostId: { not: null },
        state: { in: ['PUBLISHED', 'ERROR'] },
        ...orgFilter,
      },
      select: {
        id: true,
        state: true,
        integrationId: true,
        publishDate: true,
        integration: { select: { name: true, deletedAt: true } },
      },
      take: 5,
    });
    for (const s of samples) {
      console.log(
        `    ${s.id} | ${s.state} | ${s.publishDate.toISOString().slice(0, 10)} | ` +
        `integration=${s.integration?.name ?? 'NULL'} deletedAt=${s.integration?.deletedAt?.toISOString().slice(0, 19) ?? 'null'}`
      );
    }
  }

  if (deletedClones > 0 && deletedPublishedClones === 0) {
    console.log('\n⚠️  Deleted clones exist but none are PUBLISHED/ERROR. Showing state breakdown:');
    const byState = await prisma.post.groupBy({
      by: ['state'],
      where: {
        deletedAt: { not: null },
        sourcePostId: { not: null },
        ...orgFilter,
      },
      _count: true,
    });
    for (const s of byState) {
      console.log(`    ${s.state}: ${s._count}`);
    }
  }

  console.log('\nDiagnosis complete.');
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const isDiagnose = args.includes('--diagnose');
  const orgFlag = args.indexOf('--org');
  const orgId = orgFlag !== -1 ? args[orgFlag + 1] : undefined;

  if (isDiagnose) {
    await diagnose(orgId);
    return;
  }

  if (dryRun) {
    console.log('=== DRY RUN (pass --execute to apply changes) ===\n');
  }

  // Find restorable clones — skip integration filter to avoid missing
  // clones whose integration was soft-deleted then re-connected
  const affectedClones = await prisma.post.findMany({
    where: {
      sourcePostId: { not: null },
      deletedAt: { not: null },
      state: { in: ['PUBLISHED', 'ERROR'] },
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
      integrationId: true,
      integration: {
        select: {
          name: true,
          providerIdentifier: true,
          deletedAt: true,
        },
      },
    },
    orderBy: { publishDate: 'desc' },
  });

  if (affectedClones.length === 0) {
    console.log('No incorrectly deleted clones found. Nothing to restore.');
    console.log('Tip: run with --diagnose to see step-by-step filter breakdown.');
    return;
  }

  // Separate clones with active vs deleted integrations
  const restorable = affectedClones.filter((c) => c.integration && !c.integration.deletedAt);
  const orphaned = affectedClones.filter((c) => !c.integration || c.integration.deletedAt);

  const publishedCount = restorable.filter((c) => c.state === 'PUBLISHED').length;
  const errorCount = restorable.filter((c) => c.state === 'ERROR').length;
  console.log(
    `Found ${restorable.length} restorable clone(s) ` +
    `(${publishedCount} PUBLISHED, ${errorCount} ERROR)`
  );
  if (orphaned.length > 0) {
    console.log(`Skipping ${orphaned.length} clone(s) with deleted/missing integrations.\n`);
  }

  if (restorable.length === 0) {
    console.log('No clones to restore (all have deleted integrations).');
    return;
  }

  // Group by org for readability
  const byOrg = new Map<string, typeof restorable>();
  for (const clone of restorable) {
    const list = byOrg.get(clone.organizationId) || [];
    list.push(clone);
    byOrg.set(clone.organizationId, list);
  }

  for (const [org, clones] of byOrg) {
    console.log(`\n  Org ${org}: ${clones.length} clone(s)`);
    for (const c of clones) {
      console.log(
        `    ${c.id} | ${c.state.padEnd(9)} | ${c.publishDate.toISOString().slice(0, 10)} | ` +
        `${c.integration?.providerIdentifier || '?'}/${c.integration?.name || '?'} | ` +
        `deleted=${c.deletedAt?.toISOString().slice(0, 19)} | ` +
        `url=${c.releaseURL || 'none'}`
      );
    }
  }

  if (dryRun) {
    console.log(`\nDry run complete. Run with --execute to restore these ${restorable.length} clone(s).`);
    return;
  }

  // Restore: set deletedAt back to null
  const ids = restorable.map((c) => c.id);
  const result = await prisma.post.updateMany({
    where: { id: { in: ids } },
    data: { deletedAt: null },
  });

  console.log(`\nRestored ${result.count} clone(s).`);
}

main()
  .catch((err) => {
    console.error('Script failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

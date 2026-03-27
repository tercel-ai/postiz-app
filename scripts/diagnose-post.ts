/**
 * Diagnose a recurring post and all its clones.
 *
 * Usage:
 *   npx ts-node scripts/diagnose-post.ts <postId>
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const postId = process.argv[2];
  if (!postId) {
    console.error('Usage: npx ts-node scripts/diagnose-post.ts <postId>');
    process.exit(1);
  }

  // 1. Find the post (could be original or clone)
  const post = await prisma.post.findUnique({
    where: { id: postId },
    include: {
      integration: {
        select: { id: true, name: true, providerIdentifier: true, deletedAt: true, disabled: true },
      },
    },
  });

  if (!post) {
    console.log(`Post ${postId} not found.`);
    return;
  }

  // Determine if this is the original or a clone
  const isClone = !!post.sourcePostId;
  const originalId = isClone ? post.sourcePostId! : post.id;

  console.log(`=== Post Diagnosis ===\n`);
  console.log(`Input post: ${postId} (${isClone ? 'CLONE → original: ' + originalId : 'ORIGINAL'})\n`);

  // 2. Fetch original post
  const original = isClone
    ? await prisma.post.findUnique({ where: { id: originalId } })
    : post;

  if (!original) {
    console.log(`⚠️  Original post ${originalId} not found (hard-deleted?).`);
  } else {
    console.log(`Original post:`);
    console.log(`  id:             ${original.id}`);
    console.log(`  group:          ${original.group}`);
    console.log(`  state:          ${original.state}`);
    console.log(`  intervalInDays: ${original.intervalInDays}`);
    console.log(`  publishDate:    ${original.publishDate.toISOString()}`);
    console.log(`  deletedAt:      ${original.deletedAt?.toISOString() ?? 'null'}`);
    console.log(`  sourcePostId:   ${original.sourcePostId ?? 'null'}`);
    console.log(`  parentPostId:   ${original.parentPostId ?? 'null'}`);
    console.log(`  integrationId:  ${original.integrationId}`);
  }

  // 3. Integration info
  const integration = post.integration;
  console.log(`\nIntegration:`);
  if (integration) {
    console.log(`  id:         ${integration.id}`);
    console.log(`  name:       ${integration.name}`);
    console.log(`  provider:   ${integration.providerIdentifier}`);
    console.log(`  deletedAt:  ${integration.deletedAt?.toISOString() ?? 'null'}`);
    console.log(`  disabled:   ${integration.disabled}`);
  } else {
    console.log(`  ⚠️  No integration found`);
  }

  // 4. Fetch all clones
  const clones = await prisma.post.findMany({
    where: { sourcePostId: originalId },
    orderBy: { publishDate: 'asc' },
    select: {
      id: true,
      state: true,
      publishDate: true,
      deletedAt: true,
      releaseURL: true,
      parentPostId: true,
      sourcePostId: true,
    },
  });

  console.log(`\nClones (${clones.length} total):`);
  if (clones.length === 0) {
    console.log(`  (none)`);
  }
  for (const c of clones) {
    const flags = [];
    if (c.deletedAt) flags.push('DELETED');
    if (c.parentPostId) flags.push(`parentPostId=${c.parentPostId}`);
    console.log(
      `  ${c.id} | ${c.state.padEnd(9)} | ${c.publishDate.toISOString().slice(0, 19)} | ` +
      `deletedAt=${c.deletedAt?.toISOString().slice(0, 19) ?? 'null'.padEnd(19)} | ` +
      `url=${c.releaseURL?.slice(0, 50) || 'none'}` +
      (flags.length ? ` | ${flags.join(', ')}` : '')
    );
  }

  // 5. Fetch all posts in the same group
  const group = original?.group;
  if (group) {
    const groupPosts = await prisma.post.findMany({
      where: { group },
      orderBy: { publishDate: 'asc' },
      select: {
        id: true,
        state: true,
        publishDate: true,
        deletedAt: true,
        sourcePostId: true,
        parentPostId: true,
        intervalInDays: true,
      },
    });

    console.log(`\nAll posts in group ${group} (${groupPosts.length} total):`);
    for (const p of groupPosts) {
      const role = !p.sourcePostId
        ? 'ORIGINAL'
        : 'CLONE';
      const flags = [];
      if (p.deletedAt) flags.push('DELETED');
      if (p.parentPostId) flags.push('HAS_PARENT');
      console.log(
        `  ${p.id} | ${role.padEnd(8)} | ${p.state.padEnd(9)} | ` +
        `${p.publishDate.toISOString().slice(0, 19)} | ` +
        `deletedAt=${p.deletedAt?.toISOString().slice(0, 19) ?? 'null'.padEnd(19)} | ` +
        `interval=${p.intervalInDays ?? 'null'}` +
        (flags.length ? ` | ${flags.join(', ')}` : '')
      );
    }
  }

  // 6. Visibility analysis
  console.log(`\n=== Visibility Analysis ===`);

  const originalVisible = original && !original.deletedAt && !original.parentPostId && !original.sourcePostId;
  console.log(`\nCalendar (getPosts):`);
  console.log(`  Original visible: ${originalVisible ? '✅' : '❌'}`);
  if (!originalVisible && original) {
    if (original.deletedAt) console.log(`    → deletedAt is set (${original.deletedAt.toISOString().slice(0, 19)})`);
    if (original.sourcePostId) console.log(`    → sourcePostId is set (this is a clone, not queried)`);
    if (original.parentPostId) console.log(`    → parentPostId is set (this is a comment)`);
  }
  if (originalVisible) {
    const visibleClones = clones.filter((c) => !c.deletedAt);
    console.log(`  Clones shown via recurringPostIds lookup: ${visibleClones.length}`);
    const deletedClones = clones.filter((c) => c.deletedAt);
    if (deletedClones.length > 0) {
      console.log(`  ⚠️  ${deletedClones.length} clone(s) hidden because deletedAt is set`);
    }
  } else {
    console.log(`  ⚠️  Original not visible → NO clones will be shown in calendar`);
    const activeClones = clones.filter((c) => !c.deletedAt && (c.state === 'PUBLISHED' || c.state === 'ERROR'));
    if (activeClones.length > 0) {
      console.log(`  ⚠️  ${activeClones.length} PUBLISHED/ERROR clone(s) exist but are INVISIBLE`);
    }
  }

  console.log(`\n/posts/list (timeline view):`);
  const listVisibleClones = clones.filter((c) => !c.deletedAt && !c.parentPostId);
  console.log(`  Visible clones (deletedAt=null, parentPostId=null): ${listVisibleClones.length}`);
  const listHiddenClones = clones.filter((c) => c.deletedAt || c.parentPostId);
  if (listHiddenClones.length > 0) {
    for (const c of listHiddenClones) {
      const reason = c.deletedAt ? 'deletedAt set' : 'parentPostId set';
      console.log(`    ❌ ${c.id} (${c.state}) hidden: ${reason}`);
    }
  }

  console.log();
}

main()
  .catch((err) => {
    console.error('Script failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

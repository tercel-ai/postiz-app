/**
 * Deep diagnosis: trace a post's full history including related groups.
 *
 * Usage:
 *   npx ts-node scripts/diagnose-post-deep.ts <postId>
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const postId = process.argv[2];
  if (!postId) {
    console.error('Usage: npx ts-node scripts/diagnose-post-deep.ts <postId>');
    process.exit(1);
  }

  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) {
    console.log(`Post ${postId} not found.`);
    return;
  }

  const originalId = post.sourcePostId || post.id;
  const original = post.sourcePostId
    ? await prisma.post.findUnique({ where: { id: originalId } })
    : post;

  console.log('=== Deep Post Diagnosis ===\n');

  // 1. Check the original post's full record
  if (original) {
    console.log('Original post (all fields):');
    for (const [k, v] of Object.entries(original)) {
      if (v !== null && v !== undefined) {
        const val = v instanceof Date ? v.toISOString() : String(v).slice(0, 100);
        console.log(`  ${k}: ${val}`);
      }
    }
  }

  // 2. Find ALL posts with the same integrationId that have intervalInDays set
  //    This helps find if there was a previous recurring post that got edited/replaced
  const integrationId = original?.integrationId || post.integrationId;
  if (integrationId) {
    const recurringPosts = await prisma.post.findMany({
      where: {
        integrationId,
        intervalInDays: { not: null },
      },
      select: {
        id: true,
        group: true,
        intervalInDays: true,
        state: true,
        publishDate: true,
        deletedAt: true,
        sourcePostId: true,
        content: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    console.log(`\nRecurring posts for same integration (${integrationId}):`);
    if (recurringPosts.length === 0) {
      console.log('  (none found — no post has intervalInDays set for this integration)');
    }
    for (const p of recurringPosts) {
      console.log(
        `  ${p.id} | interval=${p.intervalInDays} | ${p.state.padEnd(9)} | ` +
        `group=${p.group.slice(0, 8)}... | ` +
        `deletedAt=${p.deletedAt?.toISOString().slice(0, 19) ?? 'null'} | ` +
        `content=${(p.content || '').slice(0, 40).replace(/\n/g, ' ')}`
      );
    }
  }

  // 3. Find ALL posts in the same group (including deleted)
  const group = original?.group || post.group;
  const groupPosts = await prisma.post.findMany({
    where: { group },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      state: true,
      publishDate: true,
      createdAt: true,
      deletedAt: true,
      sourcePostId: true,
      parentPostId: true,
      intervalInDays: true,
      content: true,
    },
  });

  console.log(`\nAll posts in group ${group} (${groupPosts.length}):`);
  for (const p of groupPosts) {
    console.log(
      `  ${p.id} | ${p.state.padEnd(9)} | ` +
      `created=${p.createdAt.toISOString().slice(0, 19)} | ` +
      `publish=${p.publishDate.toISOString().slice(0, 19)} | ` +
      `deleted=${p.deletedAt?.toISOString().slice(0, 19) ?? 'null'.padEnd(19)} | ` +
      `interval=${String(p.intervalInDays ?? 'null').padEnd(4)} | ` +
      `source=${p.sourcePostId?.slice(0, 10) ?? 'null'.padEnd(10)} | ` +
      `parent=${p.parentPostId?.slice(0, 10) ?? 'null'.padEnd(10)} | ` +
      `content=${(p.content || '').slice(0, 30).replace(/\n/g, ' ')}`
    );
  }

  // 4. Find posts with same content (across all groups) to detect edit/replace
  const contentSnippet = (original?.content || post.content || '').slice(0, 50);
  if (contentSnippet.length > 10) {
    const similar = await prisma.post.findMany({
      where: {
        content: { contains: contentSnippet.slice(0, 30) },
        integrationId,
      },
      select: {
        id: true,
        group: true,
        state: true,
        intervalInDays: true,
        deletedAt: true,
        publishDate: true,
        createdAt: true,
        sourcePostId: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });

    const otherGroups = similar.filter((s) => s.group !== group);
    if (otherGroups.length > 0) {
      console.log(`\nSame content found in OTHER groups (possible edit history):`);
      for (const s of otherGroups) {
        console.log(
          `  ${s.id} | group=${s.group.slice(0, 8)}... | ${s.state.padEnd(9)} | ` +
          `interval=${String(s.intervalInDays ?? 'null').padEnd(4)} | ` +
          `created=${s.createdAt.toISOString().slice(0, 19)} | ` +
          `deleted=${s.deletedAt?.toISOString().slice(0, 19) ?? 'null'} | ` +
          `source=${s.sourcePostId?.slice(0, 10) ?? 'null'}`
        );
      }
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

/**
 * Migrate PostRelease records to Post clones.
 *
 * For each PostRelease, creates a cloned Post with:
 *   - sourcePostId → original post id
 *   - content/image/settings/group etc. copied from the original post
 *   - publishDate/releaseId/releaseURL/state/error from the PostRelease
 *
 * Skips PostReleases whose (postId, releaseId) already has a corresponding
 * cloned Post (idempotent — safe to run multiple times).
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register \
 *     libraries/nestjs-libraries/src/database/prisma/migrations/migrate-post-releases-to-posts.ts
 */
import { PrismaClient, State } from '@prisma/client';

const BATCH_SIZE = 100;

async function main() {
  const prisma = new PrismaClient();

  try {
    const totalReleases = await prisma.postRelease.count();
    console.log(`Found ${totalReleases} PostRelease records to migrate.`);

    if (totalReleases === 0) {
      console.log('Nothing to migrate.');
      return;
    }

    let migrated = 0;
    let skipped = 0;
    let failed = 0;
    let cursor: string | undefined;

    while (true) {
      const releases = await prisma.postRelease.findMany({
        take: BATCH_SIZE,
        ...(cursor
          ? { skip: 1, cursor: { id: cursor } }
          : {}),
        orderBy: { id: 'asc' },
        include: {
          post: true,
        },
      });

      if (releases.length === 0) break;
      cursor = releases[releases.length - 1].id;

      for (const release of releases) {
        const originalPost = release.post;

        if (!originalPost) {
          console.warn(
            `  SKIP: PostRelease ${release.id} — original post ${release.postId} not found`
          );
          skipped++;
          continue;
        }

        // Check if a clone already exists for this (sourcePostId, releaseId) pair
        const existing = await prisma.post.findFirst({
          where: {
            sourcePostId: originalPost.id,
            releaseId: release.releaseId,
          },
          select: { id: true },
        });

        // Map PostRelease.state to Post State enum
        const postState: State =
          release.state === 'FAILED' ? 'ERROR' : 'PUBLISHED';

        if (existing) {
          // Clone exists — sync analytics fields if PostRelease has them
          if (release.impressions != null || release.trafficScore != null || release.analytics != null) {
            try {
              await prisma.post.update({
                where: { id: existing.id },
                data: {
                  state: postState,
                  error: release.error,
                  ...(release.impressions != null && { impressions: release.impressions }),
                  ...(release.trafficScore != null && { trafficScore: release.trafficScore }),
                  ...(release.analytics != null && { analytics: release.analytics }),
                },
              });
              migrated++;
            } catch (e) {
              console.error(
                `  FAIL update: clone ${existing.id} for PostRelease ${release.id}:`,
                e instanceof Error ? e.message : e
              );
              failed++;
            }
          } else {
            skipped++;
          }
          continue;
        }

        try {
          await prisma.post.create({
            data: {
              content: originalPost.content,
              title: originalPost.title,
              description: originalPost.description,
              image: originalPost.image,
              settings: originalPost.settings,
              group: originalPost.group,
              delay: originalPost.delay,
              organizationId: originalPost.organizationId,
              integrationId: originalPost.integrationId,
              publishDate: release.publishDate,
              state: postState,
              releaseId: release.releaseId,
              releaseURL: release.releaseURL,
              error: release.error,
              sourcePostId: originalPost.id,
              impressions: release.impressions,
              trafficScore: release.trafficScore,
              analytics: release.analytics,
            },
          });
          migrated++;
        } catch (e) {
          console.error(
            `  FAIL: PostRelease ${release.id} (post=${release.postId}, releaseId=${release.releaseId}):`,
            e instanceof Error ? e.message : e
          );
          failed++;
        }
      }

      console.log(
        `  Progress: ${migrated} migrated, ${skipped} skipped, ${failed} failed / ${totalReleases} total`
      );
    }

    console.log('\nMigration complete:');
    console.log(`  Migrated: ${migrated}`);
    console.log(`  Skipped:  ${skipped} (already exists or missing original)`);
    console.log(`  Failed:   ${failed}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

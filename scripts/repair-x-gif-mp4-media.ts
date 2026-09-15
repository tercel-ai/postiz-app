/**
 * One-off repair for posts whose media is really an X animated GIF stored as
 * an mp4 (X has no other form of a GIF — see x-animated-gif.ts's header) that
 * got seeded BEFORE `_fetchReferenceMedia`/`_referenceMediaDataUri` existed.
 * Left alone, `limitToOnePostableVideo` (now wired into getDuePublishPosts,
 * getPost, getPostsByGroup, postComment and postSocial) keeps only the FIRST
 * such mp4 and silently drops every other one at publish time — the post
 * gets out the door, but a source with two GIFs loses one of them for good.
 *
 * This re-runs the SAME transcode this app already applies to freshly
 * generated drafts (transcodeMp4ToAnimatedGif, x-animated-gif.ts), but against
 * media this app has ALREADY re-hosted (files.aisee.live, not X's CDN) — so
 * there is no `isXAnimatedGifMp4` URL pattern to lean on here, and no
 * automatic way to tell "an X GIF we stored as mp4" apart from "a real video
 * someone genuinely uploaded". Converting the latter to a GIF would be a
 * silent, lossy, wrong transformation (dropped audio, degraded quality).
 *
 * That is why this script does NOT scan for affected posts on its own: it
 * only touches the exact (--post, --media-id) pairs the operator names on the
 * command line, after confirming by hand (screenshot, browser devtools
 * network tab, whatever) that each one really is a GIF-sourced mp4.
 *
 * Requires ffmpeg on the machine running this script — see x-animated-gif.ts.
 * Without it, transcodeMp4ToAnimatedGif returns null for every item and the
 * script reports "skip: transcode unavailable" without touching anything.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/repair-x-gif-mp4-media.ts \
 *     --post <postId> --media-id <id> [--media-id <id> ...] --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/repair-x-gif-mp4-media.ts \
 *     --post <postId> --media-id <id> [--media-id <id> ...] --execute
 *
 * Example (the case this was written for):
 *   npx ts-node --project scripts/tsconfig.json scripts/repair-x-gif-mp4-media.ts \
 *     --post cmu22hrgy0051qmecl4b128dr \
 *     --media-id 46430910-7efd-4972-b39a-f3925ae69970 \
 *     --media-id 0574b971-7475-4130-942f-581ccbde961e \
 *     --execute
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

import { PrismaClient } from '@prisma/client';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { fetchMediaAsDataUri } from '@gitroom/nestjs-libraries/engage/safe-media-fetch';
import { transcodeMp4ToAnimatedGif, dataUriToBuffer } from '@gitroom/nestjs-libraries/engage/x-animated-gif';
import { isVideoMediaPath } from '@gitroom/helpers/utils/postable-media';

// Matches the budget engage.service.ts applies to the same transcode call.
const MAX_MEDIA_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

interface MediaItem {
  id?: string;
  path: string;
  url?: string;
  type?: string;
  [key: string]: unknown;
}

interface CliArgs {
  postId: string;
  mediaIds: string[];
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let postId: string | null = null;
  const mediaIds: string[] = [];
  let dryRun = true;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--post':
        postId = args[++i] ?? null;
        break;
      case '--media-id':
        if (args[++i]) mediaIds.push(args[i]);
        break;
      case '--execute':
        dryRun = false;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--help':
        console.log(
          'Usage: repair-x-gif-mp4-media.ts --post <postId> --media-id <id> [--media-id <id> ...] [--dry-run|--execute]'
        );
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }
  if (!postId) {
    console.error('--post <postId> is required');
    process.exit(1);
  }
  if (!mediaIds.length) {
    console.error(
      '--media-id <id> is required at least once — this script never guesses which media to touch'
    );
    process.exit(1);
  }
  return { postId, mediaIds, dryRun };
}

async function main(): Promise<void> {
  const { postId, mediaIds, dryRun } = parseArgs();

  console.log('=== Repair X-GIF-as-mp4 media ===\n');
  console.log(`Mode:    ${dryRun ? 'DRY RUN (no changes)' : 'EXECUTE'}`);
  console.log(`Post:    ${postId}`);
  console.log(`Media:   ${mediaIds.join(', ')}\n`);

  const prisma = new PrismaClient();
  try {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { id: true, organizationId: true, image: true },
    });
    if (!post) {
      console.error(`No post found with id ${postId}`);
      process.exitCode = 1;
      return;
    }

    let items: MediaItem[];
    try {
      items = JSON.parse(post.image || '[]');
    } catch {
      console.error(`Post ${postId}: image field is not valid JSON, aborting`);
      process.exitCode = 1;
      return;
    }
    if (!Array.isArray(items)) {
      console.error(`Post ${postId}: image field is not an array, aborting`);
      process.exitCode = 1;
      return;
    }

    const missing = mediaIds.filter((id) => !items.some((it) => it.id === id));
    if (missing.length) {
      console.error(
        `Post ${postId}: media id(s) not found on this post: ${missing.join(', ')}`
      );
      process.exitCode = 1;
      return;
    }

    const storage = UploadFactory.createStorage();
    const nextItems = [...items];
    let converted = 0;
    let skipped = 0;

    for (const targetId of mediaIds) {
      const idx = nextItems.findIndex((it) => it.id === targetId);
      const item = nextItems[idx];
      const sourceUrl = item.url || item.path;

      if (!isVideoMediaPath(sourceUrl)) {
        console.log(
          `  [skip] media ${targetId}: ${sourceUrl} is not video-shaped by extension — refusing to touch non-video media`
        );
        skipped++;
        continue;
      }

      console.log(`  media ${targetId}: ${sourceUrl}`);
      let mp4DataUri: string;
      try {
        mp4DataUri = await fetchMediaAsDataUri(sourceUrl, {
          maxBytes: MAX_MEDIA_BYTES,
          timeoutMs: FETCH_TIMEOUT_MS,
        });
      } catch (err: any) {
        console.log(`    skip: could not download source — ${err?.message || err}`);
        skipped++;
        continue;
      }

      const gif = await transcodeMp4ToAnimatedGif(dataUriToBuffer(mp4DataUri));
      if (!gif) {
        console.log(
          '    skip: transcode unavailable or over budget (no ffmpeg on this host, ' +
            'or the clip/output is too large) — leaving this item as mp4'
        );
        skipped++;
        continue;
      }
      console.log(`    transcoded: ${gif.length} bytes of gif`);

      if (dryRun) {
        console.log('    would upload + replace this item (dry run, not doing it)');
        converted++;
        continue;
      }

      const gifDataUri = `data:image/gif;base64,${gif.toString('base64')}`;
      const uploadedPath = await storage.uploadSimple(gifDataUri);
      const fileName = uploadedPath.split('/').pop()!;
      const saved = await prisma.media.create({
        data: {
          organization: { connect: { id: post.organizationId } },
          name: fileName,
          path: uploadedPath,
        },
        select: { id: true, path: true },
      });

      nextItems[idx] = {
        ...item,
        id: saved.id,
        path: saved.path,
        url: saved.path,
        type: 'image',
      };
      console.log(`    saved as media ${saved.id} (${saved.path})`);
      converted++;
    }

    if (dryRun) {
      console.log(
        `\n--- DRY RUN: ${converted} would convert, ${skipped} would skip. ` +
          'Re-run with --execute to apply. ---'
      );
      return;
    }

    if (converted === 0) {
      console.log(`\nNothing converted, post ${postId} left unchanged.`);
      return;
    }

    await prisma.post.update({
      where: { id: postId },
      data: { image: JSON.stringify(nextItems) },
    });
    console.log(
      `\nDone: ${converted} converted, ${skipped} skipped. Post ${postId}'s image field updated.`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

/**
 * Backfill Post.settings.engageAuthor for OLD engage X replies that were recorded
 * before the reply author was captured — i.e. Post.integrationId IS NULL (the reply
 * was posted from an account that isn't a connected integration) and the reply URL
 * is known. Reads the author (@handle + best-effort id/name/avatar) from the reply
 * URL and merges it into Post.settings.engageAuthor, preserving the existing
 * { "__type": "x" } tag.
 *
 * Author enrichment (id/name/avatarUrl) uses an ORG-CONNECTED X account's OAuth
 * token (resolved + refreshed via PostsService.fetchEngageXAuthor), so it works
 * without a global X_BEARER_TOKEN — the org's own X account is just a credential to
 * read a public profile by username. Falls back to X_BEARER_TOKEN, then handle-only.
 *
 * Reddit replies are skipped automatically: their URLs carry no author handle.
 *
 * Idempotent: rows that already have settings.engageAuthor are skipped unless
 * --force is passed (re-fetches and overwrites).
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-author-settings.ts --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-author-settings.ts --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-author-settings.ts --org <orgId> --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-author-settings.ts --execute --force
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { DatabaseModule } from '@gitroom/nestjs-libraries/database/prisma/database.module';
import { getTemporalModule } from '@gitroom/nestjs-libraries/temporal/temporal.module';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';

@Module({ imports: [DatabaseModule, getTemporalModule(false)] })
class ScriptModule {}

interface CliArgs {
  orgId: string | null;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let orgId: string | null = null;
  let dryRun = true;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--org':
        orgId = args[++i] ?? null;
        if (!orgId) { console.error('--org requires a value'); process.exit(1); }
        break;
      case '--execute': dryRun = false; break;
      case '--dry-run': dryRun = true; break;
      case '--force': force = true; break;
      case '--help':
        console.log(
          'Usage: backfill-engage-author-settings.ts [--org <id>] [--dry-run|--execute] [--force]'
        );
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }
  return { orgId, dryRun, force };
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('=== Backfill Engage reply author → Post.settings.engageAuthor ===\n');
  console.log(`Mode:  ${args.dryRun ? 'DRY RUN (no changes)' : 'EXECUTE'}`);
  console.log(`Org:   ${args.orgId ?? 'all'}`);
  console.log(`Force: ${args.force}\n`);

  const prisma = new PrismaClient();

  // OLD data: engage replies with no connected account (integrationId = null) and
  // a known reply URL. Reddit rows are included but no-op out (no X handle).
  const pending = await prisma.post.findMany({
    where: {
      source: 'engage',
      integrationId: null,
      releaseURL: { not: null },
      ...(args.orgId ? { organizationId: args.orgId } : {}),
    },
    select: { id: true, organizationId: true, releaseURL: true, settings: true },
  });

  console.log(`Found ${pending.length} engage repl${pending.length === 1 ? 'y' : 'ies'} with integrationId=null and a reply URL.\n`);

  // Bootstrap DI so author lookup reuses the production OAuth + token-refresh path.
  console.log('Bootstrapping NestJS context...\n');
  const app = await NestFactory.createApplicationContext(ScriptModule, {
    logger: ['error', 'warn'],
  });
  const postsService = app.get(PostsService, { strict: false });

  let enrichedFull = 0; // got id/name/avatar
  let handleOnly = 0;   // got @handle only (no usable token / lookup miss)
  let skipped = 0;      // already had engageAuthor (and not --force)
  let noHandle = 0;     // URL had no parseable X handle (e.g. Reddit)
  let written = 0;

  for (const p of pending) {
    // Parse existing settings, defaulting to the X type tag.
    let existing: Record<string, unknown> = { __type: 'x' };
    try {
      existing = { ...existing, ...(JSON.parse(p.settings ?? '{}') ?? {}) };
    } catch {
      /* keep default on unparseable settings */
    }

    if (existing.engageAuthor && !args.force) {
      skipped++;
      continue;
    }

    const author = await postsService.fetchEngageXAuthor(p.organizationId, p.releaseURL);
    if (!author) {
      noHandle++;
      continue;
    }

    const enriched = !!(author.id || author.name || author.avatarUrl);
    if (enriched) enrichedFull++;
    else handleOnly++;

    const tag = enriched ? 'enriched' : 'handle  ';
    console.log(
      `  [${tag}] post=${p.id}  @${author.handle}` +
      `${author.name ? ` (${author.name})` : ''}  url=${p.releaseURL?.slice(0, 55)}`
    );

    if (!args.dryRun) {
      await prisma.post.update({
        where: { id: p.id },
        data: { settings: JSON.stringify({ ...existing, engageAuthor: author }) },
      });
      written++;
    }
  }

  console.log(
    `\n${args.dryRun ? 'Would write' : 'Wrote'}: ${args.dryRun ? enrichedFull + handleOnly : written}` +
    `  (enriched id/name/avatar: ${enrichedFull}, handle-only: ${handleOnly})\n` +
    `Skipped (already had engageAuthor): ${skipped}\n` +
    `No X handle in URL (e.g. Reddit / profile URL): ${noHandle}` +
    (args.dryRun ? '\n\n--- DRY RUN. Re-run with --execute to write. ---' : '')
  );

  await app.close();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

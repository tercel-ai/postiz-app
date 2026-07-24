/**
 * Strip leaked "W1 - " week-label prefixes from operation-plan-materialized
 * DRAFT post titles written before the title cleanup.
 *
 * Background: the plan prompt used to ask the LLM to prefix themeTitle with the
 * week+phase (e.g. "W1 - Foundations: ..."), and themeTitle materializes VERBATIM
 * into Post.title — which platforms like Reddit / Hashnode submit as the real
 * published title. The prompt now asks for a clean title and the materializer
 * strips any leaked prefix (postTitleFromTheme), but rows materialized BEFORE
 * that fix still carry the polluted title. This backfill cleans them.
 *
 * Scope: only operation-plan posts (operationPlanId not null) in a fixable,
 * NOT-yet-published state. DRAFT by default; pass --include-queued to also clean
 * QUEUE posts that are scheduled but have not gone out yet. PUBLISHED posts are
 * never touched — their title already reached the platform, so rewriting the row
 * would only desync the DB from what was actually published.
 *
 * For Reddit the submit title is ALSO duplicated inside
 * settings.subreddit[].value.title; this cleans both so the row stays consistent.
 * Reuses postTitleFromTheme so the strip rule matches the live materializer
 * exactly. Idempotent: already-clean rows are skipped.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/cleanup-operation-plan-post-title.ts --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/cleanup-operation-plan-post-title.ts --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/cleanup-operation-plan-post-title.ts --org <orgId> --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/cleanup-operation-plan-post-title.ts --plan <planId> --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/cleanup-operation-plan-post-title.ts --include-queued --execute
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { PrismaClient, State } from '@prisma/client';
import { postTitleFromTheme } from '@gitroom/nestjs-libraries/database/prisma/operation-plan/theme-title';

interface CliArgs {
  orgId: string | null;
  planId: string | null;
  includeQueued: boolean;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let orgId: string | null = null;
  let planId: string | null = null;
  let includeQueued = false;
  let dryRun = true;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--org':
        orgId = args[++i] ?? null;
        if (!orgId) { console.error('--org requires a value'); process.exit(1); }
        break;
      case '--plan':
        planId = args[++i] ?? null;
        if (!planId) { console.error('--plan requires a value'); process.exit(1); }
        break;
      case '--include-queued': includeQueued = true; break;
      case '--execute': dryRun = false; break;
      case '--dry-run': dryRun = true; break;
      case '--help':
        console.log('Usage: cleanup-operation-plan-post-title.ts [--org <id>] [--plan <id>] [--include-queued] [--dry-run|--execute]');
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }
  return { orgId, planId, includeQueued, dryRun };
}

/**
 * The cleaned title + settings for a post, or null when nothing changes. Cleans
 * Post.title and every Reddit settings.subreddit[].value.title, reusing
 * postTitleFromTheme. Returns null when the row is already clean or its settings
 * are unparseable (left untouched — never persist a corrupted settings blob).
 */
function cleanPost(
  title: string | null,
  settingsRaw: string | null
): { title: string | null; settings: string | null; redditTitles: number } | null {
  const newTitle = title ? postTitleFromTheme(title) : title;
  const titleChanged = newTitle !== title;

  let settings: any;
  try {
    settings = JSON.parse(settingsRaw || '{}');
  } catch {
    // Unparseable settings: still allow a Post.title fix, but never rewrite the
    // settings blob we could not read.
    return titleChanged ? { title: newTitle, settings: null, redditTitles: 0 } : null;
  }

  let redditTitles = 0;
  const subreddits = Array.isArray(settings?.subreddit) ? settings.subreddit : [];
  for (const entry of subreddits) {
    const current = entry?.value?.title;
    if (typeof current === 'string') {
      const cleaned = postTitleFromTheme(current);
      if (cleaned !== current) {
        entry.value.title = cleaned;
        redditTitles++;
      }
    }
  }

  if (!titleChanged && redditTitles === 0) return null;

  return {
    title: newTitle,
    settings: redditTitles > 0 ? JSON.stringify(settings) : null,
    redditTitles,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();

  const states: State[] = args.includeQueued
    ? [State.DRAFT, State.QUEUE]
    : [State.DRAFT];

  console.log('=== Cleanup operation-plan Post.title (strip "W1 - " week label) ===\n');
  console.log(`Mode:   ${args.dryRun ? 'DRY RUN (no changes)' : 'EXECUTE'}`);
  console.log(`Org:    ${args.orgId ?? 'all'}`);
  console.log(`Plan:   ${args.planId ?? 'all'}`);
  console.log(`States: ${states.join(', ')}\n`);

  const prisma = new PrismaClient();

  const posts = await prisma.post.findMany({
    where: {
      operationPlanId: args.planId ? args.planId : { not: null },
      ...(args.orgId ? { organizationId: args.orgId } : {}),
      state: { in: states },
      deletedAt: null,
    },
    select: {
      id: true,
      title: true,
      settings: true,
      state: true,
      parentPostId: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Found ${posts.length} plan post${posts.length === 1 ? '' : 's'} in scope.\n`);

  let already = 0;
  let toChange = 0;
  let written = 0;
  let redditHeaders = 0;

  for (const p of posts) {
    const change = cleanPost(p.title, p.settings);
    if (!change) {
      already++;
      continue;
    }

    toChange++;
    redditHeaders += change.redditTitles;
    console.log(
      `  [clean:${p.state.padEnd(6)}] postId=${p.id}` +
      `${p.parentPostId ? ' (thread)' : '        '}  ${JSON.stringify(p.title)} -> ${JSON.stringify(change.title)}` +
      (change.redditTitles ? `  (+${change.redditTitles} reddit header)` : '')
    );

    if (!args.dryRun) {
      await prisma.post.update({
        where: { id: p.id },
        data: {
          title: change.title,
          ...(change.settings !== null ? { settings: change.settings } : {}),
        },
      });
      written++;
    }
  }

  console.log(
    `\nAlready clean: ${already}, ` +
    `${args.dryRun ? 'would clean' : 'cleaned'}: ${args.dryRun ? toChange : written}` +
    ` (reddit submit headers touched: ${redditHeaders})` +
    (args.dryRun ? '\n\n--- DRY RUN. Re-run with --execute to write. ---' : '')
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

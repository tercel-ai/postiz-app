/**
 * Repair Post.group for operation-plan-materialized posts written before the
 * per-platform group fix.
 *
 * Background: materializePlanPosts used to write `group = ${planId}:${contentId}`,
 * shared across every platform expanded from one contentItem. Because
 * getPostsByGroup filters by `group` alone (no platform/integration predicate)
 * and reads the header from posts[0], a group spanning platforms mixed e.g. an X
 * anchor with Reddit thread parts in the group/thread view. The fix scopes the
 * group by platform: `${planId}:${contentId}:${platform}` (see
 * operation-plan.repository.ts). Newly materialized posts are already correct;
 * this backfill rewrites the pre-fix rows.
 *
 * Every node (anchor + thread parts) carries `settings.__type` (platform) and
 * `settings.contentId`, so the correct group is recomputed per-row from the
 * post's own settings + its operationPlanId — X posts land in `:x`, Reddit in
 * `:reddit`, splitting the shared group. Idempotent: rows already on the target
 * group are skipped. State-agnostic (group is just a grouping key; rewriting it
 * does not affect publishing).
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-operation-plan-post-group.ts --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-operation-plan-post-group.ts --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-operation-plan-post-group.ts --org <orgId> --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-operation-plan-post-group.ts --plan <planId> --execute
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { PrismaClient } from '@prisma/client';

interface CliArgs {
  orgId: string | null;
  planId: string | null;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let orgId: string | null = null;
  let planId: string | null = null;
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
      case '--execute': dryRun = false; break;
      case '--dry-run': dryRun = true; break;
      case '--help':
        console.log('Usage: backfill-operation-plan-post-group.ts [--org <id>] [--plan <id>] [--dry-run|--execute]');
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }
  return { orgId, planId, dryRun };
}

/**
 * Recompute the correct per-platform group for a plan post. Returns null when the
 * row lacks the data to do so safely (missing platform/contentId), leaving it
 * untouched. contentId falls back to stripping the `${planId}:` prefix off the
 * legacy group (planId and contentId never contain ':').
 */
function targetGroup(
  operationPlanId: string,
  settingsRaw: string | null,
  currentGroup: string | null
): { group: string; platform: string; contentId: string } | null {
  let settings: any = {};
  try {
    settings = JSON.parse(settingsRaw || '{}');
  } catch {
    return null;
  }
  const platform = typeof settings.__type === 'string' ? settings.__type : null;
  if (!platform) return null;

  let contentId: string | null =
    typeof settings.contentId === 'string' ? settings.contentId : null;
  if (!contentId) {
    // settings.contentId is missing (a corrupted row) — we cannot derive the
    // true contentId authoritatively. Only a LEGACY 2-segment group
    // (`${planId}:${contentId}`) can be migrated by taking the tail as the
    // contentId. A group that ALREADY carries the `:${platform}` suffix is
    // already correct; deriving from it would swallow the platform segment and
    // re-append it (`…:x` -> `…:x:x`), so treat it as done and skip. contentId
    // is never platform-suffixed in practice (it is a short id / UUID), so this
    // suffix test cleanly separates migrated from legacy rows.
    const prefix = `${operationPlanId}:`;
    if (!currentGroup?.startsWith(prefix)) return null;
    if (currentGroup.endsWith(`:${platform}`)) return null; // already migrated
    contentId = currentGroup.slice(prefix.length) || null;
  }
  if (!contentId) return null;

  return {
    group: `${operationPlanId}:${contentId}:${platform}`,
    platform,
    contentId,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('=== Backfill operation-plan Post.group (per-platform) ===\n');
  console.log(`Mode: ${args.dryRun ? 'DRY RUN (no changes)' : 'EXECUTE'}`);
  console.log(`Org:  ${args.orgId ?? 'all'}`);
  console.log(`Plan: ${args.planId ?? 'all'}\n`);

  const prisma = new PrismaClient();

  const posts = await prisma.post.findMany({
    where: {
      operationPlanId: args.planId ? args.planId : { not: null },
      ...(args.orgId ? { organizationId: args.orgId } : {}),
      deletedAt: null,
    },
    select: {
      id: true,
      operationPlanId: true,
      organizationId: true,
      group: true,
      settings: true,
      parentPostId: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Found ${posts.length} plan post${posts.length === 1 ? '' : 's'} in scope.\n`);

  let already = 0;
  let skipped = 0;
  let toChange = 0;
  let written = 0;

  for (const p of posts) {
    if (!p.operationPlanId) continue; // narrows the `{ not: null }` type
    const target = targetGroup(p.operationPlanId, p.settings, p.group);

    if (!target) {
      skipped++;
      console.log(`  [skip:no-data]   postId=${p.id}  group=${p.group ?? 'null'} (missing __type/contentId)`);
      continue;
    }
    if (p.group === target.group) {
      already++;
      continue;
    }

    toChange++;
    console.log(
      `  [rewrite:${target.platform.padEnd(8)}] postId=${p.id}` +
      `${p.parentPostId ? ' (thread)' : '        '}  ${p.group ?? 'null'} -> ${target.group}`
    );

    if (!args.dryRun) {
      await prisma.post.update({
        where: { id: p.id },
        data: { group: target.group },
      });
      written++;
    }
  }

  console.log(
    `\nAlready correct: ${already}, skipped (no data): ${skipped}, ` +
    `${args.dryRun ? 'would rewrite' : 'rewrote'}: ${args.dryRun ? toChange : written}` +
    (args.dryRun ? '\n\n--- DRY RUN. Re-run with --execute to write. ---' : '')
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

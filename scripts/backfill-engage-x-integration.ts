/**
 * Backfill Post.integrationId for X engage replies that were recorded without a
 * connected account (Post.integrationId = null). Without an integration,
 * checkPostAnalytics can never read the reply tweet's metrics, so the sent-list
 * shows blank numbers forever.
 *
 * Resolution mirrors EngageRepository.resolveXReplyIntegrationId exactly (shared
 * pure helper): author-handle match → engage-enabled reply account → any live X
 * account. See resolve-x-reply-integration.ts for why handle match matters
 * (X impressions are owner-only).
 *
 * After running with --execute, re-fetch metrics:
 *   npx ts-node --project scripts/tsconfig.json scripts/sync-engage-x-metrics.ts --org <id> --only-missing --execute
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-x-integration.ts --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-x-integration.ts --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-x-integration.ts --org <orgId> --execute
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { PrismaClient } from '@prisma/client';
import {
  pickXReplyIntegration,
  XIntegrationCandidate,
} from '@gitroom/nestjs-libraries/engage/resolve-x-reply-integration';

interface CliArgs {
  orgId: string | null;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let orgId: string | null = null;
  let dryRun = true;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--org':
        orgId = args[++i] ?? null;
        if (!orgId) { console.error('--org requires a value'); process.exit(1); }
        break;
      case '--execute': dryRun = false; break;
      case '--dry-run': dryRun = true; break;
      case '--help':
        console.log('Usage: backfill-engage-x-integration.ts [--org <id>] [--dry-run|--execute]');
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }
  return { orgId, dryRun };
}

/** Live X integrations for an org, newest-first — matches the repository query. */
async function liveXCandidates(
  prisma: PrismaClient,
  organizationId: string
): Promise<Array<XIntegrationCandidate & { handle: string | null }>> {
  const rows = await prisma.integration.findMany({
    where: { organizationId, providerIdentifier: 'x', deletedAt: null, disabled: false },
    select: { id: true, profile: true, engageXReplyAccount: { select: { engageEnabled: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map((r) => ({
    id: r.id,
    profile: r.profile,
    handle: r.profile,
    engageEnabled: r.engageXReplyAccount?.engageEnabled ?? false,
  }));
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('=== Backfill Engage X integrationId ===\n');
  console.log(`Mode: ${args.dryRun ? 'DRY RUN (no changes)' : 'EXECUTE'}`);
  console.log(`Org:  ${args.orgId ?? 'all'}\n`);

  const prisma = new PrismaClient();

  const pending = await prisma.engageSentReply.findMany({
    where: {
      ...(args.orgId ? { organizationId: args.orgId } : {}),
      opportunity: { platform: 'x' },
      post: { source: 'engage', integrationId: null },
    },
    select: {
      id: true,
      organizationId: true,
      post: { select: { id: true, releaseURL: true, integrationId: true } },
    },
  });

  console.log(`Found ${pending.length} X engage repl${pending.length === 1 ? 'y' : 'ies'} with no integrationId.\n`);

  const candidateCache = new Map<string, Awaited<ReturnType<typeof liveXCandidates>>>();
  let resolved = 0;
  let unresolved = 0;
  let written = 0;

  for (const r of pending) {
    if (!r.post) continue;
    if (!candidateCache.has(r.organizationId)) {
      candidateCache.set(r.organizationId, await liveXCandidates(prisma, r.organizationId));
    }
    const candidates = candidateCache.get(r.organizationId)!;
    const pick = pickXReplyIntegration(candidates, r.post.releaseURL);

    if (!pick) {
      unresolved++;
      console.log(`  [no-x-account] sentReplyId=${r.id}  url=${r.post.releaseURL ?? 'null'}`);
      continue;
    }

    resolved++;
    const chosen = candidates.find((c) => c.id === pick.integrationId);
    console.log(
      `  [${pick.matchedBy.padEnd(8)}] sentReplyId=${r.id}  ` +
      `-> integration=${pick.integrationId} (@${chosen?.handle ?? '?'})  ` +
      `url=${r.post.releaseURL?.slice(0, 60) ?? 'null'}`
    );

    if (!args.dryRun) {
      await prisma.post.update({
        where: { id: r.post.id },
        data: { integrationId: pick.integrationId },
      });
      written++;
    }
  }

  console.log(
    `\n${args.dryRun ? 'Would resolve' : 'Resolved'}: ${resolved}, ` +
    `unresolved (org has no X account): ${unresolved}` +
    (args.dryRun ? '\n\n--- DRY RUN. Re-run with --execute to write. ---' : `, written: ${written}`)
  );
  if (!args.dryRun && written > 0) {
    console.log(
      '\nNext: re-fetch metrics for the now-linked replies:\n' +
      '  npx ts-node --project scripts/tsconfig.json scripts/sync-engage-x-metrics.ts --org <orgId> --only-missing --execute'
    );
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

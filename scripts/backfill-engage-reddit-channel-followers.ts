/**
 * One-off migration for the Reddit `authorFollowers` → `channelFollowers` rename.
 *
 * Reddit opportunities persisted before the rename stored the SUBREDDIT member count
 * in `EngageOpportunity.authorFollowers`. The field is now split:
 *   - `channelFollowers` = community/channel audience size (drives Reddit authority)
 *   - `authorFollowers`  = the post author's real followers (X only; null on Reddit)
 *
 * This script, for each reddit opportunity, MOVES the value:
 *   channelFollowers := authorFollowers ;  authorFollowers := null
 * `scoreAuthority` is UNCHANGED — it was already computed from the subreddit size,
 * and channelFollowers now holds that same value through the same community curve.
 *
 * It also applies the new monitored-subreddit +5: for each per-org state whose
 * subreddit is in that org's enabled EngageMonitoredChannel set, sets scoreTracked=5
 * and recomputes the total `score` (= scoreKeyword + scoreHeat + scoreAuthority +
 * scoreRecency + scoreTracked). No Reddit network calls — pure DB, fast & idempotent.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-reddit-channel-followers.ts --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-reddit-channel-followers.ts --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-reddit-channel-followers.ts --org <orgId> --execute
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { PrismaClient } from '@prisma/client';

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
        console.log('Usage: backfill-engage-reddit-channel-followers.ts [--org <id>] [--dry-run|--execute]');
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }
  return { orgId, dryRun };
}

/** Enabled monitored subreddit ids for an org (lowercased), cached per org. */
async function monitoredSubreddits(
  prisma: PrismaClient,
  cache: Map<string, Set<string>>,
  organizationId: string
): Promise<Set<string>> {
  const hit = cache.get(organizationId);
  if (hit) return hit;
  const rows = await prisma.engageMonitoredChannel.findMany({
    where: { organizationId, platform: 'reddit', enabled: true },
    select: { channelId: true },
  });
  const set = new Set(rows.map((r) => r.channelId.toLowerCase()));
  cache.set(organizationId, set);
  return set;
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('=== Backfill Reddit authorFollowers → channelFollowers (+ monitored +5) ===\n');
  console.log(`Mode: ${args.dryRun ? 'DRY RUN (no changes)' : 'EXECUTE'}`);
  console.log(`Org:  ${args.orgId ?? 'all'}\n`);

  const prisma = new PrismaClient();

  const opps = await prisma.engageOpportunity.findMany({
    where: {
      platform: 'reddit',
      ...(args.orgId ? { states: { some: { organizationId: args.orgId } } } : {}),
    },
    select: {
      id: true,
      channelId: true,
      authorFollowers: true,
      channelFollowers: true,
      scoreHeat: true,
      scoreAuthority: true,
      scoreRecency: true,
      states: {
        ...(args.orgId ? { where: { organizationId: args.orgId } } : {}),
        select: {
          organizationId: true,
          opportunityId: true,
          scoreKeyword: true,
          scoreTracked: true,
          score: true,
        },
      },
    },
  });

  console.log(`Found ${opps.length} reddit opportunit${opps.length === 1 ? 'y' : 'ies'} to process.\n`);

  const monitoredCache = new Map<string, Set<string>>();
  let oppsMoved = 0;
  let statesUpdated = 0;

  for (const opp of opps) {
    // 1) Move authorFollowers → channelFollowers (idempotent: skip if already moved).
    if (opp.authorFollowers !== null) {
      const targetChannel = opp.channelFollowers ?? opp.authorFollowers;
      console.log(
        `  opp=${opp.id.slice(0, 8)} r/${opp.channelId}: authorFollowers ${opp.authorFollowers}→null, channelFollowers ${opp.channelFollowers ?? 'null'}→${targetChannel}`
      );
      if (!args.dryRun) {
        await prisma.engageOpportunity.update({
          where: { id: opp.id },
          data: { channelFollowers: targetChannel, authorFollowers: null },
        });
      }
      oppsMoved++;
    }

    // 2) Apply monitored-subreddit +5 per org and recompute the total score.
    const subreddit = (opp.channelId ?? '').toLowerCase();
    for (const st of opp.states) {
      const monitored = await monitoredSubreddits(prisma, monitoredCache, st.organizationId);
      const newTracked = subreddit && monitored.has(subreddit) ? 5 : 0;
      const newScore =
        st.scoreKeyword + opp.scoreHeat + opp.scoreAuthority + opp.scoreRecency + newTracked;
      if (st.scoreTracked !== newTracked || st.score !== newScore) {
        console.log(
          `    state[${st.organizationId.slice(0, 8)}]: tracked ${st.scoreTracked}→${newTracked}, score ${st.score}→${newScore}`
        );
        if (!args.dryRun) {
          await prisma.engageOpportunityState.update({
            where: {
              organizationId_opportunityId: {
                organizationId: st.organizationId,
                opportunityId: st.opportunityId,
              },
            },
            data: { scoreTracked: newTracked, score: newScore },
          });
        }
        statesUpdated++;
      }
    }
  }

  console.log(
    `\n${args.dryRun ? 'Would move' : 'Moved'}: ${oppsMoved} opportunit${oppsMoved === 1 ? 'y' : 'ies'}; ` +
    `${args.dryRun ? 'would update' : 'updated'} ${statesUpdated} state row${statesUpdated === 1 ? '' : 's'}` +
    (args.dryRun ? '\n\n--- DRY RUN. Re-run with --execute to write. ---' : '')
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

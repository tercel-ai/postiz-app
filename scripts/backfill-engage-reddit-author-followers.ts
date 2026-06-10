/**
 * Backfill Reddit opportunities after the `authorFollowers` semantics change.
 *
 * Reddit rows persisted under the old design stored the SUBREDDIT member count in
 * `EngageOpportunity.authorFollowers` and derived `scoreAuthority` from it (subreddit
 * size). The new design makes `authorFollowers` the POST AUTHOR's real follower count
 * (u/<name> profile subscribers) and moves the subreddit signal into the per-org
 * `scoreTracked` +5 (monitored subreddit). This script migrates existing rows:
 *
 *   For each reddit EngageOpportunity:
 *     1. re-fetch the author's real followers via getRedditUserAbout (cached /about)
 *     2. set authorFollowers = real followers; scoreAuthority = computeAuthorAuthorityScore(followers)
 *   For each of its EngageOpportunityState rows (per org):
 *     3. scoreTracked = +5 if the opportunity's subreddit is in THAT org's enabled
 *        EngageMonitoredChannel set, else 0
 *     4. score = scoreKeyword + scoreHeat + scoreAuthority + scoreRecency + scoreTracked
 *
 * Opportunities whose author cannot be resolved (Reddit WAF / [deleted]) are SKIPPED
 * (not half-migrated) and counted — re-run to retry (the L1/L2 cache + retries help).
 *
 * Match/score semantics reuse engage-scorer.ts so backfilled scores equal scan-time scores.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-reddit-author-followers.ts --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-reddit-author-followers.ts --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-reddit-author-followers.ts --org <orgId> --execute
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { PrismaClient } from '@prisma/client';
import { computeAuthorAuthorityScore } from '@gitroom/nestjs-libraries/engage/engage-scorer';
import { getRedditUserAbout } from '@gitroom/nestjs-libraries/engage/engage-author';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

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
        console.log('Usage: backfill-engage-reddit-author-followers.ts [--org <id>] [--dry-run|--execute]');
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

  console.log('=== Backfill Reddit authorFollowers + scoreAuthority + scoreTracked ===\n');
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
      authorUsername: true,
      authorFollowers: true,
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
  let oppsUpdated = 0;
  let statesUpdated = 0;
  let skippedUnresolved = 0;

  for (const opp of opps) {
    const about = await getRedditUserAbout(opp.authorUsername, () => undefined);
    if (!about) {
      skippedUnresolved++;
      console.log(`  SKIP u/${opp.authorUsername} (unresolved — WAF/deleted); re-run to retry`);
      continue;
    }
    const followers = about.followers;
    const newAuthority = computeAuthorAuthorityScore(followers);

    // 1+2: opportunity authorFollowers + authority
    const oppChanged =
      (opp.authorFollowers ?? null) !== (followers ?? null) ||
      opp.scoreAuthority !== newAuthority;
    if (oppChanged) {
      console.log(
        `  opp=${opp.id.slice(0, 8)} r/${opp.channelId} u/${opp.authorUsername}: ` +
        `followers ${opp.authorFollowers ?? 'null'}→${followers ?? 'null'}, authority ${opp.scoreAuthority}→${newAuthority}`
      );
      if (!args.dryRun) {
        await prisma.engageOpportunity.update({
          where: { id: opp.id },
          data: { authorFollowers: followers, scoreAuthority: newAuthority },
        });
      }
      oppsUpdated++;
    }

    // 3+4: per-org state tracked + total
    const subreddit = (opp.channelId ?? '').toLowerCase();
    for (const st of opp.states) {
      const monitored = await monitoredSubreddits(prisma, monitoredCache, st.organizationId);
      const newTracked = subreddit && monitored.has(subreddit) ? 5 : 0;
      const newScore =
        st.scoreKeyword + opp.scoreHeat + newAuthority + opp.scoreRecency + newTracked;
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
    `\n${args.dryRun ? 'Would update' : 'Updated'}: ${oppsUpdated} opportunit${oppsUpdated === 1 ? 'y' : 'ies'}, ` +
    `${statesUpdated} state row${statesUpdated === 1 ? '' : 's'}; skipped (unresolved): ${skippedUnresolved}` +
    (args.dryRun ? '\n\n--- DRY RUN. Re-run with --execute to write. ---' : '')
  );

  await prisma.$disconnect();
}

main()
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void (ioRedis as { quit?: () => Promise<unknown> }).quit?.();
  });

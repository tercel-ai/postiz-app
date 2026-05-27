/**
 * Debug tool — manually trigger Engage scans and inspect results.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-scan.ts --all
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-scan.ts --keyword
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-scan.ts --channel
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-scan.ts --tracked
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-scan.ts --stats
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-scan.ts --stats --watch
 *
 * Flags:
 *   --all       Signal all 3 workflows (keyword + channel + tracked)
 *   --keyword   Signal engage-keyword-global only
 *   --channel   Signal engage-channel-global only
 *   --tracked   Signal engage-tracked-global only
 *   --stats     Print DB stats (opportunities, keywords, workflow status)
 *   --watch     After triggering, poll stats every 10s until Ctrl-C
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Connection, Client } from '@temporalio/client';
import { PrismaClient } from '@prisma/client';

const address   = process.env.TEMPORAL_ADDRESS   || 'localhost:7233';
const namespace = process.env.TEMPORAL_NAMESPACE || 'default';

const WORKFLOWS = [
  { id: 'engage-keyword-global', signal: 'triggerKeywordScanNow',  label: 'Keyword scan  (X + Reddit global)' },
  { id: 'engage-channel-global', signal: 'triggerChannelScanNow',  label: 'Channel scan  (Reddit subreddits)' },
  { id: 'engage-tracked-global', signal: 'triggerTrackedScanNow',  label: 'Tracked accs  (X tracked accounts)' },
];

// ─── DB stats ─────────────────────────────────────────────────────────────────

async function printStats(prisma: PrismaClient) {
  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const since1h  = new Date(now.getTime() -      60 * 60 * 1000);

  // Step 1: derive configured platforms from channels + tracked accounts.
  const [channelsByPlatform, trackedByPlatform] = await Promise.all([
    prisma.engageMonitoredChannel.groupBy({ by: ['platform'], _count: { _all: true }, orderBy: { platform: 'asc' } }),
    prisma.engageTrackedAccount.groupBy({  by: ['platform'], _count: { _all: true }, orderBy: { platform: 'asc' } }),
  ]);

  const allPlatforms = Array.from(new Set([
    ...channelsByPlatform.map((r) => r.platform),
    ...trackedByPlatform.map((r) => r.platform),
  ])).sort();

  // Step 2: query opportunities scoped to those platforms only.
  const platformFilter = allPlatforms.length ? { platform: { in: allPlatforms } } : {};

  const [oppByPlatform, topKeywords, recentOpps] = await Promise.all([
    prisma.engageOpportunity.groupBy({
      by: ['platform'],
      where: { deletedAt: null, ...platformFilter },
      _count: { _all: true },
    }),
    prisma.engageKeyword.findMany({
      where: { enabled: true },
      orderBy: { weeklyHitCount: 'desc' },
      take: 10,
      select: { keyword: true, type: true, weeklyHitCount: true, totalHitCount: true },
    }),
    prisma.engageOpportunity.findMany({
      where: { deletedAt: null, ...platformFilter },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { platform: true, authorUsername: true, postContent: true, score: true, createdAt: true },
    }),
  ]);

  const total   = oppByPlatform.reduce((s, r) => s + r._count._all, 0);
  const last24h = recentOpps.filter((o) => o.createdAt >= since24h).length;
  const last1h  = recentOpps.filter((o) => o.createdAt >= since1h).length;

  const oppMap     = new Map(oppByPlatform.map((r)     => [r.platform, r._count._all]));
  const channelMap = new Map(channelsByPlatform.map((r) => [r.platform, r._count._all]));
  const trackedMap = new Map(trackedByPlatform.map((r)  => [r.platform, r._count._all]));

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' ENGAGE STATS  —  ' + new Date().toLocaleString());
  console.log('═══════════════════════════════════════════════════════');

  console.log('\n── Platform Overview ──────────────────────────────────');
  console.log(`  ${'Platform'.padEnd(12)} ${'Opps'.padStart(6)} ${'Channels'.padStart(10)} ${'Tracked'.padStart(9)}`);
  console.log(`  ${'-'.repeat(12)} ${'-'.repeat(6)} ${'-'.repeat(10)} ${'-'.repeat(9)}`);
  if (allPlatforms.length === 0) {
    console.log('  (no data yet)');
  } else {
    for (const p of allPlatforms) {
      console.log(
        `  ${p.padEnd(12)}` +
        ` ${String(oppMap.get(p) ?? 0).padStart(6)}` +
        ` ${String(channelMap.get(p) ?? 0).padStart(10)}` +
        ` ${String(trackedMap.get(p) ?? 0).padStart(9)}`
      );
    }
    console.log(`  ${'TOTAL'.padEnd(12)} ${String(total).padStart(6)}`);
  }
  console.log(`\n  Total: ${total}   Last 24h: ${last24h}   Last 1h: ${last1h}`);

  console.log('\n── Top Keywords (by weekly hits) ──────────────────────');
  if (topKeywords.length === 0) {
    console.log('  (no keywords)');
  } else {
    for (const kw of topKeywords) {
      const type = kw.type ? `[${kw.type}]`.padEnd(12) : ''.padEnd(12);
      console.log(`  ${type} ${kw.keyword.padEnd(30)} week: ${String(kw.weeklyHitCount).padStart(4)}  total: ${kw.totalHitCount}`);
    }
  }

  console.log('\n── Recent Opportunities ───────────────────────────────');
  if (recentOpps.length === 0) {
    console.log('  (none yet)');
  } else {
    for (const opp of recentOpps) {
      const age = Math.round((now.getTime() - opp.createdAt.getTime()) / 60_000);
      const snippet = opp.postContent.replace(/\n/g, ' ').slice(0, 60);
      console.log(`  [${opp.platform.padEnd(7)}] score:${String(opp.score).padStart(3)}  ${age}m ago  @${opp.authorUsername}`);
      console.log(`           "${snippet}"`);
    }
  }

  console.log('');
}

// ─── Workflow status ──────────────────────────────────────────────────────────

async function printWorkflowStatus(client: Client) {
  console.log('── Workflow Status ────────────────────────────────────');
  for (const wf of WORKFLOWS) {
    try {
      const handle = client.workflow.getHandle(wf.id);
      const desc = await handle.describe();
      const status = desc.status.name;
      const started = desc.startTime ? new Date(desc.startTime).toLocaleString() : '?';
      console.log(`  ${wf.id.padEnd(26)} ${status.padEnd(12)} started: ${started}`);
    } catch {
      console.log(`  ${wf.id.padEnd(26)} NOT FOUND`);
    }
  }
  console.log('');
}

// ─── Signal workflows ─────────────────────────────────────────────────────────

async function triggerScans(client: Client, targets: typeof WORKFLOWS) {
  console.log('\n── Triggering Scans ───────────────────────────────────');
  for (const wf of targets) {
    try {
      await client.workflow.getHandle(wf.id).signal(wf.signal);
      console.log(`  ✓ Signaled  ${wf.id}  (${wf.label})`);
    } catch {
      console.log(`  ✗ Not found ${wf.id} — workflow not running`);
    }
  }
  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const doAll     = args.includes('--all');
  const doKeyword = args.includes('--keyword') || doAll;
  const doChannel = args.includes('--channel') || doAll;
  const doTracked = args.includes('--tracked') || doAll;
  const doStats   = args.includes('--stats') || (!doKeyword && !doChannel && !doTracked);
  const doWatch   = args.includes('--watch');

  const targets = WORKFLOWS.filter((wf, i) => [doKeyword, doChannel, doTracked][i]);

  console.log(`\nEngage Debug Tool`);
  console.log(`Temporal: ${address}  namespace: ${namespace}`);
  console.log(`Database: ${(process.env.DATABASE_URL ?? '').replace(/:\/\/[^@]+@/, '://***@')}`);

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });
  const prisma = new PrismaClient();

  try {
    if (targets.length > 0) {
      await triggerScans(client, targets);
    }

    if (doStats || doWatch) {
      await printWorkflowStatus(client);
      await printStats(prisma);
    }

    if (doWatch) {
      console.log('Watching for new results (Ctrl-C to stop)...\n');
      const interval = setInterval(async () => {
        await printStats(prisma);
      }, 10_000);
      process.on('SIGINT', () => {
        clearInterval(interval);
        console.log('\nStopped.');
        process.exit(0);
      });
      // Keep process alive
      await new Promise(() => {});
    }
  } finally {
    if (!doWatch) {
      await prisma.$disconnect();
      await connection.close();
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

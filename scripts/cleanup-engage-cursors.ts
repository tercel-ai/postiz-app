/**
 * Delete orphaned / zombie EngageScanCursor rows.
 *
 * Three independent rules (all enabled by default; pass flags to run a subset):
 *
 *   --legacy-global   keyword cursors with the bare pre-bucket scanKey
 *                     '__global__' (orphaned by the __global__:<hours> migration).
 *   --orphan-tracked  tracked cursors whose scanKey is NOT '__tracked__:<hours>'
 *                     (per-username rows left behind by the tracked-merge change).
 *   --stale           any cursor not scanned in --stale-days (default 14) days —
 *                     since every live unit has a ≤24h cadence, anything that has
 *                     not started a scan in two weeks no longer has an owning unit
 *                     (e.g. dead per-keyword X cursors from the extension after X
 *                     was disabled there, removed keywords, untracked accounts).
 *
 * Read-only by default. Pass --execute to actually delete. Always prints a
 * per-(platform,scanType) breakdown with sample keys before touching anything.
 *
 * Usage:
 *   npx tsx scripts/cleanup-engage-cursors.ts                 # dry-run, all rules
 *   npx tsx scripts/cleanup-engage-cursors.ts --execute       # delete, all rules
 *   npx tsx scripts/cleanup-engage-cursors.ts --orphan-tracked --execute
 *   npx tsx scripts/cleanup-engage-cursors.ts --stale --stale-days=30 --execute
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const staleDays = Number(
  args.find((a) => a.startsWith('--stale-days='))?.split('=')[1] ?? 14
);

// If no rule flag is passed, run all three.
const ruleFlags = ['--legacy-global', '--orphan-tracked', '--stale'];
const anyRule = ruleFlags.some((f) => args.includes(f));
const wantLegacy = !anyRule || args.includes('--legacy-global');
const wantOrphanTracked = !anyRule || args.includes('--orphan-tracked');
const wantStale = !anyRule || args.includes('--stale');

function ago(d: Date | null | undefined, now: number): string {
  if (!d) return 'never';
  const h = (now - new Date(d).getTime()) / 3_600_000;
  return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
}

async function main() {
  const prisma = new PrismaClient();
  const now = Date.now();
  const staleBefore = new Date(now - staleDays * 24 * 3_600_000);

  console.log('=== Cleanup EngageScanCursor ===');
  console.log(`Mode:   ${execute ? 'EXECUTE (will delete)' : 'DRY RUN (pass --execute)'}`);
  console.log(
    `Rules:  ${[
      wantLegacy && 'legacy-global',
      wantOrphanTracked && 'orphan-tracked',
      wantStale && `stale>${staleDays}d`,
    ]
      .filter(Boolean)
      .join(', ')}\n`
  );

  // Collect candidate ids by rule. A row may match multiple rules; dedupe by id.
  const candidates = new Map<string, any>();

  if (wantLegacy) {
    const rows = await prisma.engageScanCursor.findMany({
      where: { scanType: 'keyword', scanKey: '__global__' },
    });
    for (const r of rows) candidates.set(r.id, { ...r, _rule: 'legacy-global' });
    console.log(`legacy-global:   ${rows.length} bare '__global__' keyword cursor(s)`);
  }

  if (wantOrphanTracked) {
    const rows = await prisma.engageScanCursor.findMany({
      where: { scanType: 'tracked', NOT: { scanKey: { startsWith: '__tracked__:' } } },
    });
    for (const r of rows)
      if (!candidates.has(r.id)) candidates.set(r.id, { ...r, _rule: 'orphan-tracked' });
    console.log(`orphan-tracked:  ${rows.length} per-username tracked cursor(s)`);
  }

  if (wantStale) {
    // Stale = last scan started before the cutoff, OR never started and created
    // before the cutoff (a row that's existed for weeks but never ran).
    const rows = await prisma.engageScanCursor.findMany({
      where: {
        OR: [
          { lastScanStartedAt: { lt: staleBefore } },
          { lastScanStartedAt: null, createdAt: { lt: staleBefore } },
        ],
      },
    });
    let added = 0;
    for (const r of rows)
      if (!candidates.has(r.id)) {
        candidates.set(r.id, { ...r, _rule: 'stale' });
        added++;
      }
    console.log(
      `stale>${staleDays}d:      ${rows.length} cursor(s) (${added} new beyond the rules above)`
    );
  }

  const rows = Array.from(candidates.values());
  if (!rows.length) {
    console.log('\nNothing to clean up. ✓');
    await prisma.$disconnect();
    return;
  }

  // Breakdown by (platform, scanType).
  console.log('\n── Candidates by (platform, scanType) ──');
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const k = `${r.platform}/${r.scanType}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  for (const [k, list] of [...groups].sort()) {
    const sample = list
      .slice(0, 6)
      .map((r) => `${r.scanKey}(${r._rule},${ago(r.lastScanStartedAt, now)})`)
      .join(', ');
    console.log(`  ${k.padEnd(18)} ${String(list.length).padStart(3)}  e.g. ${sample}`);
  }
  console.log(`\nTotal: ${rows.length} cursor(s)`);

  if (!execute) {
    console.log('\nDRY RUN — pass --execute to delete the rows above.');
    await prisma.$disconnect();
    return;
  }

  const ids = rows.map((r) => r.id);
  const del = await prisma.engageScanCursor.deleteMany({ where: { id: { in: ids } } });
  console.log(`\nDeleted ${del.count} cursor(s).`);
  console.log(
    'Active buckets (__global__:<h>, __tracked__:<h>) and live per-keyword/channel'
  );
  console.log('cursors are untouched and self-heal from null on the next scan.');

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

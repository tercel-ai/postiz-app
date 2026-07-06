/**
 * Reconcile every EngageScanCursor against the CURRENTLY-SUBSCRIBED config so
 * each cursor is labelled LIVE (an enabled org still subscribes to it) or ORPHAN
 * (no enabled org does — the keyword/account/subreddit was removed/disabled, or
 * the whole org was disabled, so the workflow never enumerates it again).
 *
 * This is the missing dimension in show-engage-scan-cadence.ts: that script marks
 * a cursor "DUE NOW" from its AGE alone and has no idea whether anything still
 * owns it. A cursor stuck at 150h+ that is ORPHAN is expected (dead data, prune
 * it); one that is LIVE is a real scan failure worth chasing.
 *
 * Subscription is resolved the SAME way runDueScans does it: only engageConfig
 * rows with enabled=true, and within them only enabled keywords / tracked
 * accounts / monitored channels. Keys are normalized identically to the scan
 * path (keyword: trim+lowercase+collapse-ws; X username: strip @ / u/, lowercase;
 * channel: raw channelId).
 *
 * Read-only. Touches nothing.
 *
 * Usage:
 *   npx tsx scripts/engage-cursor-orphan-check.ts              # all cursors
 *   npx tsx scripts/engage-cursor-orphan-check.ts --orphans    # only ORPHAN rows
 *   npx tsx scripts/engage-cursor-orphan-check.ts --live-stale # LIVE but >24h stale (the real bugs)
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const orphansOnly = args.includes('--orphans');
const liveStaleOnly = args.includes('--live-stale');

// Mirror engage-scan-lease.service.ts normalization (kept inline so the script
// has no cross-package import surprises under tsx).
const CASE_INSENSITIVE = new Set(['x', 'reddit', 'threads', 'instagram', 'tiktok']);
function normalizeKeyword(k: string): string {
  return k.trim().toLowerCase().replace(/\s+/g, ' ');
}
function normalizeUsername(platform: string, username: string): string {
  const t = username.trim();
  if (CASE_INSENSITIVE.has(platform.toLowerCase())) {
    return t.replace(/^@/, '').replace(/^\/?u\//i, '').toLowerCase();
  }
  return t;
}

function ago(d: Date | null | undefined, now: number): string {
  if (!d) return 'never';
  const h = (now - new Date(d).getTime()) / 3_600_000;
  return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
}

async function main() {
  const prisma = new PrismaClient();
  const now = Date.now();

  // ── Currently-subscribed sets (exactly what the workflow enumerates) ────────
  const configs = await prisma.engageConfig.findMany({
    where: { enabled: true },
    include: {
      keywords: { where: { enabled: true }, select: { keyword: true } },
      trackedAccounts: { where: { enabled: true }, select: { username: true, platform: true } },
      monitoredChannels: { where: { enabled: true }, select: { channelId: true, platform: true } },
    },
  });

  const liveKeywords = new Set<string>();
  const liveTracked = new Set<string>(); // normalized X usernames
  const liveChannels = new Set<string>(); // raw channelIds
  for (const c of configs) {
    for (const k of c.keywords) {
      const key = normalizeKeyword(k.keyword);
      if (key) liveKeywords.add(key);
    }
    for (const a of c.trackedAccounts) {
      liveTracked.add(normalizeUsername(a.platform ?? 'x', a.username));
    }
    for (const ch of c.monitoredChannels) {
      liveChannels.add(ch.channelId);
    }
  }

  console.log('=== EngageScanCursor orphan check ===');
  console.log(
    `Enabled orgs: ${configs.length} | live keywords: ${liveKeywords.size} | live tracked: ${liveTracked.size} | live channels: ${liveChannels.size}\n`
  );

  const cursors = await prisma.engageScanCursor.findMany({
    orderBy: [{ scanType: 'asc' }, { platform: 'asc' }, { scanKey: 'asc' }],
  });

  function isLive(scanType: string, scanKey: string): boolean {
    if (scanType === 'keyword') return liveKeywords.has(scanKey);
    if (scanType === 'tracked') return liveTracked.has(scanKey);
    if (scanType === 'channel') return liveChannels.has(scanKey);
    return false; // unknown scanType → treat as orphan
  }

  let liveCount = 0;
  let orphanCount = 0;
  let liveStaleCount = 0;
  const STALE_H = 48; // a LIVE unit older than this is a real scan problem

  const printed: string[] = [];
  for (const c of cursors) {
    const live = isLive(c.scanType, c.scanKey);
    if (live) liveCount++;
    else orphanCount++;

    const startedH = c.lastScanStartedAt
      ? (now - new Date(c.lastScanStartedAt).getTime()) / 3_600_000
      : Infinity;
    const liveStale = live && startedH > STALE_H;
    if (liveStale) liveStaleCount++;

    if (orphansOnly && live) continue;
    if (liveStaleOnly && !liveStale) continue;

    const label = live ? (liveStale ? 'LIVE⚠' : 'LIVE') : 'ORPHAN';
    printed.push(
      [
        label.padEnd(7),
        c.platform.padEnd(7),
        c.scanType.padEnd(8),
        c.scanKey.slice(0, 26).padEnd(27),
        c.status.padEnd(9),
        `start ${ago(c.lastScanStartedAt, now)}`.padEnd(16),
        `done ${ago(c.lastScannedAt, now)}`,
      ].join(' ')
    );
  }

  if (printed.length) console.log(printed.join('\n'));

  console.log(
    `\n${cursors.length} cursor(s): ${liveCount} LIVE, ${orphanCount} ORPHAN, ${liveStaleCount} LIVE-but->${STALE_H}h-stale (the real bugs).`
  );
  console.log(
    'ORPHAN rows are safe to prune with: npx tsx scripts/cleanup-engage-cursors.ts --execute'
  );
  console.log(
    'LIVE⚠ rows are genuinely subscribed yet not scanning — investigate those.'
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

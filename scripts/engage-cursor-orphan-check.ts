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
 * Subscription is resolved the SAME way the scan path does it: engageConfig rows
 * with enabled=true AND a non-null projectId (the legacy null-project row is
 * excluded from fan-out), and within them only enabled keywords and scan
 * targets. Keys come from the SAME functions the scan loop uses — normalizeKeyword
 * and scanKeyFor, imported rather than re-implemented — so this tool cannot drift
 * from the thing it is auditing.
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
// Imported, NOT re-implemented. Inline copies of these lived here and drifted:
// the local CASE_INSENSITIVE set was missing devto/medium, so every live cursor
// on those platforms was labelled ORPHAN — under a summary line telling the
// operator ORPHAN rows are safe to prune. The sibling scripts already import
// from @gitroom/* under tsx, so there is no resolution problem to work around.
import { normalizeKeyword } from '@gitroom/nestjs-libraries/engage/engage-scan-lease.service';
import {
  normalizePlatform,
  scanKeyFor,
  scanTypeFor,
} from '@gitroom/nestjs-libraries/engage/engage-scan-target';

const args = process.argv.slice(2);
const orphansOnly = args.includes('--orphans');
const liveStaleOnly = args.includes('--live-stale');

function ago(d: Date | null | undefined, now: number): string {
  if (!d) return 'never';
  const h = (now - new Date(d).getTime()) / 3_600_000;
  return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
}

async function main() {
  const prisma = new PrismaClient();
  const now = Date.now();

  // ── Currently-subscribed sets (exactly what the workflow enumerates) ────────
  //
  // `projectId: { not: null }` is NOT optional: the legacy null-project config
  // is excluded from fan-out by every production enumerator
  // (getAllEnabledOrgContexts / getEnabledConfigsForOrg / getOrgContextsForUnit,
  // pinned by engage-repository.null-project-exclusion.spec.ts). Omitting it
  // here counted pre-project keywords as live, so their orphan cursors printed
  // as LIVE⚠ and sent the operator chasing a unit nothing subscribes to.
  const configs = await prisma.engageConfig.findMany({
    where: { enabled: true, projectId: { not: null } },
    include: {
      keywords: { where: { enabled: true }, select: { keyword: true } },
      // One relation, two scopes — split by platform below (scanTypeFor).
      trackedAccounts: { where: { enabled: true }, select: { username: true, platform: true } },
    },
  });

  const liveKeywords = new Set<string>();
  // Target sets are keyed `${platform}:${normalizedKey}` — the cursor table is
  // unique on (platform, scanType, scanKey), so a bare key would let one
  // platform's handle keep an identically-named cursor on another platform
  // labelled LIVE.
  const liveTracked = new Set<string>();
  const liveChannels = new Set<string>();
  for (const c of configs) {
    for (const k of c.keywords) {
      const key = normalizeKeyword(k.keyword);
      if (key) liveKeywords.add(key);
    }
    for (const t of c.trackedAccounts) {
      const platform = normalizePlatform(t.platform) || 'x';
      const key = `${platform}:${scanKeyFor({ platform, username: t.username })}`;
      if (scanTypeFor(platform) === 'channel') liveChannels.add(key);
      else liveTracked.add(key);
    }
  }

  console.log('=== EngageScanCursor orphan check ===');
  console.log(
    `Enabled orgs: ${configs.length} | live keywords: ${liveKeywords.size} | live tracked: ${liveTracked.size} | live channels: ${liveChannels.size}\n`
  );

  const cursors = await prisma.engageScanCursor.findMany({
    orderBy: [{ scanType: 'asc' }, { platform: 'asc' }, { scanKey: 'asc' }],
  });

  function isLive(scanType: string, platform: string, scanKey: string): boolean {
    // Keyword units are GLOBAL (one cursor per platform per normalized keyword),
    // so their liveness is platform-independent; target units are per-platform.
    if (scanType === 'keyword') return liveKeywords.has(scanKey);
    const key = `${normalizePlatform(platform)}:${scanKey}`;
    if (scanType === 'tracked') return liveTracked.has(key);
    if (scanType === 'channel') return liveChannels.has(key);
    return false; // unknown scanType → treat as orphan
  }

  let liveCount = 0;
  let orphanCount = 0;
  let liveStaleCount = 0;
  const STALE_H = 48; // a LIVE unit older than this is a real scan problem

  const printed: string[] = [];
  for (const c of cursors) {
    const live = isLive(c.scanType, c.platform, c.scanKey);
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

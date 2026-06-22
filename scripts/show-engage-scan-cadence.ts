/**
 * Show the REAL engage scan cadence currently in effect.
 *
 * Reads straight from the database (not code defaults), so it reflects any
 * admin overrides stored in the Settings table:
 *   1. engage_entitlements  -> per-plan scanIntervalHours
 *   2. engage_scan_pacing    -> per-platform maxPages / pageSize / delays
 *   3. EngageScanCursor rows  -> the ground truth: when each unit last scanned
 *      and when it is next DUE (lastScanStartedAt + plan cadence).
 *
 * Usage:
 *   npx tsx scripts/show-engage-scan-cadence.ts
 *   npx tsx scripts/show-engage-scan-cadence.ts --platform=x   # only X cursors
 *   npx tsx scripts/show-engage-scan-cadence.ts --due          # only units due now
 *
 * Read-only. Touches nothing.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';

const DEFAULT_SCAN_INTERVAL_HOURS = 24; // mirror of engage-entitlement.service.ts
const DEFAULT_TICK_MINUTES = 5;

const args = process.argv.slice(2);
const platformFilter = args
  .find((a) => a.startsWith('--platform='))
  ?.split('=')[1]
  ?.toLowerCase();
const dueOnly = args.includes('--due');

function fmt(d: Date | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function ago(d: Date | null | undefined, now: number): string {
  if (!d) return '—';
  const mins = Math.round((now - new Date(d).getTime()) / 60000);
  if (mins < 0) return `in ${-mins}m`;
  if (mins < 60) return `${mins}m ago`;
  const h = (mins / 60).toFixed(1);
  return `${h}h ago`;
}

async function main() {
  const prisma = new PrismaClient();
  const now = Date.now();

  // ── 1. Effective tick heartbeat ──────────────────────────────────────────
  const tickMinutes = Number(
    process.env.ENGAGE_SCAN_TICK_MINUTES ?? DEFAULT_TICK_MINUTES
  );
  console.log('═══ Ticker heartbeat ═══');
  console.log(`  ENGAGE_SCAN_TICK_MINUTES = ${tickMinutes} min`);
  console.log(
    `  ENGAGE_SCAN_MAX_CALLS    = ${process.env.ENGAGE_SCAN_MAX_CALLS ?? 5} calls/unit/run`
  );

  // ── 2. Per-plan scan intervals (engage_entitlements) ─────────────────────
  console.log('\n═══ Per-plan scan interval (engage_entitlements) ═══');
  const entRow = await prisma.settings.findUnique({
    where: { key: 'engage_entitlements' },
  });
  const entVal: any = entRow?.value ?? entRow?.default ?? null;
  const planIntervals: Record<string, number> = {};
  if (!entVal) {
    console.log(
      `  (no DB row — falling back to DEFAULT_SCAN_INTERVAL_HOURS = ${DEFAULT_SCAN_INTERVAL_HOURS}h for every org)`
    );
  } else {
    // entVal is expected to be a map: { starter: {...,scanIntervalHours}, ... }
    for (const [plan, limits] of Object.entries<any>(entVal)) {
      const hours =
        limits?.scanIntervalHours ?? limits?.scan_interval_hours ?? null;
      if (hours != null) planIntervals[plan] = Number(hours);
      console.log(
        `  ${plan.padEnd(12)} scanIntervalHours = ${
          hours ?? '(unset → 24h)'
        }`
      );
    }
    console.log(
      `  source: ${entRow?.value ? 'Settings.value (admin override)' : 'Settings.default (seeded)'}`
    );
  }

  // ── 3. Pacing (engage_scan_pacing) ───────────────────────────────────────
  console.log('\n═══ Scan pacing (engage_scan_pacing) ═══');
  const pacingRow = await prisma.settings.findUnique({
    where: { key: 'engage_scan_pacing' },
  });
  const pacingVal: any = pacingRow?.value ?? pacingRow?.default ?? null;
  if (!pacingVal) {
    console.log('  (no DB row — using code DEFAULT_SCAN_PACING)');
  } else {
    console.log(
      `  source: ${pacingRow?.value ? 'Settings.value (admin override)' : 'Settings.default (seeded)'}`
    );
    console.log('  ' + JSON.stringify(pacingVal, null, 2).replace(/\n/g, '\n  '));
  }

  // ── 4. EngageScanCursor — the ground truth ───────────────────────────────
  console.log('\n═══ Scan cursors (real last/next scan per unit) ═══');
  const where = platformFilter ? { platform: platformFilter } : {};
  const cursors = await prisma.engageScanCursor.findMany({
    where,
    orderBy: [{ platform: 'asc' }, { scanType: 'asc' }, { scanKey: 'asc' }],
  });

  if (!cursors.length) {
    console.log('  (no cursor rows — nothing has ever been scanned yet)');
  } else {
    // We don't know each unit's owning-org plan here, so show next-due under
    // BOTH the fastest configured plan and the 24h default as a range.
    const configuredHours = Object.values(planIntervals);
    const minHours = configuredHours.length
      ? Math.min(...configuredHours)
      : DEFAULT_SCAN_INTERVAL_HOURS;
    const maxHours = configuredHours.length
      ? Math.max(...configuredHours, DEFAULT_SCAN_INTERVAL_HOURS)
      : DEFAULT_SCAN_INTERVAL_HOURS;

    console.log(
      `  next-due range computed with cadence ${minHours}h..${maxHours}h\n`
    );
    console.log(
      '  ' +
        ['PLATFORM', 'TYPE', 'KEY', 'STATUS', 'LAST STARTED', 'LAST DONE', 'COOLDOWN', `NEXT DUE (@${minHours}h)`]
          .map((h, i) => h.padEnd([8, 8, 24, 9, 18, 12, 12, 22][i]))
          .join('')
    );

    let dueCount = 0;
    for (const c of cursors) {
      const started = c.lastScanStartedAt
        ? new Date(c.lastScanStartedAt).getTime()
        : 0;
      const nextDueMin = started ? started + minHours * 3600_000 : now;
      const cooling = c.cooldownUntil && new Date(c.cooldownUntil).getTime() > now;
      const isDue = !cooling && nextDueMin <= now;
      if (isDue) dueCount++;
      if (dueOnly && !isDue) continue;

      const dueLabel = cooling
        ? `cooling ${ago(c.cooldownUntil, now)}`
        : isDue
        ? 'DUE NOW'
        : ago(new Date(nextDueMin), now);

      console.log(
        '  ' +
          [
            c.platform,
            c.scanType,
            c.scanKey.slice(0, 23),
            c.status,
            ago(c.lastScanStartedAt, now),
            ago(c.lastScannedAt, now),
            cooling ? fmt(c.cooldownUntil) : '—',
            dueLabel,
          ]
            .map((v, i) => String(v).padEnd([8, 8, 24, 9, 18, 12, 12, 22][i]))
            .join('')
      );
    }

    console.log(
      `\n  ${cursors.length} cursor(s); ${dueCount} due now (at fastest ${minHours}h cadence, excl. cooldown).`
    );
    console.log(
      '  NOTE: actual next-due uses each unit\'s MIN owning-org plan cadence.'
    );
    console.log(
      '        A unit shared with a Pro org scans at the Pro interval; otherwise slower.'
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

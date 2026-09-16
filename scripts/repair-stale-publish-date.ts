/**
 * One-off repair for posts and engage replies that were PUBLISHED before
 * `publishDate` started recording the real send time.
 *
 * Until this was fixed, every publish-success commit flipped `state` to
 * PUBLISHED and left `publishDate` holding the moment we INTENDED to send —
 * the scheduled minute for a post, the save-draft moment for an engage reply.
 * The extension sends on its own clock (a closed browser, a lease taken late,
 * reply pacing, a platform retry), so rows routinely claim a send time hours
 * before the send actually happened, and the calendar, `/dashboard/*`, the
 * engage replies-trend buckets and the metrics freshness gate all read that
 * column as "when did this go out".
 *
 * ── The evidence this script uses ───────────────────────────────────────────
 * There is no `publishedAt` column to recover from, so the repair leans on the
 * one timestamp the codebase ALREADY treats as the real write moment:
 *
 *   `Post.claimedAt` — stamped when the extension takes the post/reply to
 *   publish it (claimExtensionPublishPosts, claimDueEngageReplies). See
 *   getLastPlatformWriteAt's note: "it is stamped when the extension takes the
 *   post to publish, which is the instant the platform actually sees traffic —
 *   publishDate is only when we intended to."
 *
 * It is a hand-out, so it precedes the send by seconds to a few minutes, not
 * hours — far closer to the truth than a scheduled time that can be a whole
 * day off. It also survives everything that happens afterwards: the publish
 * commit overwrites `releaseId` but never `claimedAt`, and the expiry/retry
 * paths preserve it on purpose.
 *
 * `updatedAt` is deliberately NOT used as a fallback. It looks like the
 * commit time but is bumped by every later write — metrics sync
 * (impressions/trafficScore/analytics/lastMetricsFetchAt), publisher
 * attribution, async author enrichment, removal callbacks — so for an engage
 * reply whose counters are still being polled it can sit days past the send
 * and would replace a wrong value with a worse one. A row with no `claimedAt`
 * is reported as unrecoverable instead of guessed at.
 *
 * ── What it refuses to touch ────────────────────────────────────────────────
 *   - Any group containing a recurring post (`intervalInDays > 0`). There
 *     `publishDate` is not a timestamp but the clone's IDENTITY:
 *     findOrCreateCycleClone matches a cycle by `(group, publishDate)`, so
 *     moving it would hide the published clone and let a restarted workflow
 *     post the content a second time.
 *   - Any row that is not PUBLISHED. A QUEUE row's `publishDate` is when it is
 *     still DUE to go out; rewriting it would reschedule a pending post.
 *   - Anything that would move a date BACKWARDS, and anything whose drift is
 *     under --min-drift-minutes (the API/Temporal path commits within seconds
 *     and has no claimedAt at all, so it is excluded for free).
 *   - `EngageSentReply.createdAt` — that is the DRAFTING time and feeds reply
 *     pacing (getLastSentReplyAt). Rewriting it would falsify pacing history.
 *
 * A thread is repaired as a whole: only the anchor is ever claimed (the
 * publish-due query is roots-only), so its segments inherit the anchor's
 * instant — exactly what the fixed publish path now does for new sends.
 *
 * Read-only (dry-run) by DEFAULT. Pass --execute to write.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/repair-stale-publish-date.ts
 *   npx ts-node --project scripts/tsconfig.json scripts/repair-stale-publish-date.ts --source engage
 *   npx ts-node --project scripts/tsconfig.json scripts/repair-stale-publish-date.ts --org <orgId> --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/repair-stale-publish-date.ts --since 2026-08-01 --execute
 */
import * as dotenv from 'dotenv';
dotenv.config();

process.env.TZ = 'UTC';

import { PrismaClient } from '@prisma/client';

/** Below this the drift is not worth a write (and is not a real complaint). */
const DEFAULT_MIN_DRIFT_MINUTES = 2;
/**
 * A hand-out this far past the intended time is almost certainly a genuine
 * late send (a browser offline for days, a lease re-taken after an outage),
 * but it is also the shape a data problem would take — so it is skipped by
 * default and reported, rather than written blind. Raise or disable with
 * --max-drift-hours 0.
 */
const DEFAULT_MAX_DRIFT_HOURS = 168; // 7 days
const DEFAULT_LIMIT = 5000;
/** How many per-group lines the report prints before folding the rest. */
const PREVIEW_LINES = 40;

// ── Pure planning logic (unit-tested in repair-stale-publish-date.spec.ts) ───

export interface PostRow {
  id: string;
  group: string;
  state: string;
  parentPostId: string | null;
  publishDate: Date;
  claimedAt: Date | null;
  intervalInDays: number | null;
}

export interface RepairOptions {
  minDriftMs: number;
  /** 0 disables the ceiling. */
  maxDriftMs: number;
}

export type SkipReason =
  | 'recurring'
  | 'no-evidence'
  | 'not-later'
  | 'below-min-drift'
  | 'above-max-drift'
  | 'nothing-to-write';

// A STRING discriminant, not a boolean `ok`: this repo compiles with
// `strictNullChecks: false` (tsconfig.base.json), under which TypeScript does
// not narrow a union by a boolean literal property — `if (!plan.ok)` would
// leave `plan.reason` unreachable.
export type GroupPlan =
  | {
      action: 'repair';
      sentAt: Date;
      intendedAt: Date;
      driftMs: number;
      rowIds: string[];
    }
  | { action: 'skip'; reason: SkipReason };

/**
 * Decide what one group's rows should be re-dated to, from the group ALONE.
 *
 * Takes every row of the group regardless of state — a QUEUE original with
 * `intervalInDays` set is what disqualifies its clones, and it can only be
 * seen by looking past the PUBLISHED ones.
 */
export function planGroupRepair(
  rows: PostRow[],
  opts: RepairOptions
): GroupPlan {
  if (rows.some((r) => (r.intervalInDays ?? 0) > 0)) {
    return { action: 'skip', reason: 'recurring' };
  }

  // The latest hand-out in the group is the one that led to the send: a lease
  // that expired and was re-taken overwrites the earlier claim, and the publish
  // that finally succeeded followed the last of them.
  const claimed = rows.filter(
    (r): r is PostRow & { claimedAt: Date } => r.claimedAt != null
  );
  if (!claimed.length) return { action: 'skip', reason: 'no-evidence' };
  const anchor = claimed.reduce((a, b) =>
    b.claimedAt.getTime() > a.claimedAt.getTime() ? b : a
  );

  const sentAt = anchor.claimedAt;
  const intendedAt = anchor.publishDate;
  const driftMs = sentAt.getTime() - intendedAt.getTime();
  // A send earlier than the intention is either a clock skew or a row this
  // script has already repaired. Never rewrite history backwards.
  if (driftMs <= 0) return { action: 'skip', reason: 'not-later' };
  if (driftMs < opts.minDriftMs) {
    return { action: 'skip', reason: 'below-min-drift' };
  }
  if (opts.maxDriftMs > 0 && driftMs > opts.maxDriftMs) {
    return { action: 'skip', reason: 'above-max-drift' };
  }

  // PUBLISHED only. A QUEUE sibling's publishDate is when it is still due to go
  // out, and an ERROR row never went out at all.
  const rowIds = rows
    .filter((r) => r.state === 'PUBLISHED')
    .filter((r) => r.publishDate.getTime() !== sentAt.getTime())
    .map((r) => r.id);
  if (!rowIds.length) return { action: 'skip', reason: 'nothing-to-write' };

  return { action: 'repair', sentAt, intendedAt, driftMs, rowIds };
}

/** Drift buckets, so the dry-run says how bad the problem actually is. */
export const DRIFT_BUCKETS: Array<{ label: string; maxMs: number }> = [
  { label: '< 5m', maxMs: 5 * 60_000 },
  { label: '5m–30m', maxMs: 30 * 60_000 },
  { label: '30m–2h', maxMs: 2 * 3_600_000 },
  { label: '2h–12h', maxMs: 12 * 3_600_000 },
  { label: '12h–24h', maxMs: 24 * 3_600_000 },
  { label: '> 24h', maxMs: Number.POSITIVE_INFINITY },
];

export function bucketOf(driftMs: number): string {
  return (DRIFT_BUCKETS.find((b) => driftMs < b.maxMs) ?? DRIFT_BUCKETS[DRIFT_BUCKETS.length - 1])
    .label;
}

export function humanDelta(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = ms / 3_600_000;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function fmt(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function usage(): void {
  console.log(
    `Repair stale Post.publishDate on already-published rows.

  --dry-run                 Report only, write nothing (DEFAULT)
  --execute                 Apply the repairs
  --org <id>                Scope to one organization
  --source <name>           Scope to one Post.source (e.g. engage, calendar)
  --since <YYYY-MM-DD>      Only rows whose publishDate is on/after this date
  --min-drift-minutes <n>   Ignore drift under n minutes (default ${DEFAULT_MIN_DRIFT_MINUTES})
  --max-drift-hours <n>     Skip drift over n hours, 0 = no ceiling (default ${DEFAULT_MAX_DRIFT_HOURS})
  --limit <n>               Max candidate rows to read (default ${DEFAULT_LIMIT})
  --help`
  );
}

async function main(): Promise<void> {
  if (flag('help')) {
    usage();
    return;
  }

  const prisma = new PrismaClient();
  try {
    const execute = flag('execute');
    const org = arg('org');
    const source = arg('source');
    const since = arg('since');
    const minDriftMs = Number(arg('min-drift-minutes') ?? DEFAULT_MIN_DRIFT_MINUTES) * 60_000;
    const maxDriftMs = Number(arg('max-drift-hours') ?? DEFAULT_MAX_DRIFT_HOURS) * 3_600_000;
    const limit = Number(arg('limit') ?? DEFAULT_LIMIT);

    if (since && Number.isNaN(Date.parse(since))) {
      console.error(`--since must be a date, got "${since}"`);
      process.exit(1);
    }

    console.log('=== Repair stale publishDate ===\n');
    console.log(`Mode:       ${execute ? 'EXECUTE' : 'DRY RUN (no changes)'}`);
    console.log(`Org:        ${org ?? 'all'}`);
    console.log(`Source:     ${source ?? 'all'}`);
    console.log(`Since:      ${since ?? 'all time'}`);
    console.log(`Min drift:  ${humanDelta(minDriftMs)}`);
    console.log(`Max drift:  ${maxDriftMs > 0 ? humanDelta(maxDriftMs) : 'no ceiling'}`);
    console.log(`Limit:      ${limit} candidate row(s)\n`);

    const scope = {
      ...(org ? { organizationId: org } : {}),
      ...(source ? { source } : {}),
      ...(since ? { publishDate: { gte: new Date(since) } } : {}),
    };

    // Candidates: PUBLISHED rows that carry the evidence. Children of a thread
    // are picked up through their group below, never here — only roots are
    // claimed.
    const candidates = await prisma.post.findMany({
      where: {
        ...scope,
        state: 'PUBLISHED',
        deletedAt: null,
        claimedAt: { not: null },
      },
      orderBy: { publishDate: 'desc' },
      take: limit,
      select: { group: true },
    });
    const groups = [...new Set(candidates.map((c) => c.group))];

    // Coverage: how many published rows in the same scope have NO claimedAt at
    // all. Those are unrecoverable — worth saying out loud rather than letting
    // the operator assume the repair was complete.
    const noEvidence = await prisma.post.count({
      where: { ...scope, state: 'PUBLISHED', deletedAt: null, claimedAt: null },
    });

    console.log(
      `Found ${candidates.length} claimed published row(s) across ${groups.length} group(s).`
    );
    console.log(
      `${noEvidence} published row(s) in scope have no claimedAt — not repairable, left as-is.\n`
    );
    if (!groups.length) {
      console.log('Nothing to do.');
      return;
    }

    // Every row of every candidate group, in ANY state: a QUEUE recurring
    // original is what disqualifies its own clones.
    const rows = (await prisma.post.findMany({
      where: { group: { in: groups }, deletedAt: null },
      select: {
        id: true,
        group: true,
        state: true,
        parentPostId: true,
        publishDate: true,
        claimedAt: true,
        intervalInDays: true,
        source: true,
        providerIdentifier: true,
        organizationId: true,
      },
    })) as Array<PostRow & { source: string; providerIdentifier: string | null }>;

    const byGroup = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byGroup.get(r.group);
      if (list) list.push(r);
      else byGroup.set(r.group, [r]);
    }

    const skipped: Record<string, number> = {};
    const buckets: Record<string, number> = {};
    const lines: string[] = [];
    let repairedGroups = 0;
    let repairedRows = 0;

    for (const [group, groupRows] of byGroup) {
      const plan = planGroupRepair(groupRows, { minDriftMs, maxDriftMs });
      if (plan.action === 'skip') {
        skipped[plan.reason] = (skipped[plan.reason] ?? 0) + 1;
        continue;
      }

      const sample = groupRows.find((r) => r.claimedAt != null)!;
      buckets[bucketOf(plan.driftMs)] = (buckets[bucketOf(plan.driftMs)] ?? 0) + 1;
      lines.push(
        `[${sample.source}/${sample.providerIdentifier ?? '?'}] group=${group} ` +
          `${plan.rowIds.length} row(s)  ${fmt(plan.intendedAt)} → ${fmt(plan.sentAt)} ` +
          `(+${humanDelta(plan.driftMs)})`
      );

      if (execute) {
        // State-guarded, so a row that moved on between the read and the write
        // (a retry, a delete) is skipped instead of re-dated.
        await prisma.post.updateMany({
          where: { id: { in: plan.rowIds }, state: 'PUBLISHED', deletedAt: null },
          data: { publishDate: plan.sentAt },
        });
      }
      repairedGroups++;
      repairedRows += plan.rowIds.length;
    }

    console.log(
      `── ${execute ? 'Applied' : 'Would apply'} ${repairedGroups} group(s) / ${repairedRows} row(s) ──`
    );
    for (const line of lines.slice(0, PREVIEW_LINES)) console.log('  ' + line);
    if (lines.length > PREVIEW_LINES) {
      console.log(`  … and ${lines.length - PREVIEW_LINES} more`);
    }

    console.log('\nDrift distribution (groups):');
    for (const b of DRIFT_BUCKETS) {
      if (buckets[b.label]) console.log(`  ${b.label.padEnd(8)} ${buckets[b.label]}`);
    }

    console.log('\nSkipped groups:');
    const reasons: Record<string, string> = {
      recurring: 'recurring — publishDate is the cycle clone identity',
      'no-evidence': 'no claimedAt on any row',
      'not-later': 'claimed at or before the intended time (already correct)',
      'below-min-drift': 'drift under --min-drift-minutes',
      'above-max-drift': 'drift over --max-drift-hours',
      'nothing-to-write': 'already carries the send time',
    };
    const skippedKeys = Object.keys(skipped);
    if (!skippedKeys.length) console.log('  (none)');
    for (const k of skippedKeys) {
      console.log(`  ${String(skipped[k]).padStart(5)}  ${reasons[k] ?? k}`);
    }

    if (!execute && repairedRows) {
      console.log('\nRe-run with --execute to write these changes.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Guarded so the spec can import the pure planning helpers above without
// running a repair — or opening a database connection — as an import side
// effect.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

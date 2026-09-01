/**
 * Backfill the Hacker News visibility flags (`dead` / `deleted`) onto every HN
 * Post row, using HN's public Firebase API.
 *
 * WHY THIS EXISTS
 * ---------------
 * The extension's HN metrics fetcher used to READ these flags and then throw
 * the row away (`if (item.deleted || item.dead) return null`), and the metrics
 * runner skips a null. So a comment HN had flagged into invisibility was
 * indistinguishable, everywhere downstream, from one nobody had measured yet:
 * PUBLISHED, with a link, just low numbers.
 *
 * That is not hypothetical. It hid a live account whose EVERY comment had been
 * flagged for forty days — caught only because an unrelated rate-limit error
 * happened to send someone to HN's /threads page by hand.
 *
 * The extension now emits `dead` / `deleted` on every fetch and
 * normalizeReplyMetrics reads them back as `metrics.visibility`. But that only
 * covers rows refreshed by an updated extension build, from now on. This script
 * is the one-off pass over everything already in the database, so the real
 * historical kill rate is visible immediately instead of a month from now.
 *
 * WHAT IT WRITES
 * --------------
 * The SAME four-series set the extension emits (score, comments, dead, deleted)
 * from one Firebase read, pushed through the SAME `extractMetrics` the ingest
 * endpoint uses. A backfilled row is therefore byte-identical in shape to one
 * the extension just refreshed — there is no half-updated state to reason about,
 * and the traffic weighting cannot drift from the live path because it IS the
 * live path.
 *
 *   Post.analytics          ← the four series (overwritten)
 *   Post.trafficScore       ← recomputed by extractMetrics
 *   Post.lastMetricsFetchAt ← stamped, so the interval gate holds afterwards
 *
 * `Post.impressions` is deliberately NOT written. HN publishes no impression
 * figure at all, so extractMetrics always yields 0 — and ingestMetrics only
 * overwrites impressions when positive, precisely so a platform that cannot
 * report them never clobbers a value another path set. This mirrors that rule.
 *
 * ROWS ARE SELECTED BY URL, NOT BY PLATFORM
 * -----------------------------------------
 * `releaseURL` contains news.ycombinator.com is the source of truth here.
 * Selecting on `providerIdentifier = 'hackernews'` would MISS the legacy rows
 * that createManualCommunityPost's predecessor wrote as `reddit` while pointing
 * at an HN url (see the note on that method) — exactly the oldest rows, i.e. the
 * ones most likely to be dead. Mislabelled rows are reported, never rewritten:
 * fixing the platform column is a different migration with different blast
 * radius, and silently doing it here would bury it.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-hackernews-visibility.ts
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-hackernews-visibility.ts --execute
 *
 * Dry run is the default and still performs every HN read — the report is the
 * point, and it is the same report either way.
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { PrismaClient } from '@prisma/client';
import { extractMetrics } from '@gitroom/nestjs-libraries/integrations/social/analytics.utils';
import { AnalyticsData } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';

const HN_ITEM_BASE = 'https://hacker-news.firebaseio.com/v0/item';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Concurrent Firebase reads. HN's API is a static CDN-fronted JSON dump with no
 * published rate limit, but this is somebody else's free infrastructure and the
 * backfill is not urgent — a low default is the polite setting, raisable when
 * the row count makes it worth it.
 */
const DEFAULT_CONCURRENCY = 4;

type Visibility = 'visible' | 'hidden' | 'removed' | 'missing' | 'unreadable';

interface CliArgs {
  orgId: string | null;
  since: string | null;
  limit: number | null;
  concurrency: number;
  dryRun: boolean;
}

interface Row {
  id: string;
  organizationId: string;
  providerIdentifier: string | null;
  releaseURL: string;
  content: string;
  publishDate: Date;
}

interface Outcome {
  row: Row;
  itemId: string;
  visibility: Visibility;
  score: number;
  comments: number;
  analytics: AnalyticsData[] | null;
  trafficScore: number | null;
}

function printHelp(): void {
  console.log(`
Usage: npx ts-node --project scripts/tsconfig.json scripts/backfill-hackernews-visibility.ts [options]

Optional:
  --org <id>            Limit to a single organization
  --since <YYYY-MM-DD>  Only posts published on/after this UTC day
  --limit <n>           Stop after n rows (newest first) — use for a trial run
  --concurrency <n>     Parallel HN reads (default ${DEFAULT_CONCURRENCY})
  --dry-run             Read HN and report, write nothing (default)
  --execute             Also persist analytics + trafficScore
  --help                Show this help message

Reads every Post whose releaseURL points at news.ycombinator.com, asks HN's
public Firebase API whether the item is dead (flagged/killed) or deleted, and
writes the flags into Post.analytics as the extension now does. Reports the
kill rate per organization either way.
`);
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let orgId: string | null = null;
  let since: string | null = null;
  let limit: number | null = null;
  let concurrency = DEFAULT_CONCURRENCY;
  let dryRun = true;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--org':
        orgId = args[++i] ?? null;
        break;
      case '--since':
        since = args[++i] ?? null;
        break;
      case '--limit':
        limit = Number(args[++i]);
        break;
      case '--concurrency':
        concurrency = Number(args[++i]);
        break;
      case '--execute':
        dryRun = false;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
      default:
        console.error(`Unknown argument: ${args[i]}`);
        printHelp();
        process.exit(1);
    }
  }

  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
    console.error('--limit must be a positive number.');
    process.exit(1);
  }
  if (!Number.isFinite(concurrency) || concurrency <= 0 || concurrency > 16) {
    console.error('--concurrency must be between 1 and 16.');
    process.exit(1);
  }
  return { orgId, since, limit, concurrency, dryRun };
}

/**
 * Parse the numeric item id out of an HN url. Mirrors the extension's
 * parseHackernewsItemId — kept as a local copy because scripts must not depend
 * on the extension package, and the rule is three lines of URL parsing.
 */
export function parseItemId(releaseURL: string): string | null {
  let u: URL;
  try {
    u = new URL(String(releaseURL || '').trim());
  } catch {
    return null;
  }
  if (!/(^|\.)ycombinator\.com$/i.test(u.hostname)) return null;
  const id = u.searchParams.get('id');
  return id && /^\d+$/.test(id) ? id : null;
}

function series(label: string, total: number, at: string): AnalyticsData {
  return { label, data: [{ total: String(total), date: at }], percentageChange: 0 };
}

async function readItem(itemId: string): Promise<any | null | undefined> {
  // undefined = the read itself failed (network/timeout/5xx) — a transient
  // condition that must NOT be recorded as a state of the item. null = HN
  // answered, authoritatively, that no such item exists.
  try {
    const res = await fetch(`${HN_ITEM_BASE}/${itemId}.json`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * The verdict for an item HN actually returned.
 *
 * `hidden` wins when BOTH flags are set, matching normalizeReplyMetrics: a
 * flagged item says something about the content whether or not it was later
 * deleted, and that is the half worth acting on. Real HN data does contain
 * such rows — a story can be killed and then removed by its author.
 */
export function classifyItem(item: {
  dead?: unknown;
  deleted?: unknown;
}): 'visible' | 'hidden' | 'removed' {
  if (item.dead === true) return 'hidden';
  if (item.deleted === true) return 'removed';
  return 'visible';
}

async function inspect(row: Row): Promise<Outcome | null> {
  const itemId = parseItemId(row.releaseURL);
  if (!itemId) return null;

  const item = await readItem(itemId);
  const empty: Omit<Outcome, 'visibility'> = {
    row,
    itemId,
    score: 0,
    comments: 0,
    analytics: null,
    trafficScore: null,
  };
  if (item === undefined) return { ...empty, visibility: 'unreadable' };
  // HN has no such item. That is a broken releaseURL on our side, not a verdict
  // on the content, so nothing is written — reporting `dead` here would blame
  // HN for our own bad link.
  if (item === null) return { ...empty, visibility: 'missing' };

  const dead = item.dead === true;
  const deleted = item.deleted === true;
  const score = typeof item.score === 'number' ? item.score : 0;
  const comments =
    typeof item.descendants === 'number' ? item.descendants : 0;

  const at = new Date().toISOString();
  const analytics = [
    series('score', score, at),
    series('comments', comments, at),
    series('dead', dead ? 1 : 0, at),
    series('deleted', deleted ? 1 : 0, at),
  ];
  // Through the live pipeline, so the weighting can never drift from ingest.
  const { trafficScore, rawMetrics } = extractMetrics('hackernews', analytics);

  return {
    row,
    itemId,
    visibility: classifyItem(item),
    score,
    comments,
    analytics: rawMetrics,
    trafficScore,
  };
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

function pct(part: number, whole: number): string {
  return whole ? `${((part / whole) * 100).toFixed(1)}%` : '—';
}

async function main(): Promise<void> {
  const args = parseArgs();
  const prisma = new PrismaClient();

  const where: any = {
    // The selector — see the header on why this is the url and not the platform.
    releaseURL: { contains: 'ycombinator.com' },
    deletedAt: null,
    ...(args.orgId ? { organizationId: args.orgId } : {}),
    ...(args.since
      ? { publishDate: { gte: new Date(`${args.since}T00:00:00.000Z`) } }
      : {}),
  };

  const rows = (await prisma.post.findMany({
    where,
    select: {
      id: true,
      organizationId: true,
      providerIdentifier: true,
      releaseURL: true,
      content: true,
      publishDate: true,
    },
    orderBy: { publishDate: 'desc' },
    ...(args.limit ? { take: args.limit } : {}),
  })) as Row[];

  console.log(`Hacker News rows matched: ${rows.length}`);
  if (!rows.length) {
    await prisma.$disconnect();
    return;
  }
  console.log(`Reading HN (concurrency ${args.concurrency})…\n`);

  const outcomes = (await mapPool(rows, args.concurrency, inspect)).filter(
    (o): o is Outcome => o !== null
  );
  const unparseable = rows.length - outcomes.length;

  const byVisibility = new Map<Visibility, Outcome[]>();
  for (const o of outcomes) {
    const list = byVisibility.get(o.visibility) ?? [];
    list.push(o);
    byVisibility.set(o.visibility, list);
  }
  const count = (v: Visibility) => byVisibility.get(v)?.length ?? 0;
  // The denominator is what HN actually gave a verdict on. Rows we could not
  // read, or that HN says do not exist, are not evidence either way and would
  // only dilute the rate they are being computed to expose.
  const judged = count('visible') + count('hidden') + count('removed');

  console.log('── Visibility ────────────────────────────────');
  console.log(`  visible     ${count('visible')}`);
  console.log(`  hidden      ${count('hidden')}   (flagged / killed by HN)`);
  console.log(`  removed     ${count('removed')}   (deleted by the author)`);
  console.log(`  missing     ${count('missing')}   (no such item — bad releaseURL)`);
  console.log(`  unreadable  ${count('unreadable')}   (HN read failed — retry these)`);
  if (unparseable) console.log(`  unparseable ${unparseable}   (releaseURL carries no item id)`);
  console.log(`\n  KILL RATE   ${pct(count('hidden'), judged)}  (${count('hidden')}/${judged} judged)`);

  // Per-org, because a single bad account is the shape this failure actually
  // takes — an org-wide average would average it away.
  const orgs = new Map<string, { judged: number; hidden: number }>();
  for (const o of outcomes) {
    if (!['visible', 'hidden', 'removed'].includes(o.visibility)) continue;
    const acc = orgs.get(o.row.organizationId) ?? { judged: 0, hidden: 0 };
    acc.judged++;
    if (o.visibility === 'hidden') acc.hidden++;
    orgs.set(o.row.organizationId, acc);
  }
  if (orgs.size > 1) {
    console.log('\n── Kill rate by organization ─────────────────');
    for (const [org, acc] of [...orgs].sort(
      (a, b) => b[1].hidden / b[1].judged - a[1].hidden / a[1].judged
    )) {
      console.log(`  ${org}  ${pct(acc.hidden, acc.judged)}  (${acc.hidden}/${acc.judged})`);
    }
  }

  const hidden = byVisibility.get('hidden') ?? [];
  if (hidden.length) {
    console.log('\n── Hidden replies ────────────────────────────');
    for (const o of hidden) {
      const when = o.row.publishDate.toISOString().slice(0, 10);
      console.log(`  ${when}  ${o.row.releaseURL}`);
      console.log(`            ${o.row.content.replace(/\s+/g, ' ').slice(0, 90)}…`);
    }
  }

  // Surfaced, never repaired — see the header. These rows are backfilled like
  // any other; only their platform column is wrong.
  const mislabelled = outcomes.filter(
    (o) => o.row.providerIdentifier !== 'hackernews'
  );
  if (mislabelled.length) {
    console.log(
      `\n⚠ ${mislabelled.length} row(s) point at HN but carry providerIdentifier=` +
        `${[...new Set(mislabelled.map((o) => o.row.providerIdentifier ?? 'null'))].join('/')}` +
        ` — legacy mislabel, NOT fixed by this script.`
    );
  }

  const writable = outcomes.filter((o) => o.analytics !== null);
  console.log(`\nRows with something to write: ${writable.length}`);
  if (args.dryRun) {
    console.log('(dry run — pass --execute to write)');
    await prisma.$disconnect();
    return;
  }

  const lastMetricsFetchAt = new Date();
  let written = 0;
  for (const o of writable) {
    await prisma.post.update({
      where: { id: o.row.id },
      data: {
        analytics: o.analytics as any,
        ...(o.trafficScore !== null ? { trafficScore: o.trafficScore } : {}),
        // Stamped so the interval gate holds afterwards and the metrics runner
        // does not immediately re-fetch everything this script just read.
        lastMetricsFetchAt,
      },
    });
    written++;
  }
  console.log(`Executed writes: ${written}`);

  await prisma.$disconnect();
}

// Guarded so the spec can import the pure helpers above without running a
// backfill as a side effect of the import.
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

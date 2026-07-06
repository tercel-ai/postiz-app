/**
 * Backfill EngageOpportunity.postPublishedAt for rows whose publish time was
 * fabricated as the SCAN moment (the old X-parser `new Date()` fallback / the
 * Reddit `created_utc || 0` fallback). Those rows have postPublishedAt ≈ createdAt
 * (server insert time) instead of the post's REAL publish time.
 *
 * The fix re-fetches the real publish time from the platform and rewrites
 * postPublishedAt:
 *   - Reddit → GET {externalPostUrl}.json (loid + tiered proxy via redditPublicGet)
 *              → data.children[0].data.created_utc
 *   - X      → app-only bearer GET /2/tweets?ids=…&tweet.fields=created_at
 *
 * Read-only (dry-run) by DEFAULT. Pass --execute to write.
 *
 * Which rows are considered "suspect": createdAt >= --since AND
 * |createdAt - postPublishedAt| <= --threshold-seconds (the fabrication signature —
 * publish time within a few minutes of insert). Use --all to re-check every row
 * since the date regardless of the gap. A row is only updated when the fetched
 * real time differs from the stored value by more than 60s; unreachable/deleted
 * posts are left untouched.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-publishdate.ts
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-publishdate.ts --since 2026-06-22
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-publishdate.ts --platform reddit --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-publishdate.ts --all --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-publishdate.ts --threshold-seconds 600 --limit 500
 */
import * as dotenv from 'dotenv';
dotenv.config();

process.env.TZ = 'UTC';

import { PrismaClient } from '@prisma/client';
import { TwitterApi } from 'twitter-api-v2';
import { redditPublicGet } from '@gitroom/nestjs-libraries/engage/reddit-loid';

const DEFAULT_SINCE = '2026-06-30';
const DEFAULT_THRESHOLD_SECONDS = 300; // suspect gap: publish within 5m of insert
const UPDATE_MIN_DELTA_MS = 60_000; // only rewrite when real differs by > 60s
const X_BATCH = 100;
const REDDIT_DELAY_MS = 350; // polite spacing between Reddit fetches

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fmt(d: Date): string {
  return d.toISOString();
}
function deltaHuman(ms: number): string {
  const s = Math.round(ms / 1000);
  if (Math.abs(s) < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (Math.abs(m) < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (Math.abs(h) < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

interface Row {
  id: string;
  platform: string;
  externalPostId: string;
  externalPostUrl: string;
  postPublishedAt: Date;
  createdAt: Date;
}

// ─── Reddit: real created_utc by post URL ─────────────────────────────────────
async function fetchRedditPublishedAt(url: string): Promise<Date | null> {
  const jsonUrl = url.replace(/\/$/, '') + '.json?limit=1';
  try {
    const res = await redditPublicGet(jsonUrl);
    if (!res.ok) return null;
    const parsed = JSON.parse(await res.text());
    const data = Array.isArray(parsed)
      ? parsed[0]?.data?.children?.[0]?.data
      : parsed?.data?.children?.[0]?.data;
    const sec = Number(data?.created_utc);
    return Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000) : null;
  } catch {
    return null;
  }
}

// ─── X: real created_at by tweet id (batched, app-only) ───────────────────────
async function buildXClient(): Promise<TwitterApi | null> {
  const bearer = process.env.X_BEARER_TOKEN;
  if (bearer) return new TwitterApi(bearer);
  const appKey = process.env.X_API_KEY;
  const appSecret = process.env.X_API_SECRET;
  if (!appKey || !appSecret) return null;
  return new TwitterApi({ appKey, appSecret }).appLogin();
}

async function fetchXPublishedAt(
  client: TwitterApi,
  ids: string[]
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  for (let i = 0; i < ids.length; i += X_BATCH) {
    const batch = ids.slice(i, i + X_BATCH);
    try {
      const resp = await client.v2.tweets(batch, {
        'tweet.fields': ['created_at'],
      });
      for (const t of resp.data ?? []) {
        if (t.created_at) out.set(t.id, new Date(t.created_at));
      }
    } catch (e) {
      console.warn(
        `[x] batch ${i / X_BATCH} failed (${batch.length} ids): ${
          e instanceof Error ? e.message : e
        }`
      );
    }
  }
  return out;
}

async function main() {
  const sinceStr = arg('since') ?? DEFAULT_SINCE;
  const since = new Date(`${sinceStr}T00:00:00.000Z`);
  if (Number.isNaN(since.getTime())) {
    console.error(`Invalid --since "${sinceStr}" (expected YYYY-MM-DD)`);
    process.exit(1);
  }
  const platform = arg('platform'); // 'x' | 'reddit' | undefined (both)
  const thresholdMs = (Number(arg('threshold-seconds')) || DEFAULT_THRESHOLD_SECONDS) * 1000;
  const all = flag('all');
  const execute = flag('execute');
  const limit = Number(arg('limit')) || undefined;

  console.log(
    `Backfill postPublishedAt | since=${fmt(since)} platform=${platform ?? 'all'} ` +
      `mode=${all ? 'ALL rows' : `suspect (gap<=${thresholdMs / 1000}s)`} ` +
      `${execute ? 'EXECUTE (writes)' : 'DRY-RUN'}${limit ? ` limit=${limit}` : ''}`
  );

  const rows = (await prisma.engageOpportunity.findMany({
    where: {
      deletedAt: null,
      createdAt: { gte: since },
      ...(platform ? { platform } : {}),
    },
    select: {
      id: true,
      platform: true,
      externalPostId: true,
      externalPostUrl: true,
      postPublishedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
    ...(limit ? { take: limit } : {}),
  })) as Row[];

  const candidates = all
    ? rows
    : rows.filter(
        (r) =>
          Math.abs(r.createdAt.getTime() - r.postPublishedAt.getTime()) <= thresholdMs
      );

  console.log(
    `Scanned ${rows.length} rows since ${sinceStr}; ${candidates.length} candidate(s) to re-check.\n`
  );
  if (!candidates.length) {
    console.log('Nothing to do.');
    return;
  }

  // Resolve real publish times per platform.
  const realById = new Map<string, Date>(); // opportunity id → real publish time

  const xRows = candidates.filter((r) => r.platform === 'x');
  const redditRows = candidates.filter((r) => r.platform === 'reddit');

  if (xRows.length) {
    const client = await buildXClient();
    if (!client) {
      console.warn(
        '[x] No X credentials (X_BEARER_TOKEN or X_API_KEY/X_API_SECRET) — skipping X rows.'
      );
    } else {
      console.log(`[x] fetching created_at for ${xRows.length} tweet(s)…`);
      const byTweet = await fetchXPublishedAt(
        client,
        xRows.map((r) => r.externalPostId)
      );
      for (const r of xRows) {
        const real = byTweet.get(r.externalPostId);
        if (real) realById.set(r.id, real);
      }
    }
  }

  if (redditRows.length) {
    console.log(`[reddit] fetching created_utc for ${redditRows.length} post(s)…`);
    let i = 0;
    for (const r of redditRows) {
      const real = await fetchRedditPublishedAt(r.externalPostUrl);
      if (real) realById.set(r.id, real);
      if (++i % 25 === 0) console.log(`[reddit] ${i}/${redditRows.length}`);
      await sleep(REDDIT_DELAY_MS);
    }
  }

  // Decide + apply updates.
  let updated = 0;
  let unchanged = 0;
  let unreachable = 0;
  const changes: string[] = [];

  for (const r of candidates) {
    const real = realById.get(r.id);
    if (!real) {
      unreachable++;
      continue;
    }
    const delta = Math.abs(real.getTime() - r.postPublishedAt.getTime());
    if (delta <= UPDATE_MIN_DELTA_MS) {
      unchanged++;
      continue;
    }
    changes.push(
      `[${r.platform}] ${r.id} ${fmt(r.postPublishedAt)} → ${fmt(real)} ` +
        `(moved ${deltaHuman(real.getTime() - r.postPublishedAt.getTime())})`
    );
    if (execute) {
      await prisma.engageOpportunity.update({
        where: { id: r.id },
        data: { postPublishedAt: real },
      });
    }
    updated++;
  }

  console.log(`\n── ${execute ? 'Applied' : 'Would apply'} ${updated} update(s) ──`);
  for (const line of changes.slice(0, 50)) console.log('  ' + line);
  if (changes.length > 50) console.log(`  … and ${changes.length - 50} more`);

  console.log(
    `\nSummary: candidates=${candidates.length} | ${
      execute ? 'updated' : 'would-update'
    }=${updated} | already-correct=${unchanged} | unreachable(deleted/blocked)=${unreachable}`
  );
  if (!execute && updated) console.log('Re-run with --execute to write these changes.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

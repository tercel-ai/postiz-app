/**
 * Backfill EngageOpportunity.postContent (and, where genuinely missing, the
 * rawData snapshot) for X rows whose body was stored TRUNCATED.
 *
 * Background — for tweets longer than 280 weighted chars the Twitter v2 API
 * returns a clipped `text` (trailing a t.co link) and puts the real body in
 * `note_tweet.text`. XScanAdapter.toRawPost used `tweet.text`, so postContent was
 * persisted truncated. The adapter fix (postContent: tweet.note_tweet?.text ??
 * tweet.text) is FORWARD-ONLY; existing rows stay truncated until repaired.
 *
 * Two eras of rows (note_tweet entered tweet.fields on 2026-06-26):
 *   - Scanned ON/AFTER 2026-06-26 → rawData.tweet.note_tweet.text ALREADY holds the
 *     full body (the adapter stores the whole tweet verbatim). postContent is
 *     repaired straight from rawData — FREE, no X API call, no drift. The clipped
 *     rawData.tweet.text is the faithful API value and is left untouched.
 *   - Scanned BEFORE 2026-06-26 → note_tweet was never requested, so rawData.tweet
 *     lacks it and the full body lives nowhere locally. These fall back to an
 *     app-only X re-fetch; the fetched note_tweet is injected into rawData.tweet so
 *     the snapshot becomes consistent, and postContent is rewritten.
 *
 * Extension-ingested X rows carry rawData=null and an already-complete postContent,
 * so they are effectively no-ops (nothing to repair, nothing to inject).
 *
 * X-only: note_tweet truncation is a Twitter-specific shape. Reddit is ignored.
 * Read-only (dry-run) by DEFAULT. Pass --execute to write.
 *
 * Suspect rows: platform='x' AND createdAt >= --since AND postContent ends in a
 * bare t.co link (the truncation fingerprint). --all re-checks every X row since
 * the date. --no-api skips the re-fetch fallback (only the free rawData repairs).
 * A row updates only when the recovered full body is non-empty AND differs from
 * the stored value; unreachable/deleted tweets are left untouched.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-content.ts
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-content.ts --since 2026-06-22
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-content.ts --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-content.ts --no-api          # free repairs only
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-content.ts --all --limit 500
 */
import * as dotenv from 'dotenv';
dotenv.config();

process.env.TZ = 'UTC';

import { PrismaClient, Prisma } from '@prisma/client';
import { TwitterApi } from 'twitter-api-v2';

const DEFAULT_SINCE = '2026-06-30';
const X_BATCH = 100;

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
/** One-line preview of a possibly-multiline body. */
function preview(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

// A stored body that ends in a bare t.co link is the truncation fingerprint: the
// v2 API clips a >280-char note tweet and trails the media/quote t.co. Short
// tweets that merely end in a link are also caught, but the recovered body then
// equals postContent → no update.
const TRUNCATED_SUFFIX = /https:\/\/t\.co\/\w+\s*$/;

interface Row {
  id: string;
  externalPostId: string;
  postContent: string;
  rawData: Prisma.JsonValue | null;
}

/** Full body already present in the stored snapshot, or null. */
function rawNoteText(rawData: Prisma.JsonValue | null): string | null {
  const t = (rawData as any)?.tweet?.note_tweet?.text;
  return typeof t === 'string' && t.length ? t : null;
}

// ─── X: whole tweet (text + note_tweet) by id, batched, app-only ──────────────
async function buildXClient(): Promise<TwitterApi | null> {
  const bearer = process.env.X_BEARER_TOKEN;
  if (bearer) return new TwitterApi(bearer);
  const appKey = process.env.X_API_KEY;
  const appSecret = process.env.X_API_SECRET;
  if (!appKey || !appSecret) return null;
  return new TwitterApi({ appKey, appSecret }).appLogin();
}

async function fetchXTweets(
  client: TwitterApi,
  ids: string[]
): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  for (let i = 0; i < ids.length; i += X_BATCH) {
    const batch = ids.slice(i, i + X_BATCH);
    try {
      const resp = await client.v2.tweets(batch, {
        'tweet.fields': ['note_tweet', 'text'] as any,
      });
      for (const t of resp.data ?? []) out.set(t.id, t);
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

interface Plan {
  row: Row;
  contentTo: string; // new full body
  rawTo?: Prisma.InputJsonValue; // set only when injecting note_tweet into rawData
  source: 'raw' | 'api';
}

async function main() {
  const sinceStr = arg('since') ?? DEFAULT_SINCE;
  const since = new Date(`${sinceStr}T00:00:00.000Z`);
  if (Number.isNaN(since.getTime())) {
    console.error(`Invalid --since "${sinceStr}" (expected YYYY-MM-DD)`);
    process.exit(1);
  }
  const all = flag('all');
  const execute = flag('execute');
  const noApi = flag('no-api');
  const limit = Number(arg('limit')) || undefined;

  console.log(
    `Backfill postContent + rawData (X) | since=${sinceStr} ` +
      `mode=${all ? 'ALL x rows' : 'suspect (ends in t.co link)'} ` +
      `api-fallback=${noApi ? 'OFF' : 'ON'} ` +
      `${execute ? 'EXECUTE (writes)' : 'DRY-RUN'}${limit ? ` limit=${limit}` : ''}`
  );

  const rows = (await prisma.engageOpportunity.findMany({
    where: { deletedAt: null, platform: 'x', createdAt: { gte: since } },
    select: { id: true, externalPostId: true, postContent: true, rawData: true },
    orderBy: { createdAt: 'asc' },
    ...(limit ? { take: limit } : {}),
  })) as Row[];

  const candidates = all
    ? rows
    : rows.filter((r) => TRUNCATED_SUFFIX.test(r.postContent));

  console.log(
    `Scanned ${rows.length} X rows since ${sinceStr}; ${candidates.length} candidate(s) to re-check.\n`
  );
  if (!candidates.length) {
    console.log('Nothing to do.');
    return;
  }

  const plans: Plan[] = [];
  let alreadyFull = 0;
  const needApi: Row[] = [];

  // Pass 1 — repair from the stored snapshot (free).
  for (const r of candidates) {
    const fromRaw = rawNoteText(r.rawData);
    if (fromRaw == null) {
      needApi.push(r); // rawData lacks note_tweet (pre-06-26) or rawData is null
      continue;
    }
    if (fromRaw.trim() === r.postContent.trim()) alreadyFull++;
    else plans.push({ row: r, contentTo: fromRaw, source: 'raw' });
  }

  // Pass 2 — re-fetch the rows whose snapshot has no note_tweet, and inject it.
  let unreachable = 0;
  if (needApi.length && !noApi) {
    const client = await buildXClient();
    if (!client) {
      console.warn(
        `[x] ${needApi.length} row(s) need a re-fetch but no X credentials ` +
          `(X_BEARER_TOKEN or X_API_KEY/X_API_SECRET) — left untouched.`
      );
      unreachable += needApi.length;
    } else {
      console.log(`[x] re-fetching ${needApi.length} tweet(s) missing note_tweet…`);
      const byId = await fetchXTweets(
        client,
        needApi.map((r) => r.externalPostId)
      );
      for (const r of needApi) {
        const t = byId.get(r.externalPostId);
        const full: string | undefined = t?.note_tweet?.text ?? t?.text;
        if (!t || typeof full !== 'string' || !full.length) {
          unreachable++;
          continue;
        }
        // Inject note_tweet into rawData.tweet ONLY when a tweet snapshot exists
        // but lacks it (pre-06-26 adapter rows). Never fabricate a snapshot for
        // rawData=null (extension rows) — leave those null.
        let rawTo: Prisma.InputJsonValue | undefined;
        const rawTweet = (r.rawData as any)?.tweet;
        if (rawTweet && !rawTweet.note_tweet && t.note_tweet) {
          const clone = JSON.parse(JSON.stringify(r.rawData));
          clone.tweet.note_tweet = t.note_tweet; // { text, entities? } — v2 shape
          rawTo = clone as Prisma.InputJsonValue;
        }
        const contentChanged = full.trim() !== r.postContent.trim();
        if (!contentChanged && !rawTo) {
          alreadyFull++;
          continue;
        }
        plans.push({
          row: r,
          contentTo: contentChanged ? full : r.postContent,
          rawTo,
          source: 'api',
        });
      }
    }
  } else if (needApi.length && noApi) {
    console.log(`[x] --no-api: skipping ${needApi.length} row(s) that need a re-fetch.`);
    unreachable += needApi.length;
  }

  // Apply.
  let fromRawN = 0;
  let fromApiN = 0;
  let rawPatchedN = 0;
  const lines: string[] = [];

  for (const p of plans) {
    const r = p.row;
    const data: Prisma.EngageOpportunityUpdateInput = {};
    if (p.contentTo.trim() !== r.postContent.trim()) data.postContent = p.contentTo;
    if (p.rawTo !== undefined) {
      data.rawData = p.rawTo;
      rawPatchedN++;
    }
    if (Object.keys(data).length === 0) continue;

    if (p.source === 'raw') fromRawN++;
    else fromApiN++;

    lines.push(
      `[${p.source}] ${r.id} (${r.externalPostId}) ${r.postContent.length}→${p.contentTo.length} chars` +
        (p.rawTo !== undefined ? ' +note_tweet→rawData' : '') +
        `\n      old: ${preview(r.postContent)}\n      new: ${preview(p.contentTo)}`
    );
    if (execute) {
      await prisma.engageOpportunity.update({ where: { id: r.id }, data });
    }
  }

  const total = fromRawN + fromApiN;
  console.log(`\n── ${execute ? 'Applied' : 'Would apply'} ${total} update(s) ──`);
  for (const line of lines.slice(0, 50)) console.log('  ' + line);
  if (lines.length > 50) console.log(`  … and ${lines.length - 50} more`);

  console.log(
    `\nSummary: candidates=${candidates.length} | ` +
      `${execute ? 'updated' : 'would-update'}=${total} ` +
      `(from-rawData=${fromRawN} free, from-api=${fromApiN}, rawData-patched=${rawPatchedN}) | ` +
      `already-full=${alreadyFull} | unreachable(deleted/blocked/no-creds/--no-api)=${unreachable}`
  );
  if (!execute && total) console.log('Re-run with --execute to write these changes.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

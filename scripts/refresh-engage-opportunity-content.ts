/**
 * Re-fetch an EngageOpportunity's body from X and re-store it NORMALISED, for
 * repairing rows whose postContent still holds X's wire format — `t.co`
 * shortlinks instead of the real links, an attachment placeholder instead of
 * nothing, HTML-escaped `&`/`<`/`>`.
 *
 * Both scan paths normalise on ingest now, and X/LinkedIn rows are refreshed
 * whenever the same post is scanned again. This script exists for the rows in
 * between: a post nobody will scan a second time, or one you want fixed now.
 *
 * Read-only (dry-run) by DEFAULT. Pass --execute to write.
 *
 * Normalisation reuses the scanner's own `expandXTweetText`, so a repaired row
 * is byte-identical to what a fresh scan would have stored — this script must
 * never grow its own copy of that logic.
 *
 * Targeting (at least one required, combinable):
 *   --opportunity <id[,id]>  EngageOpportunity.id (cuid)
 *   --url <url[,url]>        externalPostUrl, an X status URL, or a bare tweet id
 *   --scan                   every X row whose postContent still contains a t.co
 *                            link (honours --limit, default 50)
 *
 * Usage:
 *   # see what is still broken, touching nothing
 *   npx ts-node --project scripts/tsconfig.json scripts/refresh-engage-opportunity-content.ts --scan
 *
 *   # repair one row found in the admin UI (GET /admin/engage/sent?externalPostUrl=…)
 *   npx ts-node --project scripts/tsconfig.json scripts/refresh-engage-opportunity-content.ts \
 *     --url https://x.com/alex/status/2090431343046095255 --execute
 *
 *   npx ts-node --project scripts/tsconfig.json scripts/refresh-engage-opportunity-content.ts \
 *     --opportunity clx123abc,clx456def --execute
 *
 *   # repair the whole backlog
 *   npx ts-node --project scripts/tsconfig.json scripts/refresh-engage-opportunity-content.ts \
 *     --scan --limit 500 --execute
 *
 * Requires in .env: DATABASE_URL, and X_BEARER_TOKEN (or X_API_KEY + X_API_SECRET).
 */
import * as dotenv from 'dotenv';
dotenv.config();

process.env.TZ = 'UTC';

import { PrismaClient, Prisma } from '@prisma/client';
import { TwitterApi } from 'twitter-api-v2';
import { expandXTweetText } from '@gitroom/nestjs-libraries/engage/scan/x-scan-adapter';

const X_BATCH = 100;
const DEFAULT_SCAN_LIMIT = 50;

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function list(raw: string | undefined): string[] {
  return raw
    ? Array.from(new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)))
    : [];
}
/** One-line preview of a possibly-multiline body. */
function preview(s: string, max = 100): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
/** Numeric tweet id from a raw id or any X status URL. */
function extractTweetId(input: string): string {
  const s = String(input || '').trim();
  const m = s.match(/status(?:es)?\/(\d+)/) || s.match(/^(\d{6,})$/);
  return m ? m[1] : '';
}

interface Row {
  id: string;
  externalPostId: string;
  externalPostUrl: string;
  postContent: string;
  rawData: Prisma.JsonValue | null;
}

const ROW_SELECT = {
  id: true,
  externalPostId: true,
  externalPostUrl: true,
  postContent: true,
  rawData: true,
} as const;

async function buildXClient(): Promise<TwitterApi | null> {
  const bearer = process.env.X_BEARER_TOKEN;
  if (bearer) return new TwitterApi(bearer);
  const appKey = process.env.X_API_KEY;
  const appSecret = process.env.X_API_SECRET;
  if (!appKey || !appSecret) return null;
  return new TwitterApi({ appKey, appSecret }).appLogin();
}

/**
 * Whole tweets by id, with everything normalisation needs: `entities` carries
 * each t.co's destination, `note_tweet` the untruncated body of a long tweet,
 * and the media expansion the attachment URLs the body no longer mentions.
 */
async function fetchXTweets(
  client: TwitterApi,
  ids: string[]
): Promise<Map<string, { tweet: any; media: Map<string, any> }>> {
  const out = new Map<string, { tweet: any; media: Map<string, any> }>();
  for (let i = 0; i < ids.length; i += X_BATCH) {
    const batch = ids.slice(i, i + X_BATCH);
    try {
      const resp = await client.v2.tweets(batch, {
        'tweet.fields': ['text', 'entities', 'note_tweet', 'attachments'] as any,
        expansions: ['attachments.media_keys'] as any,
        'media.fields': ['url', 'variants', 'type'] as any,
      });
      const mediaByKey = new Map<string, any>();
      for (const m of (resp.includes as any)?.media ?? []) {
        if (m?.media_key) mediaByKey.set(m.media_key, m);
      }
      for (const t of resp.data ?? []) out.set(t.id, { tweet: t, media: mediaByKey });
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

/**
 * Attachment URLs for one tweet: the photo's `url`, or the highest-bitrate MP4
 * for a video/GIF. Mirrors what the extension archives on rawData.mediaUrls.
 */
function mediaUrlsFor(tweet: any, mediaByKey: Map<string, any>): string[] {
  const keys: string[] = tweet?.attachments?.media_keys ?? [];
  const urls: string[] = [];
  for (const key of keys) {
    const m = mediaByKey.get(key);
    if (!m) continue;
    if (m.type === 'video' || m.type === 'animated_gif') {
      const best = (m.variants ?? [])
        .filter(
          (v: any) => v?.content_type === 'video/mp4' && typeof v?.url === 'string'
        )
        .sort(
          (a: any, b: any) => (Number(b?.bit_rate) || 0) - (Number(a?.bit_rate) || 0)
        )[0]?.url;
      if (best) urls.push(best);
      continue;
    }
    if (typeof m.url === 'string' && m.url) urls.push(m.url);
  }
  return Array.from(new Set(urls));
}

/**
 * rawData with mediaUrls set, preserving every other key. A server-side scan
 * archives the whole tweet payload in there; repairing the body must not throw
 * that away.
 */
function mergeRawData(
  current: Prisma.JsonValue | null,
  mediaUrls: string[]
): Prisma.InputJsonValue {
  const base =
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  return { ...base, mediaUrls } as Prisma.InputJsonValue;
}

interface Plan {
  row: Row;
  contentTo: string;
  mediaUrls: string[];
  contentChanged: boolean;
  mediaChanged: boolean;
}

async function resolveRows(): Promise<Row[]> {
  const byId = list(arg('opportunity'));
  const byUrl = list(arg('url'));
  const scan = flag('scan');

  const rows = new Map<string, Row>();

  if (byId.length) {
    const found = await prisma.engageOpportunity.findMany({
      where: { id: { in: byId } },
      select: ROW_SELECT,
    });
    for (const r of found) rows.set(r.id, r);
    for (const missing of byId.filter((id) => !rows.has(id))) {
      console.warn(`[skip] no EngageOpportunity with id ${missing}`);
    }
  }

  if (byUrl.length) {
    // Accept a full URL, an X status URL in any host form, or a bare id: match
    // on the tweet id where we can read one, else on the URL as a substring.
    for (const raw of byUrl) {
      const tweetId = extractTweetId(raw);
      const found = await prisma.engageOpportunity.findMany({
        where: tweetId
          ? { platform: 'x', externalPostId: tweetId }
          : { externalPostUrl: { contains: raw, mode: 'insensitive' } },
        select: ROW_SELECT,
      });
      if (!found.length) console.warn(`[skip] no EngageOpportunity matching ${raw}`);
      for (const r of found) rows.set(r.id, r);
    }
  }

  if (scan) {
    const limit = Number(arg('limit') ?? DEFAULT_SCAN_LIMIT);
    const found = await prisma.engageOpportunity.findMany({
      where: { platform: 'x', postContent: { contains: 'https://t.co/' } },
      select: ROW_SELECT,
      orderBy: { postPublishedAt: 'desc' },
      take: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_SCAN_LIMIT,
    });
    for (const r of found) rows.set(r.id, r);
  }

  return Array.from(rows.values());
}

async function main() {
  const execute = flag('execute');

  if (!flag('scan') && !arg('opportunity') && !arg('url')) {
    console.error(
      'Nothing targeted. Pass --opportunity <id>, --url <url>, or --scan (see the header for examples).'
    );
    process.exit(1);
  }

  const rows = await resolveRows();
  if (!rows.length) {
    console.log('No matching rows.');
    return;
  }

  const nonX = rows.filter((r) => !/^\d+$/.test(r.externalPostId));
  if (nonX.length) {
    console.warn(
      `[skip] ${nonX.length} row(s) without a numeric X status id — this script only repairs X.`
    );
  }
  const targets = rows.filter((r) => /^\d+$/.test(r.externalPostId));
  if (!targets.length) {
    console.log('No X rows to repair.');
    return;
  }

  const client = await buildXClient();
  if (!client) {
    console.error(
      'No X credentials. Set X_BEARER_TOKEN (or X_API_KEY + X_API_SECRET) in .env.'
    );
    process.exit(1);
  }

  console.log(
    `${execute ? 'EXECUTE' : 'DRY-RUN'} · ${targets.length} row(s) · re-fetching from X…`
  );

  const fetched = await fetchXTweets(
    client,
    targets.map((r) => r.externalPostId)
  );

  const plans: Plan[] = [];
  for (const row of targets) {
    const hit = fetched.get(row.externalPostId);
    if (!hit) {
      // Deleted, protected, or suspended — leave the stored copy alone.
      console.warn(`[skip] ${row.externalPostId} not retrievable from X`);
      continue;
    }
    const { tweet, media } = hit;
    const body = tweet.note_tweet?.text ?? tweet.text ?? '';
    const contentTo = expandXTweetText(
      body,
      tweet.entities,
      tweet.note_tweet?.entities
    );
    const mediaUrls = mediaUrlsFor(tweet, media);
    const currentMedia = ((row.rawData as any)?.mediaUrls ?? []) as unknown[];

    const contentChanged = !!contentTo && contentTo !== row.postContent;
    const mediaChanged =
      mediaUrls.length > 0 &&
      JSON.stringify(mediaUrls) !== JSON.stringify(currentMedia);

    if (!contentChanged && !mediaChanged) continue;
    plans.push({ row, contentTo, mediaUrls, contentChanged, mediaChanged });
  }

  if (!plans.length) {
    console.log('Nothing to change — every targeted row is already normalised.');
    return;
  }

  for (const p of plans) {
    console.log(`\n${p.row.externalPostUrl}  (opportunity ${p.row.id})`);
    if (p.contentChanged) {
      console.log(`  - ${preview(p.row.postContent)}`);
      console.log(`  + ${preview(p.contentTo)}`);
    }
    if (p.mediaChanged) {
      console.log(`  mediaUrls → ${p.mediaUrls.join(', ')}`);
    }
  }

  if (!execute) {
    console.log(
      `\n${plans.length} row(s) would change. Re-run with --execute to write.`
    );
    return;
  }

  let written = 0;
  for (const p of plans) {
    await prisma.engageOpportunity.update({
      where: { id: p.row.id },
      data: {
        ...(p.contentChanged ? { postContent: p.contentTo } : {}),
        ...(p.mediaChanged
          ? { rawData: mergeRawData(p.row.rawData, p.mediaUrls) }
          : {}),
      },
    });
    written++;
  }
  console.log(`\nUpdated ${written} row(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

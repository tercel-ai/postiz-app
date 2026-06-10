/**
 * Engage — Reddit author lookup diagnostic (the "fill reply URL → query user info" path).
 *
 * When a user backfills a Reddit reply URL, the service calls
 * fetchRedditAuthorProfile() (engage-author.ts), which makes TWO sequential
 * Reddit requests:
 *   1. /api/info?id=t1_<commentId>   → the reply comment's `author` (the handle)
 *   2. /user/<author>/about          → avatar + display name (ENRICHMENT only)
 *
 * Step 2 is the slow, optional one: it never changes the handle, only adds
 * id/name/avatar, and degrades to handle-only on failure. This script answers
 * "can we actually retrieve user info, and how slow is each step?" so you can
 * decide whether the /about call is worth keeping.
 *
 * No DB / no NestJS — it hits the raw Reddit interface using the SAME primitives
 * the production code uses (OAuth token when REDDIT_CLIENT_ID/SECRET are set,
 * else the public loid/WAF path).
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-reddit-author.ts --url <redditCommentUrl>
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-reddit-author.ts --url <url> --raw   # dump full /about body
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { hostname } from 'os';
import { fetchRedditAuthorProfile } from '@gitroom/nestjs-libraries/engage/engage-author';
import { parseRedditCommentId } from '@gitroom/nestjs-libraries/engage/reddit-url';
import { getRedditToken, redditAuthHeaders } from '@gitroom/nestjs-libraries/engage/reddit-auth';
import { redditPublicGet, getRedditLoidCookie } from '@gitroom/nestjs-libraries/engage/reddit-loid';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

interface CliArgs {
  url: string;
  raw: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let url: string | null = null;
  let raw = false;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url':
        url = args[++i] ?? null;
        if (!url) { console.error('--url requires a value'); process.exit(1); }
        break;
      case '--raw':
        raw = true;
        break;
      case '--help':
        console.log('Usage: engage-reddit-author.ts --url <redditCommentUrl> [--raw]');
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }
  if (!url) { console.error('Specify --url <redditCommentUrl>'); process.exit(1); }
  return { url, raw };
}

/** Same dual-path GET as engage-author.ts::redditGet, but timed + status-reported. */
async function timedGet(
  oauthUrl: string,
  publicUrl: string,
  token: string | null
): Promise<{ ok: boolean; status: number; body: string; ms: number; via: string }> {
  const t0 = Date.now();
  if (token) {
    try {
      const r = await fetch(oauthUrl, { headers: redditAuthHeaders(token) });
      const body = await r.text();
      if (r.ok) return { ok: true, status: r.status, body, ms: Date.now() - t0, via: 'OAuth' };
      console.log(`    OAuth → HTTP ${r.status}; falling back to public JSON`);
    } catch (err) {
      console.log(`    OAuth → ERROR ${(err as Error).message}; falling back to public JSON`);
    }
  }
  try {
    const r = await redditPublicGet(publicUrl, {}, { log: (m) => console.log(`    ${m}`) });
    const body = await r.text();
    return { ok: r.ok, status: r.status, body, ms: Date.now() - t0, via: 'public/loid' };
  } catch (err) {
    return { ok: false, status: 0, body: String((err as Error).message), ms: Date.now() - t0, via: 'public/loid' };
  }
}

async function main(): Promise<void> {
  const { url, raw } = parseArgs();
  const commentId = parseRedditCommentId(url);

  console.log('=== Engage Reddit author lookup diagnostic ===\n');
  console.log(`  url       = ${url}`);
  console.log(`  commentId = ${commentId ?? 'NULL (not a comment permalink — fetchRedditAuthorProfile returns null immediately)'}`);
  if (!commentId) { console.log('\n  ⚠ No comment id → nothing to query. Done.'); return; }

  const token = await getRedditToken();
  console.log(`  redditToken = ${token ? 'present (OAuth, no WAF)' : 'NONE (public loid/WAF path — uses loid L1/L2 cache)'}\n`);

  // ---- loid L2 (per-server Redis) status — only relevant on the public path --
  if (!token) {
    console.log('── loid cache (L2 = per-server Redis) ──');
    const redisKind = (ioRedis as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown';
    const isReal = !!process.env.REDIS_URL;
    console.log(`  ioRedis      = ${redisKind} (${isReal ? 'REAL Redis — L2 active' : 'in-memory stub — L2 is per-process only'})`);
    const key = `postiz:reddit:loid:${hostname()}`;
    let pre: unknown;
    try { pre = await ioRedis.get(key); } catch (e) { pre = `(get failed: ${(e as Error).message})`; }
    console.log(`  ${key}`);
    console.log(`  before lookup = ${pre ? 'PRESENT (left by a prior process/run → mint will be SKIPPED)' : 'absent (this process will mint, then share it)'}`);
    // Time a direct loid resolve to isolate mint/cache cost from the slow GETs.
    const tL = Date.now();
    const cookie = await getRedditLoidCookie();
    console.log(`  getRedditLoidCookie() = ${cookie ? cookie.slice(0, 24) + '…' : 'null'}  (${Date.now() - tL} ms — mint if cold, ~0 if from L1/L2)`);
    let post: unknown;
    try { post = await ioRedis.get(key); } catch { /* ignore */ }
    console.log(`  after lookup  = ${post ? 'PRESENT (now shared to this host for the next run)' : 'absent'}\n`);
  }

  // ---- Step 1: comment → author -------------------------------------------
  console.log('── Step 1: GET /api/info (comment → author) ──');
  const step1 = await timedGet(
    `https://oauth.reddit.com/api/info?id=t1_${commentId}`,
    `https://www.reddit.com/api/info.json?id=t1_${commentId}`,
    token
  );
  console.log(`  via=${step1.via}  HTTP ${step1.status}  ${step1.ms} ms`);
  let author: string | undefined;
  if (step1.ok) {
    try {
      const json = JSON.parse(step1.body) as { data?: { children?: Array<{ data?: { author?: string } }> } };
      author = json.data?.children?.[0]?.data?.author;
    } catch { /* non-JSON */ }
  }
  console.log(`  → author (handle) = ${author ?? 'COULD NOT RESOLVE'}${author === '[deleted]' ? ' (deleted — lookup aborts)' : ''}\n`);

  // ---- Step 2: author → /about (the "user info" call in question) ----------
  if (author && author !== '[deleted]') {
    console.log('── Step 2: GET /user/<author>/about (the USER INFO call — avatar + name) ──');
    const step2 = await timedGet(
      `https://oauth.reddit.com/user/${author}/about`,
      `https://www.reddit.com/user/${author}/about.json`,
      token
    );
    console.log(`  via=${step2.via}  HTTP ${step2.status}  ${step2.ms} ms`);
    if (step2.ok) {
      try {
        const about = JSON.parse(step2.body) as {
          data?: { id?: string; icon_img?: string; snoovatar_img?: string; subreddit?: { title?: string } };
        };
        const d = about.data;
        const avatar = (d?.snoovatar_img || d?.icon_img || '').replace(/&amp;/g, '&');
        console.log('  → USER INFO RETRIEVED:');
        console.log(`      id     = ${d?.id ? `t2_${d.id}` : '(none)'}`);
        console.log(`      name   = ${d?.subreddit?.title?.trim() || '(none)'}`);
        console.log(`      avatar = ${avatar || '(none)'}`);
        if (raw) console.log(`\n  raw /about body:\n${JSON.stringify(about, null, 2)}`);
      } catch {
        console.log('  → /about returned non-JSON / unparseable — enrichment would be DROPPED (handle-only).');
        if (raw) console.log(`\n  raw body (first 500): ${step2.body.slice(0, 500)}`);
      }
    } else {
      console.log(`  → /about FAILED (HTTP ${step2.status}) — user info NOT retrievable here; production degrades to handle-only.`);
      if (raw) console.log(`\n  raw body (first 500): ${step2.body.slice(0, 500)}`);
    }
    console.log('');
  }

  // ---- Authoritative: what the REAL production function returns ------------
  console.log('── Authoritative: fetchRedditAuthorProfile() end-to-end (exact production code) ──');
  const tStart = Date.now();
  const profile = await fetchRedditAuthorProfile(url, (m) => console.log(`    [profile] ${m}`));
  const totalMs = Date.now() - tStart;
  console.log(`  total = ${totalMs} ms`);
  if (!profile) {
    console.log('  → null (no comment id / unreachable / [deleted] author)');
  } else {
    const enriched = !!(profile.id || profile.name || profile.avatarUrl);
    console.log(`  → ${JSON.stringify(profile)}`);
    console.log(`  → ${enriched ? 'ENRICHED (Step 2 useful here)' : 'HANDLE-ONLY (Step 2 added NOTHING — wasted call)'}`);
  }

  console.log('\n=== Done ===');
}

main()
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Release the Redis connection (when REDIS_URL is real) so the process exits.
    void (ioRedis as { quit?: () => Promise<unknown> }).quit?.();
  });

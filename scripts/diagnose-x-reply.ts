/**
 * Diagnose why a specific X (Twitter) post cannot be replied to.
 *
 * Uses the org's OWN engage reply-account token (not the app-only bearer), because
 * the app bearer reports reply_settings='everyone' even for tweets the reply
 * account is actually forbidden from replying to (e.g. the author blocked it).
 *
 * Read-only by default: resolves the reply account, fetches the target tweet's
 * reply_settings + author, and inspects the relationship between the two accounts
 * (following / followed_by / blocking / blocked_by). Only with --send does it
 * actually attempt the reply and print the raw X error.
 *
 * Usage:
 *   # Read-only diagnosis (auto-picks the org's enabled X reply account)
 *   npx ts-node --project scripts/tsconfig.json scripts/diagnose-x-reply.ts \
 *     --url=https://x.com/user/status/123 --org=<orgId>
 *
 *   # Pin a specific reply integration (when the org has more than one)
 *   npx ts-node --project scripts/tsconfig.json scripts/diagnose-x-reply.ts \
 *     --url=https://x.com/user/status/123 --integration=<integrationId>
 *
 *   # Actually attempt the reply to capture the real X error (WILL POST if it succeeds)
 *   npx ts-node --project scripts/tsconfig.json scripts/diagnose-x-reply.ts \
 *     --url=https://x.com/user/status/123 --org=<orgId> --send --text="hello"
 *
 * Requires in .env: DATABASE_URL, X_API_KEY, X_API_SECRET
 *   (and X_CLIENT_ID / X_CLIENT_SECRET if an OAuth2 token needs refreshing).
 *
 * Note: integration.token / integration.refreshToken are stored in PLAINTEXT
 * (the posting path passes integration.token straight to the provider), so no
 * decryption is applied here.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import { TwitterApi } from 'twitter-api-v2';

interface CliArgs {
  url: string;
  orgId: string | null;
  integrationId: string | null;
  send: boolean;
  text: string;
}

function parseArgs(): CliArgs {
  const get = (flag: string) =>
    process.argv.find((a) => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=') ?? null;
  const url = get('--url');
  if (!url) {
    console.error('Missing --url=<tweetUrl>');
    console.error('Usage: --url=<tweetUrl> (--org=<orgId> | --integration=<id>) [--send --text="..."]');
    process.exit(1);
  }
  return {
    url,
    orgId: get('--org'),
    integrationId: get('--integration'),
    send: process.argv.includes('--send'),
    text: get('--text') ?? 'test reply (diagnostic)',
  };
}

// Extract the numeric tweet ID from any x.com / twitter.com status URL.
function extractTweetId(url: string): string {
  const m = url.match(/status(?:es)?\/(\d+)/);
  if (!m) {
    console.error(`Could not extract a tweet ID from URL: ${url}`);
    process.exit(1);
  }
  return m[1];
}

// Mirror XProvider.isOAuth1Token / buildClient so the script authenticates exactly
// like production does.
function isOAuth1Token(token: string): boolean {
  if (!token) return false;
  const colonIdx = token.indexOf(':');
  return colonIdx > 0 && token.length > colonIdx + 1;
}

function buildClient(accessToken: string): TwitterApi {
  if (isOAuth1Token(accessToken)) {
    const colonIdx = accessToken.indexOf(':');
    return new TwitterApi({
      appKey: process.env.X_API_KEY!,
      appSecret: process.env.X_API_SECRET!,
      accessToken: accessToken.substring(0, colonIdx),
      accessSecret: accessToken.substring(colonIdx + 1),
    });
  }
  return new TwitterApi(accessToken);
}

// Print every structured field twitter-api-v2 attaches to an API error.
function dumpError(label: string, err: any) {
  console.log(`\n  ✗ ${label} FAILED`);
  console.log(`    http code:   ${err?.code ?? '(none)'}`);
  console.log(`    message:     ${err?.message ?? '(none)'}`);
  if (err?.data) console.log(`    data:        ${JSON.stringify(err.data)}`);
  if (err?.errors) console.log(`    errors:      ${JSON.stringify(err.errors)}`);
  if (err?.rateLimit) console.log(`    rateLimit:   ${JSON.stringify(err.rateLimit)}`);
}

async function main() {
  const args = parseArgs();
  const tweetId = extractTweetId(args.url);
  const prisma = new PrismaClient();

  try {
    // ── Resolve the reply integration ─────────────────────────────────────────
    let integration:
      | { id: string; name: string; token: string; refreshToken: string | null; organizationId: string }
      | null = null;

    if (args.integrationId) {
      integration = await prisma.integration.findUnique({
        where: { id: args.integrationId },
        select: { id: true, name: true, token: true, refreshToken: true, organizationId: true },
      });
      if (!integration) {
        console.error(`Integration ${args.integrationId} not found.`);
        process.exit(1);
      }
    } else {
      if (!args.orgId) {
        console.error('Provide either --org=<orgId> or --integration=<id>.');
        process.exit(1);
      }
      const accounts = await prisma.engageXReplyAccount.findMany({
        where: { organizationId: args.orgId, engageEnabled: true },
        include: {
          integration: {
            select: { id: true, name: true, token: true, refreshToken: true, organizationId: true, disabled: true },
          },
        },
      });
      const usable = accounts.filter((a) => a.integration && !a.integration.disabled);
      if (usable.length === 0) {
        console.error(`No enabled X reply account found for org ${args.orgId}.`);
        process.exit(1);
      }
      if (usable.length > 1) {
        console.error(`Org ${args.orgId} has ${usable.length} enabled X reply accounts. Pin one with --integration=<id>:`);
        for (const a of usable) console.error(`  ${a.integration!.id}  (${a.integration!.name})`);
        process.exit(1);
      }
      integration = usable[0].integration!;
    }

    console.log(`Target tweet:     ${tweetId}  (${args.url})`);
    console.log(`Reply integration: ${integration.id}  (${integration.name})`);
    console.log(`Org:              ${integration.organizationId}`);

    // ── Build an authenticated client (refresh OAuth2 token if expired) ───────
    // Tokens are stored plaintext; the posting path uses integration.token as-is.
    let accessToken = integration.token;
    let client = buildClient(accessToken);
    const tokenKind = isOAuth1Token(accessToken) ? 'OAuth1.0a' : 'OAuth2';
    console.log(`Token type:       ${tokenKind}\n`);

    // ── WHO AM I (also validates the token) ───────────────────────────────────
    let me: { id: string; username: string; name: string };
    try {
      const meRes = await client.v2.me({ 'user.fields': ['username', 'name'] });
      me = { id: meRes.data.id, username: meRes.data.username, name: meRes.data.name };
    } catch (err: any) {
      const is401 = err?.code === 401;
      if (is401 && tokenKind === 'OAuth2' && integration.refreshToken && process.env.X_CLIENT_ID) {
        console.log('  Access token rejected (401). Refreshing OAuth2 token...');
        const refreshClient = new TwitterApi({
          clientId: process.env.X_CLIENT_ID!,
          clientSecret: process.env.X_CLIENT_SECRET!,
        });
        const refreshed = await refreshClient.refreshOAuth2Token(integration.refreshToken);
        accessToken = refreshed.accessToken;
        client = buildClient(accessToken);
        // Persist (plaintext) so we don't break the integration by consuming its refresh token.
        await prisma.integration.update({
          where: { id: integration.id },
          data: {
            token: refreshed.accessToken,
            ...(refreshed.refreshToken
              ? { refreshToken: refreshed.refreshToken }
              : {}),
            ...(refreshed.expiresIn
              ? { tokenExpiration: new Date(Date.now() + refreshed.expiresIn * 1000) }
              : {}),
          },
        });
        console.log('  Token refreshed and persisted.');
        const meRes = await client.v2.me({ 'user.fields': ['username', 'name'] });
        me = { id: meRes.data.id, username: meRes.data.username, name: meRes.data.name };
      } else {
        dumpError('v2.me (token validation)', err);
        console.log('\n  → The reply account token is invalid/expired. Reconnect the X account.');
        return;
      }
    }
    console.log(`Replying account: @${me.username} (${me.name}, id=${me.id})`);

    // ── Fetch the target tweet + author ───────────────────────────────────────
    let authorId: string | undefined;
    let authorUsername: string | undefined;
    try {
      const tweet = await client.v2.singleTweet(tweetId, {
        'tweet.fields': ['reply_settings', 'author_id', 'conversation_id', 'created_at', 'public_metrics', 'referenced_tweets'],
        expansions: ['author_id'],
        'user.fields': ['username', 'name', 'protected', 'public_metrics'],
      });
      authorId = tweet.data.author_id;
      const author = tweet.includes?.users?.find((u) => u.id === authorId);
      authorUsername = author?.username;
      // A 'retweeted' reference means this is a retweet — retweets cannot be replied to
      // via the API. 'quoted'/'replied_to' are fine to reply to.
      const refs = tweet.data.referenced_tweets ?? [];
      const retweetOf = refs.find((r) => r.type === 'retweeted');
      console.log('\nTarget tweet:');
      console.log(`  author:         @${author?.username} (${author?.name}, id=${authorId})`);
      console.log(`  protected:      ${(author as any)?.protected ?? '(unknown)'}`);
      console.log(`  reply_settings: ${tweet.data.reply_settings ?? 'everyone'}`);
      console.log(`  referenced:     ${refs.length ? refs.map((r) => `${r.type}:${r.id}`).join(', ') : '(none)'}`);
      console.log(`  text:           ${tweet.data.text?.slice(0, 120)}`);
      if (retweetOf) {
        console.log(`\n  → ROOT CAUSE: this is a RETWEET of ${retweetOf.id}. Retweets cannot be replied to via the X API.`);
        console.log(`    (To engage, reply to the original tweet ${retweetOf.id} instead.)`);
      }
    } catch (err: any) {
      dumpError('v2.singleTweet', err);
      console.log('\n  → Could not read the tweet (deleted, protected, or author blocked this account).');
    }

    // ── Relationship between reply account and author (v1.1 friendships/show) ──
    // This is the key signal the app-bearer cannot see: blocked_by / followed_by.
    if (authorId) {
      try {
        const rel = await client.v1.friendship({ source_id: me.id, target_id: authorId });
        const s = rel.relationship.source;
        console.log('\nRelationship (reply account → author):');
        console.log(`  you follow author:   ${s.following}`);
        console.log(`  author follows you:  ${s.followed_by}`);
        console.log(`  you blocking author: ${s.blocking}`);
        console.log(`  author blocked you:  ${s.blocked_by}`);
        console.log(`  you muting author:   ${s.muting}`);
        if (s.blocked_by) {
          console.log('\n  → ROOT CAUSE: the author has BLOCKED your reply account. Replies are impossible.');
        }
      } catch (err: any) {
        console.log('\n  (relationship check unavailable — v1.1 friendships/show needs OAuth1.0a / elevated access)');
        console.log(`    ${err?.code ?? ''} ${err?.message ?? ''}`);
      }
    }

    // ── Optionally attempt the actual reply ───────────────────────────────────
    if (!args.send) {
      console.log('\n[READ-ONLY] Re-run with --send --text="..." to attempt the reply and capture the raw X error.');
      console.log('            (If reply_settings=everyone and no block is shown above, the failure is almost');
      console.log('             certainly an author block or an X account/app-level anti-spam restriction.)');
      return;
    }

    console.log(`\nAttempting reply with text: "${args.text}" ...`);
    try {
      const res = await client.v2.tweet({ text: args.text, reply: { in_reply_to_tweet_id: tweetId } });
      console.log(`\n  ✓ Reply POSTED — tweet id ${res.data.id}`);
      console.log('    NOTE: this actually published a reply on X. Delete it manually if it was only a test.');
    } catch (err: any) {
      dumpError('v2.tweet (reply)', err);
      console.log('\n  → This is the real reason the reply is rejected. Map this exact code/string in x.provider.ts.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

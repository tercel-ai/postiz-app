/**
 * Diagnose WHY a specific engage X reply syncs no metrics (the `empty` case).
 *
 * For each matching X engage reply it prints the full decision chain:
 *   - Post: releaseURL / releaseId / integrationId / impressions / trafficScore
 *   - Attached Integration: profile(handle) / providerIdentifier / disabled /
 *     deletedAt / tokenExpiration(expired?) / refreshNeeded
 *   - parseXHandle(URL) vs integration.profile  → recomputed matchedBy
 *     (handle = author token → full metrics incl. impression/bookmark;
 *      bound/fallback = non-author token → public metrics only, owner-only = 0)
 *   - LIVE checkPostAnalytics() result: the returned AnalyticsData[] (or empty).
 *     x.provider.postAnalytics logs the exact empty reason inline
 *     ([x] postAnalytics … empty: …), so an empty here is self-explained.
 *
 * Read-only — never writes. Filter by URL substring (default: all X replies).
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-diagnose-x-reply.ts
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-diagnose-x-reply.ts --url aipartnerup
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-diagnose-x-reply.ts --url 2061981755566125311
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-diagnose-x-reply.ts --org <orgId>
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TwitterApi } from 'twitter-api-v2';
import { DatabaseModule } from '@gitroom/nestjs-libraries/database/prisma/database.module';
import { getTemporalModule } from '@gitroom/nestjs-libraries/temporal/temporal.module';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import {
  parseXHandle,
  pickXReplyIntegration,
} from '@gitroom/nestjs-libraries/engage/resolve-x-reply-integration';

@Module({ imports: [DatabaseModule, getTemporalModule(false)] })
class ScriptModule {}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main() {
  const urlFilter = arg('url');
  const orgFilter = arg('org');

  const prisma = new PrismaClient();

  const rows = await prisma.engageSentReply.findMany({
    where: {
      ...(orgFilter ? { organizationId: orgFilter } : {}),
      opportunity: { platform: 'x' },
      post: {
        source: 'engage',
        state: 'PUBLISHED',
        ...(urlFilter ? { releaseURL: { contains: urlFilter } } : {}),
      },
    },
    select: {
      id: true,
      organizationId: true,
      post: {
        select: {
          id: true,
          releaseURL: true,
          releaseId: true,
          integrationId: true,
          impressions: true,
          trafficScore: true,
          integration: {
            select: {
              id: true,
              profile: true,
              name: true,
              providerIdentifier: true,
              disabled: true,
              deletedAt: true,
              tokenExpiration: true,
              refreshNeeded: true,
            },
          },
        },
      },
    },
  });

  console.log(`\n=== Diagnose X engage replies (${rows.length} match) ===`);
  if (urlFilter) console.log(`URL filter: contains "${urlFilter}"`);
  if (orgFilter) console.log(`Org filter: ${orgFilter}`);

  // Bootstrap DI so we call the SAME checkPostAnalytics the sync uses.
  console.log('\nBootstrapping NestJS context...');
  const app = await NestFactory.createApplicationContext(ScriptModule, {
    logger: ['error', 'warn'],
  });
  const postsService = app.get(PostsService, { strict: false });

  for (const r of rows) {
    const post = r.post;
    if (!post) continue;
    const handle = parseXHandle(post.releaseURL);
    const intg = post.integration;
    const expired =
      intg?.tokenExpiration != null &&
      new Date(intg.tokenExpiration).getTime() < Date.now();

    // Recompute what auto-resolve WOULD pick now, over the org's live X accounts.
    const liveX = await prisma.integration.findMany({
      where: {
        organizationId: r.organizationId,
        providerIdentifier: 'x',
        disabled: false,
        deletedAt: null,
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, profile: true, /* engage flag stored elsewhere */ },
    });
    const resolved = pickXReplyIntegration(
      liveX.map((c) => ({ id: c.id, profile: c.profile })),
      post.releaseURL
    );
    const attachedIsAuthor =
      !!handle && (intg?.profile ?? '').replace(/^@/, '').toLowerCase() === handle;

    console.log('\n────────────────────────────────────────────');
    console.log(`sentReplyId : ${r.id}`);
    console.log(`org         : ${r.organizationId}`);
    console.log(`post.id     : ${post.id}`);
    console.log(`releaseURL  : ${post.releaseURL}`);
    console.log(`releaseId   : ${post.releaseId ?? '∅ (NULL → checkPostAnalytics early-returns [])'}`);
    console.log(`URL handle  : ${handle ?? '∅'}`);
    console.log(
      `integration : ${
        intg
          ? `${intg.id} profile="${intg.profile}" name="${intg.name}" ` +
            `disabled=${intg.disabled} deleted=${!!intg.deletedAt} ` +
            `expired=${expired} refreshNeeded=${intg.refreshNeeded}`
          : '∅ (NULL → checkPostAnalytics early-returns [])'
      }`
    );
    console.log(
      `author match: ${attachedIsAuthor ? 'YES → owner token → full metrics' : 'NO → non-author → owner-only (impr/bookmark) = 0'}`
    );
    console.log(
      `org live X  : ${liveX.length} account(s) [${liveX.map((c) => c.profile).join(', ')}]`
    );
    console.log(
      `auto-resolve: ${resolved ? `${resolved.matchedBy} → ${resolved.integrationId}` : '∅ (org has NO live X account)'}`
    );
    console.log(`stored      : impressions=${post.impressions ?? 'null'} trafficScore=${post.trafficScore ?? 'null'}`);

    if (!post.releaseId || !intg) {
      console.log('verdict     : cannot fetch — missing releaseId or integration (see ∅ above).');
      continue;
    }

    process.stdout.write('LIVE fetch  : calling checkPostAnalytics … ');
    try {
      const analytics = await postsService.checkPostAnalytics(
        r.organizationId,
        post.id,
        Date.now(),
        true // forceRefresh → bypass 5-min Redis cache for a true live read
      );
      const arr = Array.isArray(analytics) ? analytics : [];
      if (arr.length === 0) {
        console.log('EMPTY → see the [x] postAnalytics …empty: log line above for the exact reason.');
      } else {
        console.log('OK');
        for (const m of arr) {
          console.log(`              ${m.label.padEnd(12)} = ${m.data?.[0]?.total}`);
        }
      }
    } catch (e: any) {
      console.log(`THREW → ${e?.code || ''} ${e?.message || e}`);
    }

    // Read-only probe: what would an APP-ONLY PUBLIC fetch return (no user token
    // at all)? This is the proposed last-resort fallback. Prefer a static
    // X_BEARER_TOKEN; otherwise mint an app-only client at runtime from
    // X_API_KEY/X_API_SECRET via appLogin() (client_credentials). like/retweet/
    // reply/quote are public (any tweet); impression_count/bookmark_count are
    // owner-only and will be absent even here — proving an app-level path can
    // never recover those. Also reveals whether this app's API TIER allows
    // app-only reads at all (Free tier returns 403/429).
    const staticBearer = process.env.X_BEARER_TOKEN;
    const apiKey = process.env.X_API_KEY;
    const apiSecret = process.env.X_API_SECRET;
    if (!post.releaseId) {
      console.log('public probe: skipped (no releaseId)');
    } else if (!staticBearer && !(apiKey && apiSecret)) {
      console.log('public probe: skipped (no X_BEARER_TOKEN and no X_API_KEY/X_API_SECRET)');
    } else {
      try {
        let appClient: TwitterApi;
        let how: string;
        if (staticBearer) {
          appClient = new TwitterApi(staticBearer);
          how = 'X_BEARER_TOKEN';
        } else {
          appClient = await new TwitterApi({ appKey: apiKey!, appSecret: apiSecret! }).appLogin();
          how = 'appLogin(X_API_KEY/SECRET)';
        }
        process.stdout.write(`public probe: app-only via ${how} → GET /2/tweets/:id … `);
        const tweet = await appClient.v2.singleTweet(post.releaseId, {
          'tweet.fields': ['public_metrics'],
        });
        const pm = tweet?.data?.public_metrics as unknown as
          | Record<string, number>
          | undefined;
        if (!pm) {
          console.log(`no public_metrics (errors=${JSON.stringify(tweet?.errors ?? null)})`);
        } else {
          console.log('OK — owner-only (impression/bookmark) will be absent below');
          for (const k of Object.keys(pm)) {
            console.log(`              ${k.padEnd(18)} = ${pm[k]}`);
          }
        }
      } catch (e: any) {
        console.log(
          `public probe THREW → code=${e?.code ?? ''} ${e?.data?.detail || e?.message || e}`
        );
      }
    }
  }

  await app.close();
  await prisma.$disconnect();
  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

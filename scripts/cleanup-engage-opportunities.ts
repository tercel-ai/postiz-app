/**
 * Soft-delete EngageOpportunity records that cannot be replied to.
 *
 * Usage:
 *   # Delete a specific opportunity by ID
 *   npx tsx scripts/cleanup-engage-opportunities.ts --id=<opportunityId>
 *
 *   # Check reply_settings for all X opportunities via X API, then show which are restricted
 *   npx tsx scripts/cleanup-engage-opportunities.ts --platform=x --check
 *
 *   # Check + soft-delete only the reply-restricted ones
 *   npx tsx scripts/cleanup-engage-opportunities.ts --platform=x --check --execute
 *
 *   # Soft-delete ALL X opportunities without checking (nuclear option)
 *   npx tsx scripts/cleanup-engage-opportunities.ts --platform=x --execute
 *
 * Sets deletedAt = now(). All repository queries already filter deletedAt: null.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';

async function getBearerToken(): Promise<string> {
  const token = process.env.X_BEARER_TOKEN;
  if (token) return token;

  const key = process.env.X_API_KEY;
  const secret = process.env.X_API_SECRET;
  if (!key || !secret) throw new Error('Set X_BEARER_TOKEN or both X_API_KEY and X_API_SECRET in .env');

  const credentials = Buffer.from(`${encodeURIComponent(key)}:${encodeURIComponent(secret)}`).toString('base64');
  const res = await fetch('https://api.twitter.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to get Bearer Token (${res.status}): ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('No access_token in X OAuth2 response');
  return json.access_token;
}

async function fetchReplySettings(
  tweetIds: string[],
  bearerToken: string
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  // X API allows up to 100 IDs per request
  for (let i = 0; i < tweetIds.length; i += 100) {
    const chunk = tweetIds.slice(i, i + 100);
    const params = new URLSearchParams({
      ids: chunk.join(','),
      'tweet.fields': 'reply_settings',
    });
    const res = await fetch(`https://api.twitter.com/2/tweets?${params}`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`X API returned ${res.status}: ${body.slice(0, 200)}`);
      continue;
    }
    const json = (await res.json()) as {
      data?: Array<{ id: string; reply_settings?: string }>;
      errors?: Array<{ resource_id?: string; type?: string }>;
    };
    for (const tweet of json.data ?? []) {
      result.set(tweet.id, tweet.reply_settings ?? 'everyone');
    }
    // Tweets in errors (e.g. deleted/not found) — treat as restricted since we can't reply
    for (const err of json.errors ?? []) {
      if (err.resource_id) result.set(err.resource_id, 'not_found');
    }
  }
  return result;
}

async function main() {
  const dryRun = !process.argv.includes('--execute');
  const check = process.argv.includes('--check');
  const id = process.argv.find((a) => a.startsWith('--id='))?.split('=')[1];
  const platform = process.argv.find((a) => a.startsWith('--platform='))?.split('=')[1];

  if (!id && !platform) {
    console.error('Usage: --id=<uuid>  OR  --platform=x [--check] [--execute]');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const now = new Date();

  try {
    if (id) {
      const opp = await prisma.engageOpportunity.findUnique({
        where: { id },
        include: {
          states: { select: { organizationId: true, status: true } },
          sentReplies: { select: { id: true } },
        },
      });
      if (!opp) { console.log(`Opportunity ${id} not found.`); return; }

      console.log(`Opportunity: ${opp.id}`);
      console.log(`  platform:    ${opp.platform}`);
      console.log(`  url:         ${opp.externalPostUrl}`);
      console.log(`  content:     ${opp.postContent.slice(0, 100)}`);
      console.log(`  states:      ${opp.states.length}  sentReplies: ${opp.sentReplies.length}`);
      console.log(`  deletedAt:   ${opp.deletedAt ?? '(active)'}`);

      if (opp.deletedAt) { console.log('Already soft-deleted.'); return; }

      if (dryRun) {
        console.log('\n[DRY RUN] Would soft-delete. Pass --execute to apply.');
      } else {
        await prisma.engageOpportunity.update({ where: { id }, data: { deletedAt: now } });
        console.log('\nSoft-deleted.');
      }
      return;
    }

    // Platform-wide
    const records = await prisma.engageOpportunity.findMany({
      where: { platform: platform!, deletedAt: null },
      select: {
        id: true,
        externalPostId: true,
        externalPostUrl: true,
        postContent: true,
        _count: { select: { states: true, sentReplies: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    console.log(`Found ${records.length} active ${platform} opportunity(ies).\n`);
    if (records.length === 0) return;

    let toDelete = records;

    if (check && platform === 'x') {
      let bearerToken: string;
      try {
        bearerToken = await getBearerToken();
      } catch (err: any) {
        console.error(err.message);
        process.exit(1);
      }

      console.log('Checking reply_settings via X API...\n');
      const tweetIds = records.map((r) => r.externalPostId);
      const settingsMap = await fetchReplySettings(tweetIds, bearerToken);

      console.log('Results:');
      for (const r of records) {
        const setting = settingsMap.get(r.externalPostId) ?? 'unknown';
        const restricted = setting !== 'everyone';
        console.log(
          `  [${restricted ? 'RESTRICTED' : 'ok      '}]  ${setting.padEnd(14)}  ${r.externalPostUrl}`
        );
      }
      console.log('');

      toDelete = records.filter((r) => {
        const setting = settingsMap.get(r.externalPostId) ?? 'unknown';
        return setting !== 'everyone';
      });


      console.log(
        `${toDelete.length} restricted (will delete), ${records.length - toDelete.length} ok (will keep).\n`
      );
    }

    if (toDelete.length === 0) {
      console.log('Nothing to delete.');
      return;
    }

    if (dryRun) {
      console.log(`[DRY RUN] Would soft-delete ${toDelete.length} opportunity(ies). Pass --execute to apply.`);
    } else {
      const result = await prisma.engageOpportunity.updateMany({
        where: { id: { in: toDelete.map((r) => r.id) } },
        data: { deletedAt: now },
      });
      console.log(`Soft-deleted ${result.count} opportunity(ies).`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

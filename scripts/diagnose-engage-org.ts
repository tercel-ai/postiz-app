import { recoveryDatabase } from './lib/recovery-database';
/**
 * Read-only Engage reply inventory. No reply content or credentials are printed.
 * Verify the actual connection target before using --database-verified.
 */
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';

async function main() {
  const { values } = parseArgs({ options: {
    'organization-id': { type: 'string' },
    'database-verified': { type: 'boolean' },
    limit: { type: 'string', default: '200' },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: pnpm exec ts-node --project scripts/tsconfig.json scripts/diagnose-engage-org.ts --organization-id <id> --database-verified [--limit 200]');
    return;
  }
  if (!values['organization-id'] || !values['database-verified']) {
    throw new Error('Provide --organization-id and verify the actual database is aisee_postiz_dev before passing --database-verified');
  }
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Limit must be an integer from 1 to 1000');
  const connection = recoveryDatabase(values['database-verified']);
  const db = new PrismaClient({ datasources: { db: { url: connection.url } }, log: [] });
  try {
    const organizationId = values['organization-id'];
    const [total, rows, unlinked] = await Promise.all([
      db.engageSentReply.count({ where: { organizationId } }),
      db.engageSentReply.findMany({
        where: { organizationId }, orderBy: { createdAt: 'desc' }, take: limit,
        select: {
          id: true, projectId: true, createdAt: true, updatedAt: true,
          post: { select: { id: true, state: true, source: true, providerIdentifier: true, integrationId: true, publishDate: true, publishMethod: true, releaseId: true, releaseURL: true, claimedAt: true, error: true, sendBlockCode: true, executionProtocol: true, sendIntentId: true, deletedAt: true } },
          opportunity: { select: { id: true, platform: true, externalPostUrl: true, deletedAt: true, repliesDisabledAt: true } },
        },
      }),
      db.post.count({ where: { organizationId, source: 'engage', engageSentReply: { is: null } } }),
    ]);
    const counts: Record<string, number> = {};
    const reports = rows.map(({ post, opportunity, ...reply }) => {
      const flags: string[] = [];
      if (post.state === 'QUEUE') {
        if (!reply.projectId) flags.push('missing_project_id');
        if (!post.providerIdentifier) flags.push('missing_provider_identifier');
        if (post.deletedAt) flags.push('post_deleted');
        if (post.releaseURL) flags.push('queued_with_release_url');
        if (post.releaseId && !post.claimedAt) flags.push('release_id_without_claim_time');
        if (post.releaseId && post.claimedAt) flags.push('leased_check_lease_expiry');
        if (!opportunity.externalPostUrl.trim()) flags.push('missing_target_url');
        if (opportunity.deletedAt) flags.push('target_deleted');
        if (opportunity.repliesDisabledAt) flags.push('target_replies_disabled');
        if (post.sendIntentId || (post.executionProtocol && post.executionProtocol !== 'LEGACY')) flags.push('coordinated_send_check_intent');
        if (post.publishDate > new Date()) flags.push('future_publish_date_check_schedule');
      }
      if (post.error) flags.push('post_has_error');
      if (post.sendBlockCode) flags.push('post_has_send_block_code');
      for (const key of [`state:${post.state}`, `platform:${opportunity.platform}`, ...flags]) counts[key] = (counts[key] || 0) + 1;
      return { ...reply, post: { ...post, releaseId: post.releaseId ? '[present]' : null, releaseURL: post.releaseURL ? '[present]' : null }, opportunity: { ...opportunity, externalPostUrl: opportunity.externalPostUrl ? '[present]' : '' }, flags };
    });
    console.log(JSON.stringify({ observedAt: new Date().toISOString(), organizationId, totalReplies: total, sampledReplies: rows.length, unlinkedEngagePosts: unlinked, counts, replies: reports }, null, 2));
  } finally { await db.$disconnect(); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : 'Diagnostic failed'); process.exitCode = 1; });

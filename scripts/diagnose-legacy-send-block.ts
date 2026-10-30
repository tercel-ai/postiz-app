import { recoveryDatabase } from './lib/recovery-database';
/** Read-only inspection of legacy work that may block coordinated sending. */
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { SendModeService } from '@gitroom/nestjs-libraries/extension/send-mode.service';

async function main() {
  const { values } = parseArgs({ options: {
    'organization-id': { type: 'string' }, 'integration-id': { type: 'string' },
    'database-verified': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: pnpm exec ts-node --project scripts/tsconfig.json scripts/diagnose-legacy-send-block.ts --organization-id <id> --integration-id <id> --database-verified');
    return;
  }
  const org = values['organization-id'];
  const integrationId = values['integration-id'];
  if (!org || !integrationId || !values['database-verified']) throw new Error('Specify organization and integration, and verify the actual database before using --database-verified');
  const connection = recoveryDatabase(values['database-verified']);
  const db = new PrismaClient({ datasources: { db: { url: connection.url } }, log: [] });
  try {
    const integration = await db.integration.findFirst({ where: { organizationId: org, id: integrationId }, select: { id: true, providerIdentifier: true, disabled: true, deletedAt: true } });
    if (!integration) throw new Error('INTEGRATION_NOT_FOUND_IN_ORGANIZATION');
    // These service methods only perform reads; they mirror the production blocker logic.
    const mode = new SendModeService(db as any);
    const internals = mode as any;
    const [setting, posts, records, blocked] = await Promise.all([
      db.settings.findUnique({ where: { key: `sending.organization_mode:${org}` }, select: { value: true } }),
      internals.pendingPostsIn(db, org),
      internals.autonomousRecordsIn(db, org),
      mode.legacyAccountBlockedIn(db as any, org, integrationId),
    ]);
    const config = setting?.value as any;
    const captured = config?.legacyDrain ?? config?.transition ?? null;
    const capturedIds: string[] = Array.isArray(captured?.eligiblePostIds) ? captured.eligiblePostIds : [];
    const capturedPosts = capturedIds.length ? await db.post.findMany({ where: { organizationId: org, id: { in: capturedIds } }, select: { id: true, state: true, source: true, providerIdentifier: true, integrationId: true, publishMethod: true, publishDate: true, parentPostId: true, claimedAt: true, releaseId: true, releaseURL: true, deletedAt: true, executionProtocol: true, sendIntentId: true } }) : [];
    const present = new Set(capturedPosts.map(p => p.id));
    const missingIds = capturedIds.filter(id => !present.has(id));
    const settled: Set<string> = config?.mode === 'CONTROLLED' ? await internals.settledLegacyReplyWritersIn(db, org, posts, records) : new Set();
    const postIds = [...new Set([...capturedIds, ...posts.map((p: any) => p.id)])] as string[];
    const replies = postIds.length ? await db.engageSentReply.findMany({ where: { organizationId: org, postId: { in: postIds } }, select: { id: true, postId: true, projectId: true, opportunityId: true } }) : [];
    const safePost = (p: any) => ({ ...p, releaseId: p.releaseId ? '[present]' : null, releaseURL: p.releaseURL ? '[present]' : null, settledWriter: settled.has(p.id), captured: capturedIds.includes(p.id), reply: replies.find(r => r.postId === p.id) ?? null });
    const receiptSummaries = records.map(({ row, result }: any) => ({ id: row.id, userId: row.userId, createdAt: row.createdAt, status: result.status, source: result.source, action: result.action, platform: result.platform, integrationId: result.integrationId, postIds: result.postIds, recurring: result.recurring, occurrenceKey: result.occurrenceKey, legacyClaimPresent: !!result.legacyClaim }));
    console.log(JSON.stringify({ observedAt: new Date().toISOString(), organizationId: org, integration, blocked, mode: config?.mode ?? null, transition: captured ? { type: config?.legacyDrain ? 'legacyDrain' : 'transition', version: captured.version, targetMode: captured.targetMode, requestedAt: captured.requestedAt, capturedCount: capturedIds.length, missingCount: missingIds.length, missingIds } : null, activeLegacyPostCount: posts.length, activeLegacyPosts: posts.map(safePost), capturedPosts: capturedPosts.map(safePost), receipts: receiptSummaries, note: 'Snapshots can change between reads; presence in this report alone does not prove a specific record blocks this account or was not submitted.' }, null, 2));
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Diagnostic failed'); process.exitCode = 1; });

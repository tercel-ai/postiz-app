/**
 * Read-only reconciliation of REPLIED opportunities, reply history and send receipts.
 * Run from postiz-app; date means the calendar day at the supplied UTC offset.
 * pnpm exec ts-node --project scripts/tsconfig.json scripts/diagnose-engage-reply-consistency.ts \
 *   --user-id USER_ID --date 2026-11-17 --offset +08:00
 * No SQL, writes, reply text, credentials, journal payloads or raw errors are emitted.
 */
import { parseArgs } from 'node:util';
import { Prisma, PrismaClient } from '@prisma/client';
import { recoveryDatabase } from './lib/recovery-database';

const CAP = 1000;
const opportunitySelect = {
  id: true, platform: true, authorUsername: true, externalPostId: true,
  postPublishedAt: true, deletedAt: true,
} as const;

async function main() {
  const { values } = parseArgs({ options: {
    'user-id': { type: 'string' }, date: { type: 'string' },
    offset: { type: 'string', default: '+08:00' },
    'project-id': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: diagnose-engage-reply-consistency.ts --user-id ID --date YYYY-MM-DD [--offset +08:00] [--project-id ID]');
    return;
  }
  const day = values.date ?? '';
  const offset = values.offset!;
  if (!values['user-id'] || !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(offset) ||
      (offset.slice(1, 3) === '14' && offset.slice(4) !== '00')) {
    throw new Error('INVALID_USER_DATE_OR_OFFSET');
  }
  const midnight = new Date(day + 'T00:00:00Z');
  if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== day) throw new Error('INVALID_DATE');
  const since = new Date(day + 'T00:00:00' + offset);
  const until = new Date(since.getTime() + 86_400_000);
  // Inspect the parsed target BEFORE constructing a client or connecting.
  const connection = recoveryDatabase(true);
  console.log(JSON.stringify({ target: connection.target }));
  if (connection.target.database !== 'aisee_postiz_dev') throw new Error('DATABASE_URL_MUST_TARGET_AISEE_POSTIZ_DEV');
  const db = new PrismaClient({ datasources: { db: { url: connection.url } }, log: [] });
  try {
    // A consistent snapshot prevents a receipt arriving between the two reads
    // from looking like an orphan. All operations below are Prisma reads.
    const report = await db.$transaction(async tx => {
      const memberships = await tx.userOrganization.findMany({
        where: { userId: values['user-id'] },
        select: { organizationId: true, disabled: true },
      });
      const organizations = [];
      for (const membership of memberships) {
        const organizationId = membership.organizationId;
        const scope = { organizationId, ...(values['project-id'] ? { projectId: values['project-id'] } : {}) };
        const window = { gte: since, lt: until };
        // REPLIED is historical: updatedAt isn't necessarily the actual send time.
        // Read all REPLIED rows, then today's touched replies plus their histories.
        const states = await tx.engageOpportunityState.findMany({
          where: { ...scope, status: 'REPLIED' }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: CAP + 1,
          select: { id: true, projectId: true, status: true, score: true, createdAt: true, updatedAt: true, opportunity: { select: opportunitySelect } },
        });
        const stateRows = states.slice(0, CAP);
        const replies = await tx.engageSentReply.findMany({
          where: { ...scope, OR: [
            { opportunityId: { in: stateRows.map(s => s.opportunity.id) } },
            { createdAt: window }, { updatedAt: window }, { post: { publishDate: window } },
          ] },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: CAP + 1,
          select: {
            id: true, projectId: true, opportunityId: true, createdAt: true, updatedAt: true, removedAt: true,
            opportunity: { select: opportunitySelect },
            post: { select: {
              id: true, projectId: true, source: true, state: true, providerIdentifier: true,
              publishDate: true, deletedAt: true, releaseURL: true, executionProtocol: true,
              sendIntentId: true, sendBlockCode: true,
            } },
          },
        });
        const replyRows = replies.slice(0, CAP);
        const executions = await tx.sendExecution.findMany({
          where: { ...scope, action: 'REPLY', OR: [
            { createdAt: window }, { updatedAt: window },
            { intent: { rootPostId: { in: replyRows.map(r => r.post.id) } } },
          ] },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: CAP + 1,
          select: {
            id: true, projectId: true, platform: true, status: true, kind: true, createdAt: true, updatedAt: true,
            intent: { select: { id: true, rootPostId: true, status: true, sendOrigin: true, hasConfirmedSegments: true,
              rootPost: { select: { state: true, engageSentReply: { select: { id: true } } } } } },
            segments: { select: { segmentIndex: true, status: true, authorizedAt: true, confirmedAt: true } },
          },
        });
        const counts = await tx.engageOpportunityState.groupBy({
          by: ['projectId', 'status'], where: scope, _count: { _all: true },
        });
        const inDay = (date: Date) => date >= since && date < until;
        const sampledPublishedTodayByPlatform: Record<string, number> = {};
        const history = replyRows.map(r => {
          const flags: string[] = [];
          if (r.post.deletedAt) flags.push('HIDDEN_DELETED_POST');
          if (r.post.source !== 'engage') flags.push('HIDDEN_NON_ENGAGE_SOURCE');
          if (r.projectId !== r.post.projectId) flags.push('POST_REPLY_PROJECT_MISMATCH');
          if (r.post.state !== 'PUBLISHED') flags.push('NOT_PUBLISHED');
          if (r.post.state === 'PUBLISHED' && !r.post.releaseURL) flags.push('PUBLISHED_LINK_PENDING');
          if (r.post.state === 'PUBLISHED' && !r.post.deletedAt && r.post.source === 'engage' && inDay(r.post.publishDate)) {
            const key = `${r.projectId ?? '(null)'}:${r.opportunity.platform}`;
            sampledPublishedTodayByPlatform[key] = (sampledPublishedTodayByPlatform[key] ?? 0) + 1;
          }
          return { ...r, post: { ...r.post, releaseURL: r.post.releaseURL ? '[present]' : null },
            createdOnDay: inDay(r.createdAt), publishedOnDay: inDay(r.post.publishDate), flags };
        });
        organizations.push({ ...membership, counts, sampledPublishedTodayByPlatform,
          truncated: { states: states.length > CAP, replies: replies.length > CAP, executions: executions.length > CAP },
          repliedOpportunities: stateRows.map(s => {
            const linked = replyRows.filter(r => r.opportunityId === s.opportunity.id && r.projectId === s.projectId);
            return { ...s, updatedOnDay: inDay(s.updatedAt), linkedReplyIds: linked.map(r => r.id),
              flags: linked.length === 0 ? ['NO_MATCHING_HISTORY_IN_SAMPLE'] :
                linked.every(r => r.post.deletedAt || r.post.state !== 'PUBLISHED') ? ['NO_LIVE_PUBLISHED_HISTORY_IN_SAMPLE'] : [] };
          }),
          history, executions: executions.slice(0, CAP),
        });
      }
      return { userId: values['user-id'], projectId: values['project-id'] ?? '(all projects, separated in output)',
        day, offset, since, until, organizations,
        notes: [
          'Organization history is shared; membership does not prove this user sent every reply.',
          'REPLIED counts opportunities; history counts individual Post records. Compare the same project and platform.',
          'Feed Last 24h filters original postPublishedAt; the day window here concerns reply publishDate, createdAt or updatedAt.',
          'updatedAt is not a send receipt. PUBLISHED and segment confirmations are backend evidence, not live platform verification.',
          'Extension history is local to the browser and cannot be read from this database.',
          'Each detailed dataset is capped at 1000. Opportunity group counts are exact; published-day totals use the sample. Inspect truncated before interpreting missing links.',
        ] };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 30000 });
    console.log(JSON.stringify({ observedAt: new Date().toISOString(), ...report }, null, 2));
    if (!report.organizations.length) console.error('NO_MEMBERSHIPS_FOUND: verify whether this is a core user ID rather than a Postiz user ID.');
  } finally { await db.$disconnect(); }
}

if (require.main === module) void main().catch((error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) :
    error && typeof error === 'object' && 'errorCode' in error ? String(error.errorCode) :
    error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'UNAVAILABLE';
  console.error(JSON.stringify({ errorType: error instanceof Error ? error.name : 'Unknown', code }));
  console.error('DIAGNOSIS_FAILED: verify arguments, database target and connectivity; raw errors suppressed to protect credentials.');
  process.exitCode = 1;
});

/**
 * Read-only diagnosis of extension attempts, including uncertain publish outcomes.
 * Run from postiz-app:
 *   pnpm exec ts-node --project scripts/tsconfig.json scripts/diagnose-send-attempts.ts --help
 * No tokens, content, or raw platform evidence are printed. No repair is performed.
 */
import { basename } from 'node:path';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import { databaseNameFromUrl } from './lib/database-url';

export interface DiagnosisOptions {
  attempt?: string;
  reply?: string;
  user?: string;
  organization?: string;
  cursor?: string;
  limit: number;
  details?: boolean;
}

export function parseOptions(args: string[]): DiagnosisOptions {
  const values: Record<string, string> = {};
  let details = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--details') { details = true; continue; }
    const value = args[++index];
    if (!['--attempt', '--reply', '--user', '--organization', '--cursor', '--limit'].includes(key) || !value || value.startsWith('--'))
      throw new Error('Expected --attempt ID, --reply ID, --user ID, --organization ID, --cursor ID, or --limit NUMBER; --details enables outcome diagnostics');
    values[key] = value;
  }
  const limit = Number(values['--limit'] ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Limit must be an integer from 1 to 1000');
  return { attempt: values['--attempt'], reply: values['--reply'], user: values['--user'], organization: values['--organization'], cursor: values['--cursor'], limit, ...(details ? { details } : {}) };
}

export function assertDiagnosisDatabase(databaseUrl: string | undefined) {
  databaseNameFromUrl(databaseUrl);
}

/** Extract only the credential-free stage and code written by the extension. */
export function summarizeSendEvidence(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const evidence = typeof record.evidence === 'string' ? record.evidence : '';
  const phase = evidence.match(/\bPhase: (PREPARED|AUTHORIZING|AUTHORIZED|SUBMITTING|CONFIRMED|UNKNOWN|NOT_SUBMITTED)\b/)?.[1];
  const code = evidence.match(/\bcode: ([A-Z][A-Z0-9_]{0,95})\b/)?.[1];
  return {
    ...(['confirmed', 'unknown', 'definitely_not_submitted'].includes(String(record.status)) ? { status: record.status } : {}),
    ...(phase ? { phase } : {}), ...(code ? { code } : {}),
    workerRestarted: evidence.includes('Worker restarted; no platform submission will be replayed.'),
  };
}

export async function diagnoseSendAttempts(db: PrismaClient, options: DiagnosisOptions) {
  const nodesForUser = options.user ? await db.extensionNode.findMany({
    where: { registeredByUserId: options.user, organizationId: options.organization },
    select: { id: true },
  }) : [];
  const attempts = await db.sendExecution.findMany({
    where: {
      kind: 'EXTENSION',
      ...(options.attempt ? { id: options.attempt } : options.reply || options.user ? {} : { segments: { some: {
        status: 'PENDING', permitHash: null, authorizedAt: null, submitBefore: null,
      } } }),
      ...(options.organization ? { organizationId: options.organization } : {}),
      ...(options.reply ? { action: 'REPLY', intent: { rootPost: { engageSentReply: { id: options.reply } } } } : {}),
      ...(options.user ? {
        platform: 'devto', action: 'REPLY',
        OR: [
          { extensionNodeId: { in: nodesForUser.map(node => node.id) } },
          { intent: { policySnapshot: { path: ['policyOwnerUserId'], equals: options.user } } },
        ],
      } : {}),
    },
    orderBy: { id: 'asc' }, take: options.limit,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: {
      id: true, organizationId: true, extensionNodeId: true, integrationId: true,
      platform: true, action: true, status: true, createdAt: true, leaseExpiresAt: true,
      startedAt: true, lastProgressAt: true, sessionRevision: true, nodeCredentialVersion: true,
      intent: { select: { rootPostId: true, status: true, activeExecutionId: true } },
      segments: { orderBy: { segmentIndex: 'asc' }, select: {
        segmentIndex: true, status: true, authorizedAt: true, submitBefore: true,
        ...(options.details ? { result: true, confirmedAt: true, evidenceObservedAt: true, evidenceSessionRevision: true } : {}),
      } },
    },
  });
  const accounts = await db.integration.findMany({
    where: { id: { in: [...new Set(attempts.map(attempt => attempt.integrationId))] } },
    select: { id: true, deletedAt: true, disabled: true },
  });
  const roots = await db.post.findMany({
    where: { id: { in: [...new Set(attempts.map(attempt => attempt.intent.rootPostId))] } },
    select: { id: true, deletedAt: true, state: true },
  });
  const ids = attempts.map(attempt => attempt.id);
  const events = options.details && ids.length ? await db.sendOutcomeEvent.findMany({
    where: { executionId: { in: ids } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1001,
    select: { executionId: true, segmentIndex: true, eventId: true, createdAt: true, evidence: true },
  }) : [];
  const nodes = options.details && ids.length ? await db.extensionNode.findMany({
    where: { id: { in: [...new Set(attempts.flatMap(attempt => attempt.extensionNodeId ? [attempt.extensionNodeId] : []))] } },
    select: { id: true, status: true, browser: true, extensionVersion: true, lastSeenAt: true,
      credentialVersion: true, sessions: { select: { platform: true, integrationId: true,
        verificationStatus: true, sessionRevision: true, verifiedAt: true, verificationExpiresAt: true } } },
  }) : [];
  return {
    ...(options.details ? { eventsTruncated: events.length > 1000,
      contextNote: 'Node sessions are current snapshots, not proof of the session at send time. A submit permit does not prove a native click occurred.' } : {}),
    note: 'Database state only. Compare with the original node journal before confirming a stop. No records were changed.',
    nextCursor: attempts.length === options.limit ? attempts.at(-1)!.id : null,
    attempts: attempts.map(attempt => ({
      ...attempt,
      ...(options.details ? {
        segments: attempt.segments?.map(segment => ({ ...segment, result: summarizeSendEvidence(segment.result) })),
        diagnostics: {
          node: nodes.find(node => node.id === attempt.extensionNodeId) ?? null,
          events: events.slice(0, 1000).filter(event => event.executionId === attempt.id).map(({ evidence, ...event }) => ({
            ...event, ...summarizeSendEvidence(evidence),
          })),
        },
      } : {}),
      account: accounts.find(account => account.id === attempt.integrationId) ?? null,
      root: roots.find(root => root.id === attempt.intent.rootPostId) ?? null,
    })),
  };
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: pnpm exec ts-node --project scripts/tsconfig.json scripts/diagnose-send-attempts.ts [--attempt ID] [--reply ID] [--user ID (Dev.to replies)] [--organization ID] [--cursor ID] [--limit 100] [--details]');
    return;
  }
  const options = parseOptions(process.argv.slice(2));
  dotenv.config();
  // Validate the target before constructing a database client. All queries use ORM reads.
  assertDiagnosisDatabase(process.env.DATABASE_URL);
  const db = new PrismaClient();
  try { console.log(JSON.stringify(await diagnoseSendAttempts(db, options), null, 2)); }
  finally { await db.$disconnect(); }
}
if (basename(process.argv[1] ?? '') === 'diagnose-send-attempts.ts') void main().catch(() => {
  console.error('Diagnosis failed. Check arguments, database name, and database connectivity.');
  process.exitCode = 1;
});

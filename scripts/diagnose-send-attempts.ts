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
import { CONTROLLED_SEND_PLATFORMS } from '../libraries/nestjs-libraries/src/extension/controlled-platforms';

export interface DiagnosisOptions {
  attempt?: string;
  reply?: string;
  user?: string;
  organization?: string;
  cursor?: string;
  platform?: typeof CONTROLLED_SEND_PLATFORMS[number] | 'all';
  action?: 'POST' | 'REPLY' | 'all';
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
    if (!['--attempt', '--reply', '--user', '--organization', '--cursor', '--limit', '--platform', '--action'].includes(key) || !value || value.startsWith('--'))
      throw new Error('Expected --attempt ID, --reply ID, --user ID, --organization ID, --cursor ID, --limit NUMBER, --platform PLATFORM|all, or --action POST|REPLY|all; --details enables outcome diagnostics');
    values[key] = value;
  }
  const limit = Number(values['--limit'] ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Limit must be an integer from 1 to 1000');
  const platform = values['--platform'] as DiagnosisOptions['platform'];
  const action = values['--action'] as DiagnosisOptions['action'];
  if (platform !== undefined && platform !== 'all' && !(CONTROLLED_SEND_PLATFORMS as readonly string[]).includes(platform))
    throw new Error(`Platform must be one of ${CONTROLLED_SEND_PLATFORMS.join(', ')}, or all`);
  if (action !== undefined && !['POST', 'REPLY', 'all'].includes(action))
    throw new Error('Action must be POST, REPLY, or all');
  if (values['--reply'] && action === 'POST') throw new Error('Reply scope requires REPLY or all');
  return { platform, action, attempt: values['--attempt'], reply: values['--reply'], user: values['--user'], organization: values['--organization'], cursor: values['--cursor'], limit, ...(details ? { details } : {}) };
}

export function assertDiagnosisDatabase(databaseUrl: string | undefined) {
  databaseNameFromUrl(databaseUrl);
}

/** Override generated test datasources with the explicitly validated operator configuration. */
export function createDiagnosisClient(databaseUrl: string | undefined): PrismaClient {
  assertDiagnosisDatabase(databaseUrl);
  return new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
}

/** Report actionable error categories without printing URLs, credentials or raw Prisma queries. */
export function formatDiagnosisFailure(error: unknown): { code?: string; message: string } {
  const failure = error as { code?: unknown; errorCode?: unknown } | null;
  const value = failure?.code ?? failure?.errorCode;
  const code = typeof value === 'string' && /^P\d{4}$/.test(value) ? value : undefined;
  const messages: Record<string, string> = {
    P1000: 'Database authentication failed. Verify the configured database credentials.',
    P1001: 'Cannot reach the configured PostgreSQL server from this computer. Check the database address and network access.',
    P1002: 'The configured PostgreSQL server did not respond in time. Check connectivity and server availability.',
    P1011: 'The database TLS connection failed. Check the configured certificate and SSL requirements.',
    P2021: 'A required database table is missing. Verify the selected database and deployed schema.',
    P2022: 'A required database column is missing. Verify the selected database and deployed schema.',
  };
  return { ...(code ? { code } : {}), message: code && messages[code] ||
    'Diagnosis failed. Check arguments, DATABASE_URL and database connectivity. No records were changed.' };
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
  const platform = options.platform ?? (options.user ? 'devto' : undefined);
  const action = options.action ?? (options.user ? 'REPLY' : undefined);
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
      ...(platform && platform !== 'all' ? { platform } : {}),
      ...(action && action !== 'all' ? { action } : {}),
      ...(options.user ? {
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
    console.log('Usage: pnpm exec ts-node --project scripts/tsconfig.json scripts/diagnose-send-attempts.ts [--attempt ID] [--reply ID] [--user ID] [--platform x|reddit|linkedin|medium|quora|hackernews|devto|all] [--action POST|REPLY|all] [--organization ID] [--cursor ID] [--limit 100] [--details]');
    console.log('User scans default to --platform devto --action REPLY when those selectors are omitted. Use all to remove each selector; --reply always retains its reply scope.');
    console.log('Example: pnpm exec ts-node --project scripts/tsconfig.json scripts/diagnose-send-attempts.ts --user USER_ID --organization ORG_ID --platform linkedin --action POST --details');
    return;
  }
  const options = parseOptions(process.argv.slice(2));
  dotenv.config();
  // Validate the target before constructing a database client. All queries use ORM reads.
  const db = createDiagnosisClient(process.env.DATABASE_URL);
  try { console.log(JSON.stringify(await diagnoseSendAttempts(db, options), null, 2)); }
  finally { await db.$disconnect(); }
}
if (basename(process.argv[1] ?? '') === 'diagnose-send-attempts.ts') void main().catch(error => {
  console.error(JSON.stringify(formatDiagnosisFailure(error), null, 2));
  process.exitCode = 1;
});

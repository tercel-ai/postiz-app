/** Bounded ORM reads only. Never print credentials, raw payloads, or raw evidence. */
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import { assertDiagnosisDatabase, summarizeSendEvidence } from './diagnose-send-attempts';

export interface RegressionOptions { organization: string; since: Date; limit: number }
export function parseRegressionOptions(args: string[]): RegressionOptions {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--organization', '--since', '--limit'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--'))
      throw new Error('Expected --organization ID, --since ISO_DATE, and --limit NUMBER');
    values[args[i]] = args[i + 1];
  }
  const organization = values['--organization']?.trim();
  const since = new Date(values['--since'] ?? '2026-10-15T00:00:00Z');
  const limit = Number(values['--limit'] ?? 200);
  if (!organization || !Number.isFinite(since.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error('An organization, valid date, and limit from 1 to 500 are required');
  return { organization, since, limit };
}

/** Permit/phase receipts do not prove a native click; preserve that distinction. */
export function summarizeRegressionAttempt(attempt: any) {
  const payload = Array.isArray(attempt.payload) ? attempt.payload : [];
  const segments = (attempt.segments ?? []).map(({ result, ...segment }: any) => {
    const frozen = payload.find((item: any) => item.id === segment.postId);
    const evidence = summarizeSendEvidence(result);
    return { ...segment, evidence,
      payloadHashMatches: frozen?.contentHash && segment.contentHash ? frozen.contentHash === segment.contentHash : null,
      nativeClickProven: segment.status === 'CONFIRMED' && result?.status === 'confirmed',
    };
  });
  const { payload: _payload, outcomeEvents, ...safe } = attempt;
  return { ...safe, segments,
    outcomeEvents: (outcomeEvents ?? []).map(({ evidence, ...event }: any) => ({ ...event, evidence: summarizeSendEvidence(evidence) })),
    intentOwnerMatches: attempt.intent?.activeExecutionId ? attempt.intent.activeExecutionId === attempt.id : null,
  };
}

export async function diagnosePublishRegression(db: PrismaClient, options: RegressionOptions) {
  const rows = await db.sendExecution.findMany({
    where: { organizationId: options.organization, kind: 'EXTENSION', action: 'POST', createdAt: { gte: options.since } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: options.limit + 1,
    select: { id: true, organizationId: true, sendIntentId: true, extensionNodeId: true, platform: true, action: true,
      status: true, createdAt: true, startedAt: true, lastProgressAt: true, leaseExpiresAt: true,
      fencingVersion: true, routeRevision: true, contentRevision: true, payload: true,
      intent: { select: { rootPostId: true, status: true, activeExecutionId: true, hasConfirmedSegments: true,
        routeRevision: true, contentRevision: true } },
      segments: { orderBy: { segmentIndex: 'asc' }, select: { segmentIndex: true, postId: true, contentHash: true,
        status: true, authorizedAt: true, submitBefore: true, confirmedAt: true, evidenceObservedAt: true,
        evidenceSessionRevision: true, result: true } },
      outcomeEvents: { orderBy: { createdAt: 'asc' }, take: 20,
        select: { eventId: true, segmentIndex: true, createdAt: true, evidence: true } },
    },
  });
  const attempts = rows.slice(0, options.limit).map(summarizeRegressionAttempt);
  const nodes = await db.extensionNode.findMany({
    where: { organizationId: options.organization, id: { in: [...new Set(rows.slice(0, options.limit).flatMap(r => r.extensionNodeId ? [r.extensionNodeId] : []))] } },
    select: { id: true, browser: true, extensionVersion: true, lastSeenAt: true, status: true }, take: options.limit,
  });
  const counts: Record<string, number> = {};
  for (const a of attempts) {
    const key = [a.platform, a.status, ...a.segments.map(s => `${s.status}:${s.evidence.phase ?? '-'}:${s.evidence.code ?? (s.evidence.workerRestarted ? 'WORKER_RESTARTED' : '-')}`)].join('/');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { generatedAt: new Date().toISOString(), organizationId: options.organization, since: options.since,
    truncated: rows.length > options.limit, note: 'Read-only snapshot. Node version is registration metadata, not execution-time version. Permits and SUBMITTING do not prove native dispatch. Historical execution owners may differ after retry.',
    counts, nodes, attempts };
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: TS_NODE_COMPILER_OPTIONS=\'{"module":"CommonJS"}\' node --no-experimental-strip-types -r ts-node/register/transpile-only scripts/diagnose-publish-regression.ts --organization ID [--since ISO_DATE] [--limit 200]');
    return;
  }
  const options = parseRegressionOptions(process.argv.slice(2));
  dotenv.config();
  assertDiagnosisDatabase(process.env.DATABASE_URL);
  const target = new URL(process.env.DATABASE_URL!);
  target.searchParams.set('connect_timeout', '5');
  target.searchParams.set('pool_timeout', '5');
  const db = new PrismaClient({ datasourceUrl: target.href });
  try { console.log(JSON.stringify(await diagnosePublishRegression(db, options), null, 2)); }
  finally { await db.$disconnect(); }
}
if (typeof require !== 'undefined' && require.main === module) void main().catch(() => {
  console.error('Read-only publishing diagnosis failed. Check scope, schema, database target, and connectivity.');
  process.exitCode = 1;
});

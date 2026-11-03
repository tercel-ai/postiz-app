/**
 * Read-only quota diagnosis using the same resolver and historical baseline as /start.
 * Usage from postiz-app:
 * REDIS_URL='' TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' node --no-experimental-strip-types -r ts-node/register/transpile-only -r tsconfig-paths/register scripts/diagnose-send-quota.ts ATTEMPT_ID
 */
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import { SendQuotaService } from '../libraries/nestjs-libraries/src/extension/send-quota.service';
import { assertDiagnosisDatabase } from './diagnose-send-attempts';

export async function diagnoseSendQuota(db: PrismaClient, attemptId: string) {
  const execution = await db.sendExecution.findUnique({ where: { id: attemptId }, include: { intent: true } });
  if (!execution) throw new Error('Attempt not found');
  const account = await db.accountWriteState.findUnique({ where: {
    organizationId_canonicalAccountKey: { organizationId: execution.organizationId, canonicalAccountKey: execution.canonicalAccountKey },
  } });
  if (!account) throw new Error('Account write state not found');
  const service = new SendQuotaService();
  const evaluatedAt = execution.createdAt;
  // resolve and baseline perform ORM reads only. Never call reserve/settle here.
  const plan = await service.resolve(db as any, execution.intent, account, 0, evaluatedAt);
  const budgets = [];
  for (const budget of plan.budgets) {
    const bucket = await db.sendQuotaBucket.findUnique({ where: { id: budget.key } });
    // Reuse the read-only baseline, including autonomous history, without creating a bucket.
    const usage = bucket ?? await service['baseline'](db as any, execution.organizationId, budget);
    const held = bucket ? await db.sendQuotaReservation.findMany({
      where: { bucketId: bucket.id, organizationId: execution.organizationId, state: 'HELD' },
      take: 100, orderBy: { createdAt: 'asc' },
      select: { executionId: true, segmentIndex: true, units: true, createdAt: true,
        execution: { select: { status: true, segments: { select: { segmentIndex: true, status: true, authorizedAt: true, submitBefore: true, result: true } } } } },
    }) : [];
    budgets.push({
      holds: held.map(row => ({ executionId: row.executionId, segmentIndex: row.segmentIndex, units: row.units,
        createdAt: row.createdAt, executionStatus: row.execution.status,
        segment: (() => {
          const segment = row.execution.segments.find(segment => segment.segmentIndex === row.segmentIndex);
          if (!segment) return null;
          const { result, ...state } = segment;
          const evidence = (result as { evidence?: unknown } | null)?.evidence;
          const phase = typeof evidence === 'string' ? evidence.match(/Phase: ([A-Z_]+)/)?.[1] : undefined;
          const code = typeof evidence === 'string' ? evidence.match(/code: ([A-Z_0-9]+)/)?.[1] : undefined;
          return { ...state, phase, code };
        })() })),
      scope: budget.scope, dimension: budget.dimension, limit: budget.limit,
      enforced: budget.enforce !== false, confirmedUnits: usage.confirmedUnits, heldUnits: usage.heldUnits,
      requestedUnits: budget.units, exhausted: budget.enforce !== false && usage.confirmedUnits + usage.heldUnits + budget.units > budget.limit,
      windowStart: budget.windowStart, windowEnd: budget.windowEnd, timezone: budget.timezone,
      source: bucket ? 'LEDGER' : 'HISTORICAL_BASELINE',
    });
  }
  return { attemptId, organizationId: execution.organizationId, platform: execution.platform, action: execution.action,
    status: execution.status, sendOrigin: execution.intent.sendOrigin, evaluatedAt,
    account: { timezone: account.timezone, dailyWriteLimit: account.dailyWriteLimit, firstConfirmedAt: account.firstConfirmedAt }, budgets,
    note: 'Current counters and policies evaluated in the attempt creation window; no quota was reserved or changed.' };
}

async function main() {
  const attemptId = process.argv[2];
  if (!attemptId) throw new Error('Attempt ID is required');
  dotenv.config();
  assertDiagnosisDatabase(process.env.DATABASE_URL);
  const db = new PrismaClient();
  try { console.log(JSON.stringify(await diagnoseSendQuota(db, attemptId), null, 2)); }
  finally { await db.$disconnect(); }
}
if (require.main === module) void main().catch(error => {
  console.error('Quota diagnosis failed:', error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : 'Check attempt ID, database configuration, and connectivity');
  process.exitCode = 1;
});

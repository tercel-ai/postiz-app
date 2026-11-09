/**
 * Read-only diagnosis of a user's Dev.to reply attempts and project quotas.
 * Run from postiz-app:
 * REDIS_URL='' pnpm exec ts-node --project scripts/tsconfig.json scripts/diagnose-devto-reply-quota.ts USER_ID YYYY-MM-DD [PROJECT_ID]
 * The date is UTC. The output excludes credentials, reply text, and raw evidence.
 */
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import { diagnoseSendQuota } from './diagnose-send-quota';
import { summarizeSendEvidence } from './diagnose-send-attempts';
import { databaseNameFromUrl } from './lib/database-url';

const MAX_ATTEMPTS = 20;

type ReplyPlanPolicy = {
  platform?: string;
  enabled?: boolean;
  dailyTargets?: { date: string; target: number }[];
  targetRepliesPerDay?: number;
  dailyHardCap?: number;
  hardCapRepliesPerDay?: number;
};

export async function diagnoseDevtoReplyQuota(db: PrismaClient, userId: string, day: string, projectId?: string) {
  const since = new Date(day + 'T00:00:00.000Z');
  if (!userId || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(since.getTime()) || since.toISOString().slice(0, 10) !== day)
    throw new Error('Expected a user ID and a valid UTC date (YYYY-MM-DD)');
  const until = new Date(since.getTime() + 86_400_000);
  const nodes = await db.extensionNode.findMany({
    where: { registeredByUserId: userId },
    select: { id: true },
  });
  const executions = await db.sendExecution.findMany({
    where: {
      platform: 'devto', action: 'REPLY', projectId, createdAt: { gte: since, lt: until },
      OR: [
        { extensionNodeId: { in: nodes.map(node => node.id) } },
        { intent: { policySnapshot: { path: ['policyOwnerUserId'], equals: userId } } },
      ],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_ATTEMPTS + 1,
    select: {
      id: true, organizationId: true, projectId: true, status: true, createdAt: true,
      intent: { select: {
        sendOrigin: true,
        rootPost: { select: { state: true, engageSentReply: { select: { id: true } } } },
      } },
      segments: { where: { segmentIndex: 0 }, select: {
        status: true, authorizedAt: true, confirmedAt: true, result: true,
      } },
    },
  });

  const attempts = [];
  for (const execution of executions.slice(0, MAX_ATTEMPTS)) {
    const plan = await db.operationPlan.findFirst({
      where: {
        organizationId: execution.organizationId, projectId: execution.projectId, status: 'READY',
        startsAt: { lte: since }, endsAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, startsAt: true, endsAt: true, planPayload: true },
    });
    const payload = plan?.planPayload as { engagePolicies?: ReplyPlanPolicy[] } | undefined;
    const policy = payload?.engagePolicies?.find(row => row.platform === 'devto' && row.enabled === true);
    const { intent, segments, ...attempt } = execution;
    const root = segments[0];
    let quota: Awaited<ReturnType<typeof diagnoseSendQuota>> | undefined;
    let quotaEvaluationError: string | undefined;
    try {
      quota = await diagnoseSendQuota(db, execution.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      quotaEvaluationError = /^[A-Z][A-Z0-9_]{2,95}$/.test(message) ? message : 'QUOTA_EVALUATION_UNAVAILABLE';
    }
    attempts.push({
      ...attempt,
      sendOrigin: intent.sendOrigin,
      replyId: intent.rootPost.engageSentReply?.id,
      postState: intent.rootPost.state,
      segment: root ? {
        status: root.status, authorizedAt: root.authorizedAt, confirmedAt: root.confirmedAt,
        evidence: summarizeSendEvidence(root.result),
      } : null,
      plan: plan ? {
        id: plan.id, startsAt: plan.startsAt, endsAt: plan.endsAt,
        dailyTarget: policy?.dailyTargets?.find(row => row.date === day)?.target ?? null,
        defaultTarget: policy?.targetRepliesPerDay ?? null,
        hardCap: policy?.dailyHardCap ?? policy?.hardCapRepliesPerDay ?? null,
      } : null,
      budgets: quota?.budgets,
      quotaEvaluationError,
    });
  }
  return {
    userId, day, projectId, truncated: executions.length > MAX_ATTEMPTS, attempts,
    note: 'Plans and counters are current snapshots evaluated for the attempt day. Exhaustion is evaluated against current counters, which may include the attempt itself.',
  };
}

async function main() {
  const [userId, day, projectId] = process.argv.slice(2);
  if (!userId || !day || userId === '--help') {
    console.log('Usage: diagnose-devto-reply-quota.ts USER_ID YYYY-MM-DD [PROJECT_ID]');
    process.exitCode = userId === '--help' ? 0 : 1;
    return;
  }
  dotenv.config({ quiet: true });
  if (databaseNameFromUrl(process.env.DATABASE_URL) !== 'aisee_postiz_dev') {
    console.error('DATABASE_URL must target aisee_postiz_dev');
    process.exitCode = 1;
    return;
  }
  const db = new PrismaClient();
  try {
    console.log(JSON.stringify(await diagnoseDevtoReplyQuota(db, userId, day, projectId), null, 2));
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) void main().catch(() => {
  console.error('Dev.to reply quota diagnosis failed. Check the user ID, UTC date, and database connection.');
  process.exitCode = 1;
});

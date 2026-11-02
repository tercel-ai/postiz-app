/**
 * Read-only diagnosis of extension attempts that never acquired a send permit.
 * Run from postiz-app:
 *   node --experimental-strip-types scripts/diagnose-send-attempts.ts --help
 * No tokens, content, or raw platform evidence are printed. No repair is performed.
 */
import { basename } from 'node:path';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

export interface DiagnosisOptions {
  attempt?: string;
  organization?: string;
  cursor?: string;
  limit: number;
}

export function parseOptions(args: string[]): DiagnosisOptions {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!['--attempt', '--organization', '--cursor', '--limit'].includes(key) || !value || value.startsWith('--'))
      throw new Error('Expected --attempt ID, --organization ID, --cursor ID, or --limit NUMBER');
    values[key] = value;
  }
  const limit = Number(values['--limit'] ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Limit must be an integer from 1 to 1000');
  return { attempt: values['--attempt'], organization: values['--organization'], cursor: values['--cursor'], limit };
}

export function assertDiagnosisDatabase(databaseUrl: string | undefined) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const database = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (database !== 'aisee_postiz_dev') throw new Error('Diagnosis requires database aisee_postiz_dev; check DATABASE_URL');
}

export async function diagnoseSendAttempts(db: PrismaClient, options: DiagnosisOptions) {
  const attempts = await db.sendExecution.findMany({
    where: {
      kind: 'EXTENSION',
      ...(options.attempt ? { id: options.attempt } : { segments: { some: {
        status: 'PENDING', permitHash: null, authorizedAt: null, submitBefore: null,
      } } }),
      ...(options.organization ? { organizationId: options.organization } : {}),
    },
    orderBy: { id: 'asc' }, take: options.limit,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: {
      id: true, organizationId: true, extensionNodeId: true, integrationId: true,
      platform: true, action: true, status: true, createdAt: true, leaseExpiresAt: true,
      intent: { select: { rootPostId: true, status: true, activeExecutionId: true } },
      segments: { orderBy: { segmentIndex: 'asc' }, select: {
        segmentIndex: true, status: true, authorizedAt: true, submitBefore: true,
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
  return {
    note: 'Database state only. Compare with the original node journal before confirming a stop. No records were changed.',
    nextCursor: attempts.length === options.limit ? attempts.at(-1)!.id : null,
    attempts: attempts.map(attempt => ({
      ...attempt,
      account: accounts.find(account => account.id === attempt.integrationId) ?? null,
      root: roots.find(root => root.id === attempt.intent.rootPostId) ?? null,
    })),
  };
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node --experimental-strip-types scripts/diagnose-send-attempts.ts [--attempt ID] [--organization ID] [--cursor ID] [--limit 100]');
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

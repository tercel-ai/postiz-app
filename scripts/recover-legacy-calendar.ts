/** Service-based archival: prepare a review plan, then apply it with explicit stop evidence. */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { userInfo, hostname } from 'node:os';
import { recoveryDatabase } from './lib/recovery-database';

export const TARGET_ORG = 'b4314faf-59f8-48e3-a25c-145221e78239';
export const TARGET_POSTS = [
  'cmmx3xtrr0001qm9v1xe367c2', 'cmtjwxswz0003qma4zktadhdr',
  'cmtjy4sff0001qmtwdqu3e98x', 'cmtjy7l8s0005qmtwqgdmyfiv', 'cmtl6v2ku000uqm38heofs35v',
];
type Review = {
  organizationId: string; actorKey: string; postId: string; recoveryRevision: string;
  canResolve: boolean; reasons: string[]; action: string; postIds: string[];
  posts: Array<{ id: string; state: string; platform: string | null; parentPostId: string | null;
    deleted: boolean; claimPresent: boolean; publicationEvidencePresent: boolean; captured: boolean }>;
  receipts: Array<{ id: string; status: string; revision: number }>;
};
type Plan = { version: 3; databaseFingerprint: string; organizationId: string; actorKey: string; reviews: Review[] };
type Journal = { version: 1; plan: Plan; operations: Array<{ postId: string; body: Record<string, unknown>; result?: unknown }> };
export type RecoveryService = {
  state(): Promise<{ organizationId: string; actorKey: string; mode: string; configuredMode: string | null; systemEnabled?: boolean; canManage: boolean }>;
  inspect(id: string): Promise<Review>;
  archive(id: string, body: Record<string, unknown>): Promise<{ resolved: boolean; organizationId: string; actorKey: string; postId: string; quarantinedPostIds: string[] }>;
};
export class RecoveryDiagnosticError extends Error {
  constructor(code: string, readonly details: Record<string, unknown>) { super(code); }
}
function assertRecoveryState(state: Awaited<ReturnType<RecoveryService['state']>>, actorKey?: string) {
  const details = { organizationId: state.organizationId, expectedOrganizationId: TARGET_ORG,
    mode: state.mode, configuredMode: state.configuredMode, systemEnabled: state.systemEnabled };
  if (state.organizationId !== TARGET_ORG) throw new RecoveryDiagnosticError('RECOVERY_ORGANIZATION_MISMATCH', details);
  // Archival does not send anything. A disabled sending capability must not prevent retiring old work.
  if (state.configuredMode !== 'CONTROLLED') throw new RecoveryDiagnosticError('ORGANIZATION_NOT_CONFIGURED_CONTROLLED', details);
  if (!state.canManage || !state.actorKey || (actorKey && state.actorKey !== actorKey))
    throw new RecoveryDiagnosticError('MAINTENANCE_CONTEXT_CHANGED', details);
}
const reviewShape = (r: Review) => JSON.stringify({ postId: r.postId, postIds: r.postIds,
  posts: r.posts, receipts: r.receipts, action: r.action, canResolve: r.canResolve, reasons: r.reasons });
function checkReview(r: Review, actorKey: string, postId: string) {
  if (r.organizationId !== TARGET_ORG || r.actorKey !== actorKey || r.postId !== postId ||
    r.action !== 'QUARANTINE_LEGACY_THREAD' || !/^[a-f0-9]{64}$/.test(r.recoveryRevision) ||
    !Array.isArray(r.postIds) || !r.postIds.includes(postId) || !Array.isArray(r.posts) || !Array.isArray(r.receipts) || !Array.isArray(r.reasons))
    throw new Error('INVALID_RECOVERY_REVIEW');
}
export async function preparePlan(databaseFingerprint: string, service: RecoveryService): Promise<Plan> {
  const mode = await service.state();
  assertRecoveryState(mode);
  const reviews: Review[] = [];
  for (const id of TARGET_POSTS) {
    const review = await service.inspect(id);
    checkReview(review, mode.actorKey, id);
    reviews.push(review);
  }
  return { version: 3, databaseFingerprint, organizationId: TARGET_ORG, actorKey: mode.actorKey, reviews };
}
export async function applyPlan(plan: Plan, journal: Journal, service: RecoveryService, evidence: string, persist: () => void) {
  if (plan.version !== 3 || plan.organizationId !== TARGET_ORG || plan.reviews.length !== TARGET_POSTS.length ||
    plan.reviews.some((r, i) => r.postId !== TARGET_POSTS[i]) || JSON.stringify(journal.plan) !== JSON.stringify(plan)) throw new Error('INVALID_OR_CHANGED_PLAN');
  if (!evidence.trim() || evidence.length > 2000) throw new Error('EVIDENCE_REQUIRED_MAX_2000');
  const reviewedIds = new Set<string>();
  for (const review of plan.reviews) {
    checkReview(review, plan.actorKey, review.postId);
    if (!review.canResolve || review.reasons.length) throw new Error(`REVIEW_BLOCKED:${review.postId}`);
    for (const id of review.postIds) {
      if (reviewedIds.has(id)) throw new Error('OVERLAPPING_THREAD_REVIEWS');
      reviewedIds.add(id);
    }
  }
  const mode = await service.state();
  assertRecoveryState(mode, plan.actorKey);
  for (const approved of plan.reviews) {
    checkReview(approved, plan.actorKey, approved.postId);
    if (!approved.canResolve || approved.reasons.length) throw new Error(`REVIEW_BLOCKED:${approved.postId}`);
    let operation = journal.operations.find(op => op.postId === approved.postId);
    if (operation?.result) continue;
    if (!operation) {
      const current = await service.inspect(approved.postId);
      checkReview(current, plan.actorKey, approved.postId);
      // Earlier archival changes the organization revision. Content and thread membership must still match the approved plan.
      if (reviewShape(current) !== reviewShape(approved)) throw new Error(`THREAD_CHANGED_PREPARE_NEW_PLAN:${approved.postId}`);
      operation = { postId: approved.postId, body: {
        expectedOrganizationId: plan.organizationId, expectedActorKey: plan.actorKey,
        requestId: randomUUID(), expectedRecoveryRevision: current.recoveryRevision,
        executorStopped: true, noPendingSubmit: true, evidence,
      } };
      journal.operations.push(operation);
      persist();
    }
    // A lost response reuses the persisted exact body and request ID, never a new write request.
    const result = await service.archive(approved.postId, operation.body);
    if (result.resolved !== true || result.organizationId !== plan.organizationId || result.actorKey !== plan.actorKey || result.postId !== approved.postId || !Array.isArray(result.quarantinedPostIds)) throw new Error('INVALID_RECOVERY_RESULT');
    operation.result = result;
    persist();
  }
  return service.state();
}
function atomicSave(file: string, data: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}
async function main() {
  const { values } = parseArgs({ options: {
    'organization-id': { type: 'string', default: TARGET_ORG },
    'database-verified': { type: 'boolean' },
    plan: { type: 'string', default: 'legacy-calendar-maintenance-plan.json' },
    apply: { type: 'boolean' }, 'executors-stopped': { type: 'boolean' },
    'no-pending-submit': { type: 'boolean' }, 'evidence-file': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Prepare: ts-node --project scripts/tsconfig.json scripts/recover-legacy-calendar.ts --database-verified');
    console.log('Apply reviewed plan: add --apply --executors-stopped --no-pending-submit --evidence-file file');
    console.log('Calls SendModeService directly; no token or backend deployment is required. Verify the actual database first.');
    return;
  }
  const actor = { kind: 'MAINTENANCE' as const, operator: userInfo().username, host: hostname() };
  if (values['organization-id'] !== TARGET_ORG) throw new Error('SCRIPT_IS_SCOPED_TO_TARGET_ORGANIZATION');
  const file = resolve(values.plan!);
  let evidence = '';
  if (values.apply) {
    if (!values['executors-stopped'] || !values['no-pending-submit'] || !values['evidence-file']) throw new Error('EXPLICIT_EXECUTOR_STOP_AND_NO_PENDING_SUBMIT_EVIDENCE_REQUIRED');
    if (!existsSync(file)) throw new RecoveryDiagnosticError('RECOVERY_PLAN_NOT_FOUND', { path: file, nextAction: 'Run without --apply to prepare the plan first.' });
    const evidencePath = resolve(values['evidence-file']);
    if (!existsSync(evidencePath)) throw new RecoveryDiagnosticError('EVIDENCE_FILE_NOT_FOUND', { path: evidencePath, nextAction: 'Write the actual executor-stop and no-pending-submit evidence to this file.' });
    evidence = readFileSync(evidencePath, 'utf8').trim();
    if (!evidence || evidence.length > 2000) throw new Error('EVIDENCE_REQUIRED_MAX_2000');
  }
  const connection = recoveryDatabase(values['database-verified']);
  console.log(JSON.stringify({ databaseTarget: connection.target, organizationId: TARGET_ORG }));
  const { PrismaClient } = await import('@prisma/client');
  const { SendModeService } = await import('@gitroom/nestjs-libraries/extension/send-mode.service');
  const db = new PrismaClient({ datasources: { db: { url: connection.url } }, log: [] });
  const modes = new SendModeService(db as any);
  const service: RecoveryService = {
    state: () => modes.getMaintenanceRecoveryState(TARGET_ORG, actor),
    inspect: id => modes.getMaintenancePostRecovery(TARGET_ORG, actor, id),
    archive: async (id, body) => await modes.resolveMaintenancePostRecovery(TARGET_ORG, actor, id, body as any) as any,
  };
  try {
    if (!values.apply) {
      if (existsSync(file)) throw new Error('PLAN_ALREADY_EXISTS_USE_A_NEW_PATH');
      const plan = await preparePlan(connection.fingerprint, service);
      writeFileSync(file, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      console.log(JSON.stringify({ planFile: file, organizationId: plan.organizationId, reviews: plan.reviews.map(r => ({ postId: r.postId, canResolve: r.canResolve, reasons: r.reasons, posts: r.posts })) }, null, 2));
      return;
    }
    const plan: Plan = JSON.parse(readFileSync(file, 'utf8'));
    if (plan.version !== 3 || plan.databaseFingerprint !== connection.fingerprint || plan.actorKey !== (await service.state()).actorKey) throw new Error('PLAN_DATABASE_OR_OPERATOR_CHANGED_PREPARE_NEW_PLAN');
    const journalFile = file + '.journal.json';
    let journal: Journal;
    if (existsSync(journalFile)) journal = JSON.parse(readFileSync(journalFile, 'utf8'));
    else {
      journal = { version: 1, plan, operations: [] };
      writeFileSync(journalFile, JSON.stringify(journal, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    }
    const mode = await applyPlan(plan, journal, service, evidence, () => atomicSave(journalFile, journal));
    console.log(JSON.stringify({ journalFile, completedThreads: journal.operations.filter(op => op.result).length, mode }, null, 2));
  } finally { await db.$disconnect(); }
}
export async function runCli() {
  try { await main(); }
  catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';
    const code = message.match(/^[A-Z][A-Z0-9_]{2,80}(?=:|$)/)?.[0] ?? 'SERVICE_OR_FILE_ERROR';
    console.error(`Recovery stopped: ${code}.`);
    if (error instanceof RecoveryDiagnosticError) console.error(JSON.stringify(error.details, null, 2));
    else console.error('Review the plan/journal. For an uncertain service result, keep the journal and replay the same apply command.');
    process.exitCode = 1;
  }
}
if (require.main === module) void runCli();

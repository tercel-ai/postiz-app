/**
 * Explicit, preview-first soft deletion of one reviewed duplicate social profile.
 * Historical records are never merged, reassigned or physically deleted.
 * Run manually; this script is never part of application startup or migrations.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { normalizeHandle } from '../libraries/nestjs-libraries/src/database/prisma/integrations/extension-session.utils';
import { assertAuditDatabase } from './audit-integration-profiles';

interface CleanupOptions {
  keep: string;
  remove: string;
  apply: boolean;
  json: boolean;
  help: boolean;
}

type ReadDatabase = Pick<Prisma.TransactionClient,
  'integration' | 'organizationSendBinding' | 'projectSendBinding' | 'post' |
  'sendIntent' | 'sendExecution' | 'accountWriteState' | 'sendQuotaReservation' |
  'integrationProject' | 'extensionNodeSession' | 'dataTicks' | 'postRelease' |
  'sendMutationReceipt'>;
type CleanupDatabase = ReadDatabase & Pick<PrismaClient, '$transaction'>;
const TERMINAL_STATUSES = ['SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'HANDED_OVER'];
const ACCOUNT_SELECT = {
  id: true, organizationId: true, providerIdentifier: true, type: true,
  name: true, profile: true, internalId: true, identityNamespace: true,
  disabled: true, deletedAt: true, updatedAt: true,
} as const;

async function unsettledEffects(
  db: ReadDatabase, scope: { organizationId: string; integrationId: string }
) {
  const ids: string[] = [];
  let after: string | undefined;
  for (;;) {
    const receipts = await db.sendMutationReceipt.findMany({
      where: { organizationId: scope.organizationId, operation: 'autonomous-side-effect',
        ...(after ? { id: { gt: after } } : {}) },
      select: { id: true, result: true }, orderBy: { id: 'asc' }, take: 500,
    });
    for (const receipt of receipts) {
      const result = receipt.result;
      if (!result || typeof result !== 'object' || Array.isArray(result) ||
          result.status === 'CONFIRMED' || result.status === 'NOT_SUBMITTED') continue;
      if (result.integrationId === scope.integrationId) {
        ids.push(receipt.id);
        continue;
      }
      // Browser admissions have a synthetic integration ID; their posts carry
      // the real account reference. Deleted posts can still have pending effects.
      const postIds = Array.isArray(result.postIds)
        ? result.postIds.filter((id): id is string => typeof id === 'string') : [];
      if (typeof result.targetPostId === 'string') postIds.push(result.targetPostId);
      if (postIds.length && await db.post.count({
        where: { ...scope, id: { in: postIds } },
      })) ids.push(receipt.id);
    }
    if (receipts.length < 500) return ids;
    after = receipts[receipts.length - 1].id;
  }
}

export function parseCleanupOptions(argv: string[]): CleanupOptions {
  const options: CleanupOptions = { keep: '', remove: '', apply: false, json: false, help: false };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
    seen.add(flag);
    if (flag === '--apply') options.apply = true;
    else if (flag === '--json') options.json = true;
    else if (flag === '--help') options.help = true;
    else if (flag === '--keep' || flag === '--remove') {
      const value = argv[++i]?.trim();
      if (!value || value.startsWith('--')) throw new Error(`A value is required for ${flag}`);
      options[flag === '--keep' ? 'keep' : 'remove'] = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if (!options.help && (!options.keep || !options.remove || options.keep === options.remove)) {
    throw new Error('Provide distinct --keep and --remove account IDs. No automatic survivor selection is supported.');
  }
  return options;
}

export async function previewDuplicateCleanup(
  db: ReadDatabase, options: Pick<CleanupOptions, 'keep' | 'remove'>, now = new Date()
) {
  if (!options.keep || !options.remove || options.keep === options.remove) {
    throw new Error('Provide distinct keep and remove account IDs.');
  }
  const rows = await db.integration.findMany({
    where: { id: { in: [options.keep, options.remove] } }, select: ACCOUNT_SELECT,
    orderBy: { id: 'asc' },
  });
  const keep = rows.find(row => row.id === options.keep);
  const remove = rows.find(row => row.id === options.remove);
  if (!keep || !remove) throw new Error('Both explicit account IDs must exist.');
  const profile = normalizeHandle(keep.profile ?? '');
  if (keep.deletedAt || keep.type !== 'social' || remove.type !== 'social' ||
    keep.organizationId !== remove.organizationId ||
    keep.providerIdentifier !== remove.providerIdentifier || !profile ||
    profile !== normalizeHandle(remove.profile ?? '')) {
    throw new Error('Accounts must be social accounts with the same organization, provider and nonempty normalized profile; the retained account must not be deleted.');
  }
  const scope = { organizationId: remove.organizationId, integrationId: remove.id };
  const livePostWhere = { ...scope, deletedAt: null, state: { not: 'PUBLISHED' as const } };
  const [organizationDefaults, projectDefaults, livePosts, liveIntents, liveExecutions,
    activeAccountWriters, heldQuotaReservations, projectAssignments, terminalSessions,
    historicalPosts, metrics, releaseHistory, unsettledAutonomousEffectIds, blockingPosts] = await Promise.all([
    db.organizationSendBinding.count({ where: scope }),
    db.projectSendBinding.count({ where: scope }),
    // Draft/error posts may be scheduled or retried later; preserve their account choice.
    db.post.count({ where: livePostWhere }),
    db.sendIntent.count({ where: { ...scope, OR: [
      { status: { notIn: TERMINAL_STATUSES } }, { activeExecutionId: { not: null } },
    ] } }),
    // Unknown/new statuses fail closed until reviewed for cleanup safety.
    db.sendExecution.count({ where: { ...scope, status: { notIn: TERMINAL_STATUSES } } }),
    db.accountWriteState.count({ where: {
      organizationId: remove.organizationId,
      OR: [{ integrationId: remove.id }, { identityIntegrationIds: { has: remove.id } }],
      AND: [{ OR: [{ activeExecutionId: { not: null } }, { nextWriteNotBefore: { gt: now } }] }],
    } }),
    db.sendQuotaReservation.count({ where: { organizationId: remove.organizationId,
      state: 'HELD', execution: { integrationId: remove.id } } }),
    db.integrationProject.count({ where: scope }),
    db.extensionNodeSession.count({ where: scope }),
    db.post.count({ where: { ...scope, OR: [{ state: 'PUBLISHED' }, { deletedAt: { not: null } }] } }),
    db.dataTicks.count({ where: { integrationId: remove.id } }),
    db.postRelease.count({ where: { integrationId: remove.id } }),
    unsettledEffects(db, scope),
    db.post.findMany({
      where: livePostWhere,
      select: { id: true, state: true, projectId: true, publishDate: true, title: true, sendIntentId: true },
      orderBy: { id: 'asc' }, take: 20,
    }),
  ]);
  const blockers = { organizationDefaults, projectDefaults, livePosts, liveIntents,
    liveExecutions, activeAccountWriters, heldQuotaReservations,
    unsettledAutonomousEffects: unsettledAutonomousEffectIds.length };
  const alreadyDeleted = Boolean(remove.deletedAt);
  return {
    keep, remove, normalizedProfile: profile, alreadyDeleted, unsettledAutonomousEffectIds,
    blockingPosts, blockingPostsTruncated: livePosts > blockingPosts.length,
    canApply: !alreadyDeleted && Object.values(blockers).every(count => count === 0),
    blockers,
    preservedReferences: { projectAssignments, terminalSessions, historicalPosts, metrics, releaseHistory },
    actions: alreadyDeleted ? [] : [{ integrationId: remove.id, disabled: true, deletedAt: 'application time' }],
    warning: 'Profile equality is not proof of shared platform identity. Explicit keep/remove IDs are the operator review decision. References stay attached to their original account IDs.',
  };
}

export async function cleanupDuplicate(
  db: CleanupDatabase, options: Pick<CleanupOptions, 'keep' | 'remove' | 'apply'>,
  onPreview?: (report: Awaited<ReturnType<typeof previewDuplicateCleanup>>) => void
) {
  const preview = await previewDuplicateCleanup(db, options);
  const accountSnapshot = JSON.stringify([preview.keep, preview.remove]);
  onPreview?.(preview);
  if (!options.apply || !preview.canApply) return { preview, applied: false };
  await db.$transaction(async tx => {
    const fresh = await previewDuplicateCleanup(tx, options);
    if (!fresh.canApply || JSON.stringify([fresh.keep, fresh.remove]) !== accountSnapshot) {
      throw new Error('Account data changed or cleanup is now blocked. Review a fresh preview.');
    }
    const updated = await tx.integration.updateMany({
      where: { id: preview.remove.id, organizationId: preview.remove.organizationId,
        providerIdentifier: preview.remove.providerIdentifier, type: 'social',
        profile: preview.remove.profile, internalId: preview.remove.internalId,
        identityNamespace: preview.remove.identityNamespace,
        updatedAt: preview.remove.updatedAt, deletedAt: null },
      data: { deletedAt: new Date(), disabled: true },
    });
    if (updated.count !== 1) throw new Error('Account changed during cleanup; no changes were committed.');
  }, { isolationLevel: 'Serializable' });
  return { preview, applied: true };
}

async function main() {
  const options = parseCleanupOptions(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: pnpm exec ts-node --project scripts/tsconfig.json scripts/cleanup-integration-profile-duplicates.ts --keep <id> --remove <id> [--apply] [--json]

Default: preview only. --apply soft-deletes and disables only the explicit remove row.
No tokens are read. No history is deleted, reassigned or merged. No bindings are cleared.
Any defaults, live sends, unresolved autonomous effects, held quota or active account writers block application.
Project assignments and terminal sessions remain attached to the deleted record.
DATABASE_URL must point to aisee_postiz_dev. Stop publishing while performing maintenance.
Run the preview first and confirm the retained account and references before --apply.
Exit codes: 0 = preview allowed/applied/already deleted; 2 = blocked; 1 = failure.`);
    return;
  }
  const dotenv = await import('dotenv');
  dotenv.config();
  const databaseUrl = process.env.DATABASE_URL;
  const database = assertAuditDatabase(databaseUrl);
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const result = await cleanupDuplicate(db, options, preview => {
      // Always emit exact proposed actions and blockers before the transaction.
      console.log(JSON.stringify({ phase: 'preview', database, ...preview }, null, 2));
    });
    console.log(options.json
      ? JSON.stringify({ phase: 'result', database, applied: result.applied,
        alreadyDeleted: result.preview.alreadyDeleted, blocked: !result.preview.canApply && !result.preview.alreadyDeleted })
      : result.applied ? 'Duplicate account soft-deleted and disabled. All references were preserved.'
      : result.preview.alreadyDeleted ? 'Account already deleted. No changes made.'
      : result.preview.canApply ? 'Preview only. No changes made. Review before rerunning with --apply.'
      : 'Cleanup blocked by references. Review and resolve them through the application; no changes made.');
    process.exitCode = !result.preview.canApply && !result.preview.alreadyDeleted ? 2 : 0;
  } catch {
    // Prisma diagnostics may include credentials; only emit a fixed safe message.
    throw new Error('Duplicate cleanup failed or account data changed. No cleanup transaction was committed. Check access, schema and a fresh preview.');
  } finally {
    await db.$disconnect();
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
}

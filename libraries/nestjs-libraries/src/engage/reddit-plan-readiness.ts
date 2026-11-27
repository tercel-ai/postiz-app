import { canChangePostAccount } from '../extension/send-account-change';
import { ConflictException } from '@nestjs/common';
import type { Post, Prisma } from '@prisma/client';
import {
  applyResolvedRedditTarget,
  clearRedditPlanSchedulePending,
  hasSavedRedditFlairSelection,
  hasLegacyRedditFlairResolution,
  readRedditTargetPending,
  readSavedRedditFlairTemplateId,
  readSavedRedditSubreddit,
  readSavedRedditTitle,
  readTriedRedditFlairRevision,
  REDDIT_TARGET_PENDING_KEY,
} from './reddit-pending-target';
import { normalizeSubreddit } from '../database/prisma/operation-plan/reddit-target-resolver';

type RedditPlanBlock = 'REDDIT_TARGET_PENDING' | 'REDDIT_FLAIR_REQUIRED';

/** Same unsent-content boundary for target resolution and catalog-driven restaging. */
export function unresolvedRedditPostWhere(organizationId: string): Prisma.PostWhereInput {
  return {
    organizationId,
    deletedAt: null,
    providerIdentifier: 'reddit',
    state: { in: ['DRAFT', 'QUEUE'] },
    sendIntentId: null,
    claimedAt: null,
    releaseId: null,
    releaseURL: null,
  };
}

function requiresFlair(target: { flairRequired?: unknown; is_flair_required?: unknown } | undefined): boolean {
  return target?.flairRequired === true || target?.is_flair_required === true;
}

function hasRequiredRedditFlair(settings: string | null): boolean {
  if (!settings) return false;
  try {
    return requiresFlair(JSON.parse(settings)?.subreddit?.[0]?.value);
  } catch {
    return false;
  }
}

export function redditPlanScheduleBlock(post: {
  providerIdentifier?: string | null;
  settings?: string | null;
}): RedditPlanBlock | undefined {
  if (post.providerIdentifier?.toLowerCase() !== 'reddit' || !post.settings) return;
  try {
    const settings = JSON.parse(post.settings);
    if (settings?.[REDDIT_TARGET_PENDING_KEY]) return 'REDDIT_TARGET_PENDING';
    const target = settings?.subreddit?.[0]?.value;
    if (!requiresFlair(target)) return;
    if (!hasSavedRedditFlairSelection(post.settings)) return 'REDDIT_FLAIR_REQUIRED';
  } catch {
    // Existing scheduling validation owns malformed settings outside this feature.
  }
}

/** A user-chosen community replaces the old plan target and needs its own observation. */
export function prepareRedditPlanEdit(previous: string | null, requested: string): string {
  requested = clearRedditPlanSchedulePending(requested);
  const priorPending = readRedditTargetPending(previous);
  const oldSubreddit = normalizeSubreddit(readSavedRedditSubreddit(previous));
  const subreddit = normalizeSubreddit(readSavedRedditSubreddit(requested));
  const changesCommunity = !!subreddit && subreddit !== oldSubreddit;
  const templateId = readSavedRedditFlairTemplateId(requested);
  // The native editor resets restrictions when it changes the destination. A
  // different explicit template ID may have been chosen for the new community.
  const selectedForNewCommunity = templateId && templateId !== readSavedRedditFlairTemplateId(previous);
  if (subreddit && changesCommunity && !selectedForNewCommunity) {
    const title = readSavedRedditTitle(requested) ?? priorPending?.title ?? '';
    const changed = applyResolvedRedditTarget(requested, { subreddit, title, type: 'self' }, {
      candidate: subreddit, title, reason: 'flair-pending', selectFlair: true, since: new Date().toISOString(),
    });
    return hasLegacyRedditFlairResolution(previous)
      ? JSON.stringify({ ...JSON.parse(changed), redditLegacyFlairResolution: true }) : changed;
  }
  const settings = JSON.parse(requested);
  if (hasLegacyRedditFlairResolution(previous)) settings.redditLegacyFlairResolution = true;
  const target = settings?.subreddit?.[0]?.value;
  const selected = !!subreddit && hasSavedRedditFlairSelection(requested);
  if (selected) {
    delete settings[REDDIT_TARGET_PENDING_KEY];
    delete target.flairOptionsRevision;
  } else if (priorPending) {
    settings[REDDIT_TARGET_PENDING_KEY] = priorPending;
  }
  if (target && !changesCommunity && hasRequiredRedditFlair(previous)) {
    target.flairRequired = true;
    const tried = selected ? undefined : readTriedRedditFlairRevision(previous);
    if (tried) target.flairOptionsRevision = tried;
  }
  return JSON.stringify(settings);
}

/** Reuse the normal pending marker on a draft still missing a required selection. */
export function restageRedditFlairAfterCatalogChange(
  settings: string | null,
  subreddit: string,
  optionsRevision: string,
  observedAt: string
): string | undefined {
  const title = readSavedRedditTitle(settings);
  if (!settings || !title ||
      normalizeSubreddit(readSavedRedditSubreddit(settings)) !== subreddit ||
      redditPlanScheduleBlock({ providerIdentifier: 'reddit', settings }) !== 'REDDIT_FLAIR_REQUIRED' ||
      readTriedRedditFlairRevision(settings) === optionsRevision) return undefined;
  return JSON.stringify({
    ...JSON.parse(settings),
    [REDDIT_TARGET_PENDING_KEY]: {
      candidate: subreddit,
      title,
      reason: 'flair-pending',
      selectFlair: true,
      flairCatalogRetry: true,
      flairRequired: true,
      since: observedAt,
    },
  });
}


/** A fixed-community Plan post that still needs its first verified Flair observation. */
export function legacyRedditFlairNeedsResolution(root: Pick<Post, 'providerIdentifier' | 'operationPlanId' | 'projectId' | 'parentPostId' | 'state' | 'releaseURL' | 'settings'>): boolean {
  return root.providerIdentifier === 'reddit' && !!root.operationPlanId && !!root.projectId &&
    !root.parentPostId && root.state === 'QUEUE' && !root.releaseURL &&
    !hasLegacyRedditFlairResolution(root.settings) && !readRedditTargetPending(root.settings) &&
    !hasSavedRedditFlairSelection(root.settings) && !!normalizeSubreddit(readSavedRedditSubreddit(root.settings)) &&
    !!readSavedRedditTitle(root.settings);
}

/** Park only legacy plan work with evidence excluding a previous submission. */
export async function stageLegacyRedditFlairIn(tx: Prisma.TransactionClient, root: Post, reviewedUserId?: string): Promise<boolean> {
  const reviewedFailure = !!reviewedUserId && root.state === 'ERROR';
  if (!legacyRedditFlairNeedsResolution(reviewedFailure ? { ...root, state: 'QUEUE' } : root)) return false;
  const subreddit = normalizeSubreddit(readSavedRedditSubreddit(root.settings))!;
  const title = readSavedRedditTitle(root.settings)!;
  const rows = await tx.post.findMany({ where: { organizationId: root.organizationId, group: root.group, deletedAt: null } });
  if (!rows.some(row => row.id === root.id) || rows.some(row => row.state !== root.state ||
      row.providerIdentifier !== 'reddit' || row.operationPlanId !== root.operationPlanId || row.projectId !== root.projectId ||
      row.sendIntentId !== root.sendIntentId || row.releaseURL ||
      (row.id !== root.id && (row.claimedAt || row.releaseId)) ||
      hasSavedRedditFlairSelection(row.settings) || hasLegacyRedditFlairResolution(row.settings) || readRedditTargetPending(row.settings) ||
      normalizeSubreddit(readSavedRedditSubreddit(row.settings)) !== subreddit)) return false;
  if (root.sendIntentId && (root.claimedAt || root.releaseId)) return false;
  if (root.sendIntentId) {
    const intent = await tx.sendIntent.findFirst({ where: { id: root.sendIntentId, organizationId: root.organizationId,
      rootPostId: root.id, platform: 'reddit', action: 'POST', status: 'QUEUED', activeExecutionId: null, hasConfirmedSegments: false } });
    if (!intent || rows.some(row => row.routeRevision !== root.routeRevision || row.contentRevision !== root.contentRevision)) return false;
    const executions = await tx.sendExecution.findMany({ where: { organizationId: root.organizationId, sendIntentId: intent.id } });
    const segments = executions.length ? await tx.sendSegment.findMany({ where: {
      organizationId: root.organizationId, executionId: { in: executions.map(execution => execution.id) },
    } }) : [];
    if (!canChangePostAccount(root, intent, executions, segments)) return false;
  }
  const ids = new Set(rows.map(row => row.id));
  const receipts = await tx.sendMutationReceipt.findMany({ where: { organizationId: root.organizationId, operation: 'autonomous-side-effect' }, select: { result: true, userId: true } });
  const related = receipts.map(receipt => ({ userId: receipt.userId, result: receipt.result as {
    status?: string; source?: string; action?: string; platform?: string; postIds?: unknown;
    postClaim?: { releaseId?: string; claimedAt?: string };
  } | null }));
  if (related.some(({ result }) => !result || typeof result !== 'object')) return false;
  const relevant = related.filter(({ result }) => Array.isArray(result?.postIds) &&
    result.postIds.some(id => typeof id === 'string' && ids.has(id)));
  if (root.claimedAt || root.releaseId) {
    if (!root.claimedAt || (!root.releaseId && !reviewedUserId) || !relevant.length || relevant.some(({ result, userId }) =>
      result!.status !== 'NOT_SUBMITTED' || result!.source !== 'BROWSER' || result!.action !== 'POST' ||
      result!.platform !== 'reddit' || !Array.isArray(result!.postIds) || result!.postIds.length !== 1 ||
      result!.postIds[0] !== root.id || (reviewedUserId && (userId !== reviewedUserId ||
        (result as { browserUserId?: string }).browserUserId !== reviewedUserId)) ||
      (result!.postClaim ? (root.releaseId ? result!.postClaim.releaseId !== root.releaseId : !reviewedUserId) ||
        Date.parse(result!.postClaim.claimedAt ?? '') !== root.claimedAt!.getTime() : !reviewedUserId))) return false;
  } else if (relevant.length) return false;
  for (const row of rows.sort((a, b) => a.id.localeCompare(b.id))) {
    const settings = JSON.parse(row.settings!);
    settings.redditLegacyFlairResolution = true;
    settings[REDDIT_TARGET_PENDING_KEY] = { candidate: subreddit, title: readSavedRedditTitle(row.settings) ?? title,
      reason: 'flair-pending', selectFlair: true, since: new Date().toISOString() };
    const changed = await tx.post.updateMany({ where: { id: row.id, organizationId: root.organizationId,
      state: row.state, settings: row.settings, sendIntentId: row.sendIntentId, claimedAt: row.claimedAt, releaseId: row.releaseId, releaseURL: null,
      routeRevision: row.routeRevision, contentRevision: row.contentRevision }, data: {
        settings: JSON.stringify(settings), ...(reviewedFailure ? { state: 'DRAFT' } : {}), ...(row.releaseId ? { releaseId: null } : {}) } });
    if (changed.count !== 1) throw new ConflictException('REDDIT_FLAIR_STAGING_CHANGED');
  }
  return true;
}

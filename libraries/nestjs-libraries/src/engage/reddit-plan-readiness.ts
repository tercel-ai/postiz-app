import type { Prisma } from '@prisma/client';
import {
  applyResolvedRedditTarget,
  clearRedditPlanSchedulePending,
  hasSavedRedditFlairSelection,
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
    return applyResolvedRedditTarget(requested, { subreddit, title, type: 'self' }, {
      candidate: subreddit, title, reason: 'flair-pending', selectFlair: true, since: new Date().toISOString(),
    });
  }
  const settings = JSON.parse(requested);
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

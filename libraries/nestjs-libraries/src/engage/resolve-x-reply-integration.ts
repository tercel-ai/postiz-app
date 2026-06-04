/**
 * Resolve which connected X Integration should own a manual engage reply.
 *
 * Policy: attach an integration ONLY when the reply URL's author handle matches a
 * live X account connected to the org — i.e. the reply was genuinely posted by an
 * account we manage. In that case Post.integrationId honestly identifies the
 * author and its OAuth token can read the tweet's metrics.
 *
 * When the handle does NOT match any connected account (the reply was posted from
 * an external / non-connected X account), we deliberately return null rather than
 * attaching an unrelated "fallback" account: a non-author integrationId would be
 * a lie about who posted the reply. The real author is instead recorded in
 * Post.settings.engageAuthor (see fetchXAuthorProfile / createManualXPost), and
 * metrics still sync via the app-only path — impression_count and bookmark_count
 * are part of X `public_metrics` and are readable by an app-only bearer, NOT
 * owner-only, so a null integration loses no metric (see
 * PostsService.checkEngageXAnalyticsWithFallback).
 *
 * The pure functions here are shared by EngageRepository (request path) and the
 * backfill script (scripts/backfill-engage-x-integration.ts) so the resolution
 * rule has a single source of truth.
 */

export interface XIntegrationCandidate {
  id: string;
  /** X handle (@username, stored without other decoration) — Integration.profile. */
  profile: string | null;
  /**
   * @deprecated No longer consulted: resolution now matches on author handle only.
   * Kept on the interface so existing callers compile without churn.
   */
  engageEnabled?: boolean;
}

export type XReplyMatch = 'handle';

export interface XReplyResolution {
  integrationId: string;
  matchedBy: XReplyMatch;
}

/** Parse the lowercased author handle from an X/Twitter status URL, or null. */
export function parseXHandle(replyUrl?: string | null): string | null {
  const m = replyUrl?.match(/(?:twitter\.com|x\.com)\/([^/?#]+)\/status\//i)?.[1];
  return m ? m.replace(/^@/, '').toLowerCase() : null;
}

function normalizeHandle(profile: string | null | undefined): string {
  return (profile ?? '').replace(/^@/, '').toLowerCase();
}

/**
 * Pick the X integration that authored a reply. `candidates` MUST already be
 * filtered to live X integrations (providerIdentifier='x', not deleted, not
 * disabled). Returns the integration whose handle matches the reply URL's author,
 * or null when no connected account authored the reply (external account, or a
 * URL with no parseable handle) — null is the signal to record the author in
 * Post.settings.engageAuthor instead of attaching an unrelated account.
 */
export function pickXReplyIntegration(
  candidates: XIntegrationCandidate[],
  replyUrl?: string | null
): XReplyResolution | null {
  const handle = parseXHandle(replyUrl);
  if (!handle) return null;

  const byHandle = candidates.find((c) => normalizeHandle(c.profile) === handle);
  return byHandle ? { integrationId: byHandle.id, matchedBy: 'handle' } : null;
}

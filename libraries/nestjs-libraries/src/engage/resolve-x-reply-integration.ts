/**
 * Resolve which connected X Integration should own a manual engage reply so that
 * PostsService.checkPostAnalytics has a token to read the reply tweet's metrics.
 *
 * Why it matters: checkPostAnalytics needs SOME usable token to read the reply
 * tweet's metrics; when an engage reply is recorded without an integration its
 * Post.integrationId is null and the sent-list shows blank numbers. We therefore
 * try to attach a live X integration, preferring the actual author:
 *
 *   1. handle    — Integration.profile (the @username) equals the handle parsed
 *                  from the reply URL → the author's own token.
 *   2. bound     — an engage-enabled X reply account configured for the org.
 *   3. fallback  — any live X integration in the org.
 *
 * NOTE: impression_count and bookmark_count are part of X `public_metrics` and
 * are returned by ANY valid token (the author's, another account's, or even an
 * app-only bearer) — they are NOT owner-only. So the resolution order is about
 * having a *live* token at all, not about which token can see which metric: all
 * three tiers read the full metric set. If the attached token is dead, the
 * engage sync falls back to an app-only read (PostsService.checkPostAnalyticsAppOnly).
 *
 * The pure functions here are shared by EngageRepository (request path) and the
 * backfill script (scripts/backfill-engage-x-integration.ts) so the resolution
 * order has a single source of truth.
 */

export interface XIntegrationCandidate {
  id: string;
  /** X handle (@username, stored without other decoration) — Integration.profile. */
  profile: string | null;
  /** True when this integration is an engage-enabled X reply account. */
  engageEnabled?: boolean;
}

export type XReplyMatch = 'handle' | 'bound' | 'fallback';

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
 * Pick the best X integration for a reply. `candidates` MUST already be filtered
 * to live X integrations (providerIdentifier='x', not deleted, not disabled) and
 * is expected newest-first so the fallback is the most recently used account.
 */
export function pickXReplyIntegration(
  candidates: XIntegrationCandidate[],
  replyUrl?: string | null
): XReplyResolution | null {
  if (candidates.length === 0) return null;

  const handle = parseXHandle(replyUrl);
  if (handle) {
    const byHandle = candidates.find((c) => normalizeHandle(c.profile) === handle);
    if (byHandle) return { integrationId: byHandle.id, matchedBy: 'handle' };
  }

  const bound = candidates.find((c) => c.engageEnabled);
  if (bound) return { integrationId: bound.id, matchedBy: 'bound' };

  return { integrationId: candidates[0].id, matchedBy: 'fallback' };
}

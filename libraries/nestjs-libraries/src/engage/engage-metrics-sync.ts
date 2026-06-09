import { getRedditToken, redditAuthHeaders } from '@gitroom/nestjs-libraries/engage/reddit-auth';
import { redditPublicGet } from '@gitroom/nestjs-libraries/engage/reddit-loid';
import { parseRedditCommentId } from '@gitroom/nestjs-libraries/engage/reddit-url';

/**
 * Shared engage metrics-sync logic, used by BOTH the request-time path
 * (EngageService.resyncEngageMetrics) and the scheduled Temporal activity
 * (EngageDataTicksActivity.syncEngageMetrics). It previously existed as two
 * ~80-line copies that had already drifted in error-handling depth; this is the
 * single guarded implementation. Sinks are injected so each caller supplies its
 * own repository / posts-service / logger.
 */
export interface MetricsSyncDeps {
  updatePostMetrics(
    postId: string,
    impressions: number,
    analytics: unknown,
    trafficScore?: number
  ): Promise<unknown>;
  markAuthorReplied(sentReplyId: string): Promise<unknown>;
  checkPostAnalytics(orgId: string, postId: string, when: number): Promise<unknown>;
  warn(msg: string): void;
  log(msg: string): void;
}

/**
 * Outcome of a single reply's metrics sync, so callers can count REAL writes
 * instead of attempts:
 *   written      metrics were fetched and persisted to the Post.
 *   empty        the platform returned no usable data (deleted post, X tier
 *                block, etc.) — nothing written.
 *   unreachable  the fetch failed (network / WAF / API error) — nothing written.
 *   skipped      a precondition was missing (no comment/tweet id, no integration).
 */
export type MetricsSyncOutcome = 'written' | 'empty' | 'unreachable' | 'skipped';

export async function syncRedditMetrics(
  postId: string,
  releaseURL: string,
  sentReplyId: string,
  authorUsername: string,
  deps: MetricsSyncDeps
): Promise<MetricsSyncOutcome> {
  const commentId = parseRedditCommentId(releaseURL);
  if (!commentId) return 'skipped';

  let wrote = false;
  try {
    // Token path → oauth (no WAF); public path → redditPublicGet (loid cookie +
    // tiered proxy: rotate-IP on 403/429, then direct fallback).
    const token = await getRedditToken();
    const fetchReddit = async (
      url: string,
      tok: string | null
    ): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
      if (tok) {
        const r = await fetch(url, { headers: redditAuthHeaders(tok) });
        return { ok: r.ok, status: r.status, text: () => r.text() };
      }
      return redditPublicGet(url, {}, { log: deps.warn });
    };

    const infoUrl = token
      ? `https://oauth.reddit.com/api/info?id=t1_${commentId}`
      : `https://www.reddit.com/api/info.json?id=t1_${commentId}`;

    const infoRes = await fetchReddit(infoUrl, token);
    if (!infoRes.ok) {
      const body = await infoRes.text().catch(() => '<unreadable>');
      deps.warn(`Reddit /api/info returned ${infoRes.status} for t1_${commentId}: ${body.slice(0, 200)}`);
      return 'unreachable';
    }
    const infoJson = JSON.parse(await infoRes.text()) as {
      data?: { children?: Array<{ data: { score?: number; num_comments?: number } }> };
    };
    const commentData = infoJson.data?.children?.[0]?.data;
    if (!commentData) return 'empty';

    const score = Number(commentData.score ?? 0);
    const safeScore = Number.isFinite(score) ? score : 0;

    // Reddit's t1 comment object exposes `score`, but not the post-level
    // `num_comments` field. For a reply, "comments" means direct child replies
    // under our comment, fetched from the comment thread when available.
    let safeComments = Number(commentData.num_comments ?? 0);
    safeComments = Number.isFinite(safeComments) ? safeComments : 0;

    const threadMatch = releaseURL.match(/\/r\/([^/]+)\/comments\/([a-z0-9]+)\//);
    let childReplies: Array<{ data?: { author?: string }; kind?: string }> = [];
    if (threadMatch) {
      try {
        const [, subreddit, threadId] = threadMatch;
        const threadToken = await getRedditToken();
        // depth MUST be >= 2: with `comment=<id>` the target comment is the tree
        // root (level 1), so its OWN direct replies live at level 2. depth=1 only
        // returns the comment itself with its replies collapsed into a "more"
        // continuation stub (count=0) — which made safeComments always 0 and broke
        // the author-replied check for every reply that actually had replies.
        // limit=100 keeps a comment with many direct replies from overflowing into
        // a "more" stub (we only count the first level, so depth=2 is enough).
        const threadUrl = threadToken
          ? `https://oauth.reddit.com/r/${subreddit}/comments/${threadId}?comment=${commentId}&depth=2&limit=100`
          : `https://www.reddit.com/r/${subreddit}/comments/${threadId}/.json?comment=${commentId}&depth=2&limit=100`;
        const threadRes = await fetchReddit(threadUrl, threadToken);
        if (threadRes.ok) {
          const threadJson = JSON.parse(await threadRes.text()) as Array<{
            data?: { children?: Array<{ data?: { replies?: { data?: { children?: Array<{ data?: { author?: string }; kind?: string }> } } } }> };
          }>;
          childReplies =
            threadJson[1]?.data?.children?.[0]?.data?.replies?.data?.children ?? [];
          safeComments = childReplies.filter((r) => r.kind !== 'more').length;
        } else {
          const body = await threadRes.text().catch(() => '<unreadable>');
          deps.warn(`Reddit thread .json returned ${threadRes.status} for r/${subreddit}/${threadId}: ${body.slice(0, 200)}`);
        }
      } catch (err) {
        deps.warn(`Reddit child-reply count failed for t1_${commentId}: ${(err as Error).message}`);
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const analytics = [
      { label: 'score', data: [{ total: String(safeScore), date: today }], percentageChange: 0 },
      { label: 'comments', data: [{ total: String(safeComments), date: today }], percentageChange: 0 },
    ];
    // Reddit_traffic_index = score×1 + num_comments×3 (Appendix formula).
    const trafficScore = safeScore * 1 + safeComments * 3;
    await deps.updatePostMetrics(
      postId,
      Math.round((safeScore + safeComments) * 20),
      analytics,
      trafficScore
    );
    wrote = true;
    // Metrics are persisted from here on — the author-replied check below is
    // best-effort and must not downgrade the outcome if it fails.

    // Did the original post author reply to our comment?
    if (!authorUsername) return 'written';
    if (childReplies.some((r) => r.data?.author === authorUsername)) {
      await deps.markAuthorReplied(sentReplyId);
    }
    return 'written';
  } catch (err) {
    deps.warn(`Reddit metrics sync failed: ${(err as Error).message}`);
    // If the write already landed, a later author-check throw doesn't undo it.
    return wrote ? 'written' : 'unreachable';
  }
}

export async function syncXMetrics(
  args: {
    orgId: string;
    sentReplyId: string;
    postDbId: string;
    replyTweetUrl: string;
    originalTweetId: string;
    authorUsername: string;
  },
  deps: MetricsSyncDeps
): Promise<MetricsSyncOutcome> {
  const {
    orgId,
    sentReplyId,
    postDbId,
    replyTweetUrl,
    originalTweetId,
    authorUsername,
  } = args;

  // Metric outcome is decided by the per-account analytics fetch below; the
  // author-replied check afterwards is independent and never changes it.
  let outcome: MetricsSyncOutcome = 'skipped';

  // Fetch the reply tweet's metrics and write impressions/traffic back to the
  // Post. Engage posts are excluded from the global analytics job
  // (source != 'engage'), so we drive it explicitly here. deps.checkPostAnalytics
  // is PostsService.checkEngageXAnalyticsWithFallback — own-token when a connected
  // account authored the reply, else an app-only bearer read. impression_count and
  // bookmark_count are public_metrics (NOT owner-only), so the app-only path reads
  // the full metric set even when Post.integrationId is null. We therefore always
  // attempt it — a null integration is no longer a reason to skip.
  try {
    // A non-empty result means data landed; an empty array means the X API gave
    // nothing (tier block, no releaseId, or no app-only bearer configured).
    const analytics = await deps.checkPostAnalytics(orgId, postDbId, Date.now());
    outcome = Array.isArray(analytics) && analytics.length > 0 ? 'written' : 'empty';
  } catch (err) {
    deps.warn(`X analytics sync failed for post ${postDbId}: ${(err as Error).message}`);
    outcome = 'unreachable';
  }

  // Author-replied detection uses the app-only bearer (conversation search),
  // which is independent of the per-integration analytics token above.
  const bearerToken = process.env.X_BEARER_TOKEN;
  if (!bearerToken) return outcome;
  const replyTweetId = replyTweetUrl.match(/\/status\/(\d+)/)?.[1];
  if (!replyTweetId) return outcome;

  try {
    const authorRes = await fetch(
      `https://api.twitter.com/2/users/by/username/${authorUsername}`,
      { headers: { Authorization: `Bearer ${bearerToken}` } }
    );
    if (!authorRes.ok) {
      const body = await authorRes.text().catch(() => '<unreadable>');
      deps.warn(`X /users/by/username returned ${authorRes.status} for @${authorUsername}: ${body.slice(0, 200)}`);
      return outcome;
    }
    const authorJson = (await authorRes.json()) as { data?: { id: string } };
    const originalAuthorId = authorJson.data?.id;
    if (!originalAuthorId) return outcome;

    const res = await fetch(
      `https://api.twitter.com/2/tweets/search/recent?query=conversation_id:${originalTweetId}&tweet.fields=author_id&max_results=50`,
      { headers: { Authorization: `Bearer ${bearerToken}` } }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      deps.warn(`X /tweets/search/recent (conversation_id) returned ${res.status} for ${originalTweetId}: ${body.slice(0, 200)}`);
      return outcome;
    }
    const json = (await res.json()) as { data?: Array<{ id: string; author_id: string }> };
    // Did the ORIGINAL AUTHOR specifically reply AFTER our reply?
    if (
      (json.data ?? []).some(
        (t) => t.author_id === originalAuthorId && BigInt(t.id) > BigInt(replyTweetId)
      )
    ) {
      await deps.markAuthorReplied(sentReplyId);
    }
  } catch (err) {
    deps.warn(`X author-replied check failed: ${(err as Error).message}`);
  }
  return outcome;
}

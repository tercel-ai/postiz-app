import { getRedditToken, redditAuthHeaders } from '@gitroom/nestjs-libraries/engage/reddit-auth';
import { redditPublicGet } from '@gitroom/nestjs-libraries/engage/reddit-loid';

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

function extractRedditCommentId(url: string): string | null {
  return url.match(/\/comments\/[^/]+\/[^/]+\/([a-z0-9]+)\/?/)?.[1] ?? null;
}

export async function syncRedditMetrics(
  postId: string,
  releaseURL: string,
  sentReplyId: string,
  authorUsername: string,
  deps: MetricsSyncDeps
): Promise<void> {
  const commentId = extractRedditCommentId(releaseURL);
  if (!commentId) return;

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
      return;
    }
    const infoJson = JSON.parse(await infoRes.text()) as {
      data?: { children?: Array<{ data: { score: number; num_comments: number } }> };
    };
    const commentData = infoJson.data?.children?.[0]?.data;
    if (!commentData) return;

    const today = new Date().toISOString().slice(0, 10);
    const analytics = [
      { label: 'score', data: [{ total: String(commentData.score), date: today }], percentageChange: 0 },
      { label: 'comments', data: [{ total: String(commentData.num_comments), date: today }], percentageChange: 0 },
    ];
    // Reddit_traffic_index = score×1 + num_comments×3 (Appendix formula).
    const trafficScore = commentData.score * 1 + commentData.num_comments * 3;
    await deps.updatePostMetrics(
      postId,
      Math.round((commentData.score + commentData.num_comments) * 20),
      analytics,
      trafficScore
    );

    // Did the original post author reply to our comment? Fetch the comment thread.
    const threadMatch = releaseURL.match(/\/r\/([^/]+)\/comments\/([a-z0-9]+)\//);
    if (!threadMatch || !authorUsername) return;
    const [, subreddit, threadId] = threadMatch;
    const threadToken = await getRedditToken();
    const threadUrl = threadToken
      ? `https://oauth.reddit.com/r/${subreddit}/comments/${threadId}?comment=${commentId}&depth=1&limit=25`
      : `https://www.reddit.com/r/${subreddit}/comments/${threadId}/.json?comment=${commentId}&depth=1&limit=25`;
    const threadRes = await fetchReddit(threadUrl, threadToken);
    if (!threadRes.ok) {
      const body = await threadRes.text().catch(() => '<unreadable>');
      deps.warn(`Reddit thread .json returned ${threadRes.status} for r/${subreddit}/${threadId}: ${body.slice(0, 200)}`);
      return;
    }
    const threadJson = JSON.parse(await threadRes.text()) as Array<{
      data?: { children?: Array<{ data?: { replies?: { data?: { children?: Array<{ data?: { author?: string } }> } } } }> };
    }>;
    const childReplies =
      threadJson[1]?.data?.children?.[0]?.data?.replies?.data?.children ?? [];
    if (childReplies.some((r) => r.data?.author === authorUsername)) {
      await deps.markAuthorReplied(sentReplyId);
    }
  } catch (err) {
    deps.warn(`Reddit metrics sync failed: ${(err as Error).message}`);
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
    hasIntegration: boolean;
  },
  deps: MetricsSyncDeps
): Promise<void> {
  const {
    orgId,
    sentReplyId,
    postDbId,
    replyTweetUrl,
    originalTweetId,
    authorUsername,
    hasIntegration,
  } = args;

  // Fetch the reply tweet's metrics through the integration's own OAuth token
  // (the same path regular posts use), so impression_count and bookmark_count are
  // captured and the X traffic index + impressions are written back to the Post.
  // Engage posts are excluded from the global analytics job (source != 'engage'),
  // so we drive it explicitly here. With no X account there is no token to
  // authenticate with, so skip the per-account analytics (the author-replied
  // check below uses the app-only bearer and still runs).
  if (hasIntegration) {
    try {
      await deps.checkPostAnalytics(orgId, postDbId, Date.now());
    } catch (err) {
      deps.warn(`X analytics sync failed for post ${postDbId}: ${(err as Error).message}`);
    }
  } else {
    deps.log(`X reply ${sentReplyId} has no integration — skipping per-account analytics sync`);
  }

  // Author-replied detection uses the app-only bearer (conversation search),
  // which is independent of the per-integration analytics token above.
  const bearerToken = process.env.X_BEARER_TOKEN;
  if (!bearerToken) return;
  const replyTweetId = replyTweetUrl.match(/\/status\/(\d+)/)?.[1];
  if (!replyTweetId) return;

  try {
    const authorRes = await fetch(
      `https://api.twitter.com/2/users/by/username/${authorUsername}`,
      { headers: { Authorization: `Bearer ${bearerToken}` } }
    );
    if (!authorRes.ok) {
      const body = await authorRes.text().catch(() => '<unreadable>');
      deps.warn(`X /users/by/username returned ${authorRes.status} for @${authorUsername}: ${body.slice(0, 200)}`);
      return;
    }
    const authorJson = (await authorRes.json()) as { data?: { id: string } };
    const originalAuthorId = authorJson.data?.id;
    if (!originalAuthorId) return;

    const res = await fetch(
      `https://api.twitter.com/2/tweets/search/recent?query=conversation_id:${originalTweetId}&tweet.fields=author_id&max_results=50`,
      { headers: { Authorization: `Bearer ${bearerToken}` } }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      deps.warn(`X /tweets/search/recent (conversation_id) returned ${res.status} for ${originalTweetId}: ${body.slice(0, 200)}`);
      return;
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
}

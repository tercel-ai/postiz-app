import {
  getRedditToken,
  redditAuthHeaders,
} from '@gitroom/nestjs-libraries/engage/reddit-auth';
import { redditPublicGet } from '@gitroom/nestjs-libraries/engage/reddit-loid';
import { parseRedditCommentId } from '@gitroom/nestjs-libraries/engage/reddit-url';
import { parseDevtoCommentShortId } from '@gitroom/nestjs-libraries/engage/devto-url';
import { computeTrafficScore } from '@gitroom/nestjs-libraries/integrations/social/traffic.calculator';

/**
 * Shared engage metrics-sync logic for the demand-driven (event-driven) reply-
 * metrics refresh — EngageService.refreshMetricsForPosts and any manual/admin
 * resync. It previously existed as two ~80-line copies that had already drifted
 * in error-handling depth; this is the single guarded implementation. Sinks are
 * injected so each caller supplies its own repository / posts-service / logger.
 */
export interface MetricsSyncDeps {
  updatePostMetrics(
    postId: string,
    impressions: number,
    analytics: unknown,
    trafficScore?: number
  ): Promise<unknown>;
  markAuthorReplied(sentReplyId: string): Promise<unknown>;
  checkPostAnalytics(
    orgId: string,
    postId: string,
    when: number
  ): Promise<unknown>;
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
export type MetricsSyncOutcome =
  | 'written'
  | 'empty'
  | 'unreachable'
  | 'skipped';

/**
 * The engage platforms a reply's own metrics can be read for at all — the same
 * set `dispatchReplyMetricsSync` branches on, exported so the ingest endpoint
 * cannot drift from it. Everything else (linkedin, hackernews, medium, quora)
 * either leaves no addressable reply behind or publishes no per-reply counter,
 * so there is nothing to fetch and nothing to accept.
 */
export const REPLY_METRICS_PLATFORMS: readonly string[] = [
  'x',
  'reddit',
  'devto',
];

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
        const r = await fetch(url, {
          headers: redditAuthHeaders(tok),
          signal: AbortSignal.timeout(15_000),
        });
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
      deps.warn(
        `Reddit /api/info returned ${
          infoRes.status
        } for t1_${commentId}: ${body.slice(0, 200)}`
      );
      return 'unreachable';
    }
    const infoJson = JSON.parse(await infoRes.text()) as {
      data?: {
        children?: Array<{ data: { score?: number; num_comments?: number } }>;
      };
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

    const threadMatch = releaseURL.match(
      /\/r\/([^/]+)\/comments\/([a-z0-9]+)\//
    );
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
            data?: {
              children?: Array<{
                data?: {
                  replies?: {
                    data?: {
                      children?: Array<{
                        data?: { author?: string };
                        kind?: string;
                      }>;
                    };
                  };
                };
              }>;
            };
          }>;
          childReplies =
            threadJson[1]?.data?.children?.[0]?.data?.replies?.data?.children ??
            [];
          safeComments = childReplies.filter((r) => r.kind !== 'more').length;
        } else {
          const body = await threadRes.text().catch(() => '<unreadable>');
          deps.warn(
            `Reddit thread .json returned ${
              threadRes.status
            } for r/${subreddit}/${threadId}: ${body.slice(0, 200)}`
          );
        }
      } catch (err) {
        deps.warn(
          `Reddit child-reply count failed for t1_${commentId}: ${
            (err as Error).message
          }`
        );
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const analytics = [
      {
        label: 'score',
        data: [{ total: String(safeScore), date: today }],
        percentageChange: 0,
      },
      {
        label: 'comments',
        data: [{ total: String(safeComments), date: today }],
        percentageChange: 0,
      },
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

/**
 * Count the DIRECT replies to one dev.to comment.
 *
 * A reaction is the only counter the comment's own markup carries, but it is not
 * the only public signal the comment has: a reply IS the stronger one, and Forem
 * publishes the whole thread as a tree at /api/comments?a_id=<articleId> — open,
 * anonymous, no key. That endpoint carries no reaction count (which is why the
 * page is still scraped for that), so the two sources are complements, not
 * alternatives.
 *
 * The article id is read off the page already fetched rather than requested
 * separately: Forem stamps it on the comment permalink page as
 * `data-article-id`, so the count costs exactly one extra request.
 *
 * Returns null — NOT 0 — when the count cannot be established (no article id,
 * the endpoint failed, our comment is not in the tree). Null means "unknown" and
 * the caller omits the series entirely; a 0 would be persisted as a fact and
 * scored as one, which is the same invented-figure problem `impressions` avoids.
 */
async function fetchDevtoChildReplyCount(
  articlePageHtml: string,
  shortId: string,
  deps: MetricsSyncDeps
): Promise<number | null> {
  const articleId = articlePageHtml.match(/data-article-id="(\d+)"/)?.[1];
  if (!articleId) return null;

  interface ForemComment {
    id_code?: string;
    children?: ForemComment[];
  }

  try {
    const res = await fetch(`https://dev.to/api/comments?a_id=${articleId}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      deps.warn(
        `dev.to /api/comments returned ${res.status} for article ${articleId}`
      );
      return null;
    }
    const tree = JSON.parse(await res.text()) as unknown;
    if (!Array.isArray(tree)) return null;

    // The thread nests arbitrarily deep and our comment can sit at any level.
    const find = (nodes: ForemComment[]): ForemComment | null => {
      for (const node of nodes) {
        if (node?.id_code === shortId) return node;
        const hit = find(Array.isArray(node?.children) ? node.children : []);
        if (hit) return hit;
      }
      return null;
    };

    const own = find(tree as ForemComment[]);
    if (!own) return null;
    return Array.isArray(own.children) ? own.children.length : 0;
  } catch (err) {
    deps.warn(
      `dev.to child-reply count failed for ${shortId}: ${
        (err as Error).message
      }`
    );
    return null;
  }
}

/**
 * Read ONE dev.to comment's reaction count, server-side and anonymously.
 *
 * Forem has no public API for a single comment (/api/comments?a_id= returns the
 * thread but never a reaction count), so the source is the comment permalink
 * page itself: Forem server-renders the article there with the per-comment like
 * button (`#button-for-comment-<nodeId> .reactions-count`) already in the HTML.
 * No session, no tab, no hydration — which is why this can run on the server at
 * all, unlike the LinkedIn/Medium/Quora replies that only a logged-in browser
 * can see.
 *
 * The nodeId is NOT the shortId in the URL: Forem's markup keys the like button
 * on the comment's numeric internal id, and the two are not derivable from each
 * other, so the numeric id is resolved first from the wrapper whose `data-path`
 * ends in our shortId. Matching on that path is what keeps a neighbouring
 * comment's count from being read as ours.
 */
export async function syncDevtoMetrics(
  postId: string,
  releaseURL: string,
  deps: MetricsSyncDeps
): Promise<MetricsSyncOutcome> {
  const shortId = parseDevtoCommentShortId(releaseURL);
  if (!shortId) return 'skipped';

  try {
    const res = await fetch(releaseURL, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      deps.warn(`dev.to comment page returned ${res.status} for ${releaseURL}`);
      return 'unreachable';
    }
    const html = await res.text();

    const nodeId = html.match(
      new RegExp(
        `<div\\s+id="comment-node-(\\d+)"[^>]*data-path="[^"]*?/comments/${shortId}"`,
        's'
      )
    )?.[1];
    // The comment is gone (deleted / the article was taken down), or Forem
    // changed its markup. Either way there is nothing to write.
    if (!nodeId) return 'empty';

    // The like button and its count sit well past the node id in the DOM (past
    // the avatar, header and body markup) — a wide but bounded window, so a
    // LATER comment's count can never be mistaken for ours.
    const raw = html.match(
      new RegExp(
        `id="button-for-comment-${nodeId}"[\\s\\S]{0,3000}?reactions-count">(\\d+)</span>`
      )
    )?.[1];
    if (raw === undefined) return 'empty';

    const reactions = Number(raw);
    const safeReactions = Number.isFinite(reactions) ? reactions : 0;

    const today = new Date().toISOString().slice(0, 10);
    const entry = (label: string, value: number) => ({
      label,
      data: [{ total: String(value), date: today }],
      percentageChange: 0,
    });
    const analytics = [entry('reactions', safeReactions)];

    // The reply count is a second request and may not resolve; a comment with
    // an unknown reply count is still worth its reaction count, so a null here
    // narrows what is written rather than failing the sync.
    const childReplies = await fetchDevtoChildReplyCount(html, shortId, deps);
    if (childReplies !== null) analytics.push(entry('comments', childReplies));

    // Devto_traffic_index = reactions×1 + comments×3, straight off the shared
    // per-platform weight table (TRAFFIC_WEIGHTS.devto), so an article and a
    // comment on this platform are scored with the same ruler — and the same
    // 1/3 ratio Reddit's replies already use (score×1 + comments×3).
    //
    // impressions is 0 on purpose, NOT an estimate: dev.to publishes no reach
    // figure for a comment (page_views_count is author-only and article-level),
    // and Reddit's ×20 estimate is a documented formula for Reddit, not a
    // licence to invent one here. normalizeReplyMetrics omits the field for
    // devto so the UI shows no reach rather than a fabricated zero.
    await deps.updatePostMetrics(
      postId,
      0,
      analytics,
      computeTrafficScore('devto', analytics) ?? 0
    );
    return 'written';
  } catch (err) {
    deps.warn(`dev.to metrics sync failed: ${(err as Error).message}`);
    return 'unreachable';
  }
}

export async function syncXMetrics(
  args: {
    orgId: string;
    postDbId: string;
  },
  deps: MetricsSyncDeps
): Promise<MetricsSyncOutcome> {
  const { orgId, postDbId } = args;

  // X used to also run an author-replied check here, via the app-only bearer's
  // conversation search. It was removed with the move to browser-tab collection:
  // it read a THIRD PARTY's content from the server, and it was gated on
  // X_BEARER_TOKEN, which production never set — so it had never once run.
  // Reddit still detects author replies (from the thread .json it already
  // fetches), so EngageSentReply.authorReplied and the responseRate stat built
  // on it stay live for Reddit and remain false for X. See
  // docs/engage/x-tab-only-migration.md §5.
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
    const analytics = await deps.checkPostAnalytics(
      orgId,
      postDbId,
      Date.now()
    );
    outcome =
      Array.isArray(analytics) && analytics.length > 0 ? 'written' : 'empty';
  } catch (err) {
    deps.warn(
      `X analytics sync failed for post ${postDbId}: ${(err as Error).message}`
    );
    outcome = 'unreachable';
  }

  return outcome;
}

/**
 * Minimal reply shape needed to dispatch a per-reply metrics sync. Every caller
 * (event-driven `refreshMetricsForPosts`, admin `resyncEngageMetrics`, daily
 * `resyncRecentEngageMetrics`) selects at least these fields, so they can all
 * share one dispatch path instead of copying the reddit/x branch + arg-build.
 */
export interface ReplyMetricsSyncTarget {
  id: string;
  organizationId: string;
  post: { id: string; releaseURL: string | null } | null;
  opportunity: {
    platform: string;
    externalPostId?: string | null;
    authorUsername?: string | null;
  };
}

/**
 * Single source of truth for "given one engage reply, fetch its metrics on the
 * right platform". Returns `skipped` when the reply has no release URL or an
 * unrecognised platform. Callers keep their own try/catch, tally, heartbeat, and
 * logging concerns — this owns only the platform branch + argument construction,
 * which previously lived (verbatim) in three places.
 */
export async function dispatchReplyMetricsSync(
  reply: ReplyMetricsSyncTarget,
  deps: MetricsSyncDeps
): Promise<MetricsSyncOutcome> {
  const releaseURL = reply.post?.releaseURL;
  if (!reply.post || !releaseURL) return 'skipped';

  if (reply.opportunity.platform === 'reddit') {
    return syncRedditMetrics(
      reply.post.id,
      releaseURL,
      reply.id,
      reply.opportunity.authorUsername ?? '',
      deps
    );
  }
  if (reply.opportunity.platform === 'x') {
    return syncXMetrics(
      { orgId: reply.organizationId, postDbId: reply.post.id },
      deps
    );
  }
  if (reply.opportunity.platform === 'devto') {
    return syncDevtoMetrics(reply.post.id, releaseURL, deps);
  }
  return 'skipped';
}

/**
 * Raw reply metrics as scraped by the browser extension from the reply's OWN
 * page — X via TweetDetail (status page), Reddit via the comment .json. The
 * extension cannot (and must not) compute the weighted Traffic index; it only
 * forwards the public counters. buildReplyMetricsFromRaw turns these into the
 * persisted Post shape (impressions + analytics + trafficScore) using the EXACT
 * same formulas as the server-side OAuth/public sync, so an extension-sourced
 * refresh is indistinguishable from a backend-sourced one downstream.
 */
export interface RawReplyMetrics {
  platform: 'x' | 'reddit' | 'devto';
  // X public_metrics
  impressions?: number;
  likes?: number;
  replies?: number;
  retweets?: number;
  quotes?: number;
  bookmarks?: number;
  // Reddit comment counters
  score?: number;
  comments?: number;
  // Dev.to reuses two fields it already had rather than adding its own: the
  // comment's reaction count arrives as `likes`, and its direct reply count as
  // `comments`. The server relabels the first to `reactions` on the way in,
  // because that is the label the shared TRAFFIC_WEIGHTS.devto table scores —
  // `likes` is not a devto weight and would silently score 0. `comments` is
  // already the right label and passes through. A sender that knows only the
  // reaction count omits `comments` entirely: absent means unknown, and an
  // omitted series is what keeps an unknown from being scored as a zero.
}

export interface BuiltReplyMetrics {
  impressions: number;
  trafficScore: number;
  analytics: Array<{
    label: string;
    data: Array<{ total: string; date: string }>;
    percentageChange: number;
  }>;
}

/**
 * Turn extension-scraped raw counters into the persisted Post metrics shape.
 * X labels (impressions/likes/replies/retweets/quotes/bookmarks) and the Reddit
 * formula (impressions = (score+comments)×20, traffic = score×1 + comments×3)
 * mirror syncXMetrics/syncRedditMetrics so normalizeReplyMetrics reads them back
 * identically. Non-finite inputs coerce to 0 (Prisma Float columns reject NaN).
 */
export function buildReplyMetricsFromRaw(
  raw: RawReplyMetrics
): BuiltReplyMetrics {
  const today = new Date().toISOString().slice(0, 10);
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const entry = (label: string, value: number) => ({
    label,
    data: [{ total: String(value), date: today }],
    percentageChange: 0,
  });

  if (raw.platform === 'reddit') {
    const score = num(raw.score);
    const comments = num(raw.comments);
    return {
      impressions: Math.round((score + comments) * 20),
      // Reddit_traffic_index = score×1 + num_comments×3 (Appendix formula).
      trafficScore: score * 1 + comments * 3,
      analytics: [entry('score', score), entry('comments', comments)],
    };
  }

  if (raw.platform === 'devto') {
    const analytics = [entry('reactions', num(raw.likes))];
    // Only when the sender actually carried one — see RawReplyMetrics on why an
    // absent reply count must not become a zero.
    if (raw.comments !== undefined) {
      analytics.push(entry('comments', num(raw.comments)));
    }
    return {
      // No reach estimate — see syncDevtoMetrics for why 0 is deliberate here.
      impressions: 0,
      trafficScore: computeTrafficScore('devto', analytics) ?? 0,
      analytics,
    };
  }

  const impressions = num(raw.impressions);
  const analytics = [
    entry('impressions', impressions),
    entry('likes', num(raw.likes)),
    entry('replies', num(raw.replies)),
    entry('retweets', num(raw.retweets)),
    entry('quotes', num(raw.quotes)),
    entry('bookmarks', num(raw.bookmarks)),
  ];
  // X_traffic_index uses the per-platform weighted formula (impressions are not
  // weighted, matching the spec); computeTrafficScore returns null when no label
  // matches, which only happens for an all-empty set → 0.
  const trafficScore = computeTrafficScore('x', analytics) ?? 0;
  return { impressions, trafficScore, analytics };
}

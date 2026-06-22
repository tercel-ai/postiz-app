import { RawPost } from '../engage-scorer';
import { applyPageDelay } from './scan-pacing';
import {
  AdapterCaps,
  PlatformScanAdapter,
  RateLimitInfo,
  ScanResult,
  SearchScopedArgs,
  batchKeywordsOr,
  maxId,
  resolveLogger,
  retryAfterFromReset,
} from './platform-scan-adapter';

// X v2 recent-search OR queries: 512-char hard cap, keep headroom for the
// `from:user ` prefix and parentheses.
const X_QUERY_MAX_LEN = 460;
// For merged tracked scans the query is `(from:a OR from:b) (kw...) -is:retweet`.
// Reserve a slice of the 512-char budget for the author clause so the author and
// keyword clauses jointly stay under the limit (200 authors-clause + 260 keyword
// -clause + space + suffix ≈ 473 < 512).
const X_AUTHOR_CLAUSE_MAX_LEN = 200;
// recent search returns at most 100 results per page.
const X_MAX_RESULTS = 100;
const X_SEARCH_URL = 'https://api.twitter.com/2/tweets/search/recent';

// X enforces the original tweet's reply_settings on API replies. Only
// 'everyone' (or absent, which defaults to 'everyone') is repliable by an
// arbitrary account; anything else is dropped at scan time so we never surface
// an opportunity the user can only fail to reply to. A whitelist is deliberate
// (the returned strings differ from the create-post request strings).
function isXReplyable(replySettings?: string): boolean {
  return !replySettings || replySettings.toLowerCase() === 'everyone';
}

interface XTweet {
  id: string;
  text: string;
  created_at: string;
  author_id: string;
  reply_settings?: string;
  referenced_tweets?: Array<{
    type: 'retweeted' | 'quoted' | 'replied_to';
    id: string;
  }>;
  public_metrics?: {
    like_count: number;
    reply_count: number;
    retweet_count: number;
    quote_count: number;
    bookmark_count: number;
  };
}

interface XUser {
  id: string;
  username: string;
  name: string;
  profile_image_url?: string;
  public_metrics?: { followers_count: number };
}

interface XSearchResponse {
  data?: XTweet[];
  // includes.tweets holds the originals behind referenced_tweets (retweeted/
  // quoted/replied_to) — returned inline in the same response, no extra calls.
  includes?: { users?: XUser[]; tweets?: XTweet[] };
  meta?: { next_token?: string; result_count?: number };
}

export interface XScanAdapterDeps {
  fetchImpl?: typeof fetch;
}

// X (Twitter) implementation of the scan primitive.
//   keyword scope  → search the firehose for the OR-batched keywords
//   tracked scope  → prefix `from:username` to restrict to one author
//   (no channel scope — X has no community concept here)
// Incremental via since_id (cursor.lastSeenExternalId) + next_token paging,
// bounded by budget.maxCalls. reply-restricted tweets are filtered out.
export class XScanAdapter implements PlatformScanAdapter {
  readonly platform = 'x';
  readonly caps: AdapterCaps = {
    incrementalById: true,
    pagination: true,
    channelScoped: false,
    trackedScoped: true,
    maxPerCall: X_MAX_RESULTS,
  };

  private readonly _fetch: typeof fetch;

  constructor(deps: XScanAdapterDeps = {}) {
    this._fetch = deps.fetchImpl ?? fetch;
  }

  async searchScoped(args: SearchScopedArgs): Promise<ScanResult> {
    const { scope, keywords, cursor, budget, token } = args;
    const log = resolveLogger(args.log);
    const sinceId = cursor.lastSeenExternalId ?? undefined;
    const empty: ScanResult = {
      posts: [],
      nextCursor: { ...cursor },
      rate: { limited: false },
    };

    if (!keywords.length) return empty;
    if (!token) {
      log.warn('X scan skipped: no token provided');
      return empty;
    }
    // Tracked may carry one (scope.key) or many (scope.keys) usernames; both
    // collapse to a single author list here.
    const authors =
      scope.type === 'tracked'
        ? (scope.keys?.length ? scope.keys : scope.key ? [scope.key] : [])
        : [];
    if (scope.type === 'tracked' && !authors.length) {
      log.warn('X tracked scan skipped: no username(s) in scope');
      return empty;
    }

    // Build queries. Tracked scans restrict to authors AND drop retweets
    // (`-is:retweet`): we want what the accounts themselves said, not strangers'
    // posts they amplified. Authors are OR-batched into `(from:a OR from:b)`
    // clauses so one cadence-bucket of accounts costs a few calls, not one per
    // account. Keywords are OR-batched within the remaining length budget, and
    // every (authorClause × keywordBatch) pair becomes one query.
    const suffix = scope.type === 'tracked' ? ' -is:retweet' : '';
    const authorClauses =
      scope.type === 'tracked'
        ? batchKeywordsOr(
            authors.map((u) => `from:${u}`),
            X_AUTHOR_CLAUSE_MAX_LEN
          )
        : [''];
    const keywordMaxLen =
      scope.type === 'tracked'
        ? X_QUERY_MAX_LEN - X_AUTHOR_CLAUSE_MAX_LEN
        : X_QUERY_MAX_LEN;
    const keywordBatches = batchKeywordsOr(keywords, keywordMaxLen);
    const queries: string[] = [];
    for (const authorClause of authorClauses) {
      for (const keywordBatch of keywordBatches) {
        queries.push(
          authorClause
            ? `${authorClause} ${keywordBatch}${suffix}`
            : `${keywordBatch}`
        );
      }
    }

    const posts: RawPost[] = [];
    let newestId = sinceId;
    let newestAt: Date | null = cursor.lastSeenAt ?? null;
    let rate: RateLimitInfo = { limited: false };
    let callsUsed = 0;

    for (const query of queries) {
      let pageToken: string | undefined;
      do {
        if (callsUsed >= budget.maxCalls) {
          log.warn(
            `X scan hit call budget (${budget.maxCalls}); stopping with backlog remaining`
          );
          return {
            posts,
            nextCursor: cursorFrom(newestId, newestAt),
            rate,
            backlogRemaining: true,
          };
        }
        // Space consecutive page fetches per the configured pacing (no delay on
        // the very first call). jitter de-regularises the cadence.
        if (callsUsed > 0) {
          await applyPageDelay(budget);
        }
        args.heartbeat?.({ stage: 'x_search', query: query.slice(0, 60), pageToken });

        const { json, rate: pageRate } = await this._fetchPage(
          query,
          sinceId,
          pageToken,
          token,
          log
        );
        callsUsed++;
        rate = pageRate;
        if (pageRate.limited) {
          // Stop immediately; the caller cools the unit/token down.
          return { posts, nextCursor: cursorFrom(newestId, newestAt), rate };
        }
        if (!json) break; // non-rate error already logged; move to next query

        const users = new Map((json.includes?.users ?? []).map((u) => [u.id, u]));
        // Originals behind referenced_tweets, returned inline in this response.
        const refById = new Map(
          (json.includes?.tweets ?? []).map((t) => [t.id, t])
        );
        for (const tweet of json.data ?? []) {
          // Cursor ALWAYS tracks the top-level search result (the firehose
          // stream), never the resolved original — the original's id is older
          // and would walk the since_id cursor backwards.
          newestId = maxId(newestId, tweet.id);
          const at = new Date(tweet.created_at);
          if (!newestAt || at > newestAt) newestAt = at;

          // A pure retweet is a pointer, not content: resolve it to the original
          // post (id/author/text/metrics/reply_settings) so the opportunity is a
          // real, repliable target by the original author. Quotes and replies are
          // kept as-is (their own text is fresh, original commentary).
          const rtId = tweet.referenced_tweets?.find(
            (r) => r.type === 'retweeted'
          )?.id;
          const entity = rtId ? refById.get(rtId) : tweet;
          if (!entity) continue; // original deleted/protected/unavailable → drop
          if (!isXReplyable(entity.reply_settings)) continue;
          posts.push(toRawPost(entity, users.get(entity.author_id)));
        }
        pageToken = json.meta?.next_token;
      } while (pageToken);
    }

    log.log(
      `X ${scope.type} scan: ${posts.length} replyable post(s) over ${queries.length} query(ies), ${callsUsed} call(s)`
    );
    return { posts, nextCursor: cursorFrom(newestId, newestAt), rate };
  }

  private async _fetchPage(
    query: string,
    sinceId: string | undefined,
    pageToken: string | undefined,
    token: string,
    log: ReturnType<typeof resolveLogger>
  ): Promise<{ json: XSearchResponse | null; rate: RateLimitInfo }> {
    const params = new URLSearchParams({
      query,
      max_results: String(X_MAX_RESULTS),
      'tweet.fields':
        'public_metrics,author_id,created_at,text,reply_settings,referenced_tweets',
      'user.fields': 'public_metrics,name,username,profile_image_url',
      // referenced_tweets.id → originals into includes.tweets;
      // referenced_tweets.id.author_id → their authors into includes.users.
      expansions: 'author_id,referenced_tweets.id,referenced_tweets.id.author_id',
    });
    if (sinceId) params.set('since_id', sinceId);
    if (pageToken) params.set('pagination_token', pageToken);

    const res = await this._fetch(`${X_SEARCH_URL}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const rate = parseXRateLimit(res);
    if (res.status === 429) {
      log.warn('X /tweets/search/recent rate-limited (429)');
      return { json: null, rate };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      log.warn(
        `X /tweets/search/recent ${res.status} for "${query.slice(0, 60)}": ${body.slice(0, 200)}`
      );
      return { json: null, rate };
    }
    try {
      return { json: (await res.json()) as XSearchResponse, rate };
    } catch (err) {
      // A 2xx with a non-JSON body (CDN/gateway interstitial) must not abort the
      // whole scan unit and discard posts already collected this run. Mirror the
      // !ok path: break to the next query, preserving partial progress + cursor.
      log.warn(
        `X /tweets/search/recent returned an unparseable body for "${query.slice(0, 60)}": ${(err as Error).message}`
      );
      return { json: null, rate };
    }
  }
}

function cursorFrom(id: string | undefined, at: Date | null) {
  return { lastSeenExternalId: id ?? null, lastSeenAt: at };
}

function toRawPost(tweet: XTweet, author?: XUser): RawPost {
  return {
    id: `x_${tweet.id}`,
    platform: 'x',
    externalPostId: tweet.id,
    externalPostUrl: `https://x.com/${author?.username ?? 'i'}/status/${tweet.id}`,
    authorUsername: author?.username ?? tweet.author_id,
    authorDisplayName: author?.name,
    authorAvatarUrl: author?.profile_image_url?.replace('_normal', '_400x400'),
    authorFollowers: author?.public_metrics?.followers_count,
    postContent: tweet.text,
    postPublishedAt: new Date(tweet.created_at),
    metricLikes: tweet.public_metrics?.like_count ?? 0,
    metricReplies: tweet.public_metrics?.reply_count ?? 0,
    metricRetweets: tweet.public_metrics?.retweet_count ?? 0,
    metricQuotes: tweet.public_metrics?.quote_count ?? 0,
    metricBookmarks: tweet.public_metrics?.bookmark_count ?? 0,
    metricViews: 0,
    metricShares: 0,
    metricSaves: 0,
    metricScore: 0,
    metricComments: 0,
    rawData: { tweet, author } as Record<string, unknown>,
  };
}

// X returns standard rate-limit headers on every response.
export function parseXRateLimit(res: {
  status: number;
  headers: { get(name: string): string | null };
}): RateLimitInfo {
  const remainingRaw = res.headers.get('x-rate-limit-remaining');
  const resetRaw = res.headers.get('x-rate-limit-reset');
  const remaining = remainingRaw != null ? Number(remainingRaw) : undefined;
  const resetEpoch = resetRaw != null ? Number(resetRaw) : undefined;
  const resetAt =
    resetEpoch != null && !Number.isNaN(resetEpoch)
      ? new Date(resetEpoch * 1000)
      : undefined;
  return {
    remaining: Number.isNaN(remaining as number) ? undefined : remaining,
    resetAt,
    retryAfterMs: res.status === 429 ? retryAfterFromReset(resetEpoch) : undefined,
    limited: res.status === 429,
  };
}

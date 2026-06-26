import { RawPost } from '../engage-scorer';
import { applyPageDelay } from './scan-pacing';
import {
  recordApiUsage,
  X_USAGE,
} from '@gitroom/nestjs-libraries/database/prisma/api-usage/api-usage.service';
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
// X recent search `max_results` accepts 10..100 (API floor/ceiling). DEFAULT is
// the per-call request size when the caller doesn't pass one; admin-tunable via
// the engage.keyword_x_scan_max_results setting, resolved upstream and passed in
// as SearchScopedArgs.maxResults. Kept LOW by default because X bills per
// returned record — a bigger page only helps busy keywords / initial scans.
export const X_MAX_RESULTS = 10; // default request size
export const X_MAX_RESULTS_FLOOR = 10; // X API minimum
export const X_MAX_RESULTS_CEILING = 100; // X API maximum

/** Clamp a requested page size into X's valid [10, 100] range (X 400s otherwise). */
export function clampXMaxResults(n: number | null | undefined): number {
  if (n == null || !Number.isFinite(n)) return X_MAX_RESULTS;
  return Math.min(X_MAX_RESULTS_CEILING, Math.max(X_MAX_RESULTS_FLOOR, Math.round(n)));
}
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
  // Archival/filtering fields — requested into rawData, not promoted to columns.
  lang?: string;
  possibly_sensitive?: boolean;
  conversation_id?: string;
  // note_tweet carries the full text of a >280-char tweet (`text` is truncated).
  note_tweet?: { text?: string; entities?: Record<string, unknown> };
  // entities: urls / hashtags / mentions / annotations parsed by X.
  entities?: Record<string, unknown>;
  // context_annotations: X-detected topics/entities (domain + entity pairs).
  context_annotations?: Array<{
    domain?: { id: string; name: string; description?: string };
    entity?: { id: string; name: string; description?: string };
  }>;
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
    // Platform hard ceiling (what X CAN return per call), not the configured
    // default request size — the latter is per-call via SearchScopedArgs.maxResults.
    maxPerCall: X_MAX_RESULTS_CEILING,
  };

  private readonly _fetch: typeof fetch;

  constructor(deps: XScanAdapterDeps = {}) {
    this._fetch = deps.fetchImpl ?? fetch;
  }

  async searchScoped(args: SearchScopedArgs): Promise<ScanResult> {
    const { scope, keywords, cursor, budget, token } = args;
    const log = resolveLogger(args.log);
    const now = Date.now();
    // Per-call page size: caller-supplied (settings-resolved) or the default,
    // clamped into X's valid [10, 100] range so the API never 400s.
    const maxResults = clampXMaxResults(args.maxResults);

    // Freshness window (optional): never surface a post older than the window.
    //  • start_time = now - window  → the API lower bound, used on a first scan
    //    or after a gap longer than the window.
    //  • when the cursor is OLDER than the window, DROP since_id for the request:
    //    X gives since_id precedence over start_time, so a stale since_id would
    //    walk us back past the window and resurface stale posts — beyond the
    //    window we want the start_time floor instead. The PERSISTED cursor is
    //    unaffected (newestId below still seeds from cursor.lastSeenExternalId).
    //  • a client-side cutoff (in the loop) is the final guarantee regardless of
    //    how X resolves since_id vs start_time.
    let querySinceId = cursor.lastSeenExternalId ?? undefined;
    let startTime: string | undefined;
    let cutoffMs: number | undefined;
    if (args.freshnessWindowMs != null && args.freshnessWindowMs > 0) {
      cutoffMs = now - args.freshnessWindowMs;
      if (!cursor.lastSeenAt || cursor.lastSeenAt.getTime() < cutoffMs) {
        querySinceId = undefined;
        startTime = isoSecondsUtc(cutoffMs);
      }
    }

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
    let newestId = cursor.lastSeenExternalId ?? undefined;
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
          querySinceId,
          startTime,
          pageToken,
          token,
          maxResults,
          log
        );
        callsUsed++;
        rate = pageRate;
        if (pageRate.limited) {
          // Stop immediately; the caller cools the unit/token down.
          return { posts, nextCursor: cursorFrom(newestId, newestAt), rate };
        }
        if (!json) break; // non-rate error already logged; move to next query

        // Cost telemetry: X bills per RETURNED record (data[]), before our
        // replyable/retweet filtering below. Count the raw response, not posts.
        recordApiUsage('x', X_USAGE.POSTS_READ, (json.data ?? []).length);

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

          // Freshness floor: never surface a post older than the window, even if
          // X returned one (boundary / since_id-vs-start_time precedence). The
          // cursor already advanced above, so this only drops it from results.
          if (cutoffMs != null && at.getTime() < cutoffMs) continue;

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
    startTime: string | undefined,
    pageToken: string | undefined,
    token: string,
    maxResults: number,
    log: ReturnType<typeof resolveLogger>
  ): Promise<{ json: XSearchResponse | null; rate: RateLimitInfo }> {
    const params = new URLSearchParams({
      query,
      max_results: String(maxResults),
      // Archival/filtering fields land in rawData (the full tweet is stored
      // verbatim on EngageOpportunity.rawData): lang (language filtering),
      // context_annotations (X topic/entity tags), entities (urls/hashtags/
      // mentions), conversation_id (thread grouping), note_tweet (>280-char full
      // text — `text` is truncated), possibly_sensitive (content gating). Not
      // promoted to columns; queryable only via rawData for now.
      'tweet.fields':
        'public_metrics,author_id,created_at,text,reply_settings,referenced_tweets,lang,context_annotations,entities,conversation_id,note_tweet,possibly_sensitive',
      'user.fields': 'public_metrics,name,username,profile_image_url',
      // referenced_tweets.id → originals into includes.tweets;
      // referenced_tweets.id.author_id → their authors into includes.users.
      expansions: 'author_id,referenced_tweets.id,referenced_tweets.id.author_id',
    });
    if (sinceId) params.set('since_id', sinceId);
    if (startTime) params.set('start_time', startTime);
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

// X wants second-granularity RFC3339 (`YYYY-MM-DDTHH:mm:ssZ`), not the
// millisecond form (`...sss Z`) that Date#toISOString emits — strip the millis.
function isoSecondsUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
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

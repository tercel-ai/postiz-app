import { RawPost } from '../engage-scorer';
import { applyPageDelay } from './scan-pacing';
import { redditAuthHeaders } from '../reddit-auth';
import { redditPublicGet } from '../reddit-loid';
import {
  AdapterCaps,
  PlatformScanAdapter,
  RateLimitInfo,
  ScanCursor,
  ScanResult,
  SearchScopedArgs,
  batchKeywordsOr,
  resolveLogger,
} from './platform-scan-adapter';

// Reddit search `q` cap is ~512 chars; keep headroom.
const REDDIT_QUERY_MAX_LEN = 480;
const REDDIT_LIMIT = 100;

const REDDIT_BROWSER_EXTRA = {
  Accept: 'application/json, text/javascript, */*; q=0.01',
  Referer: 'https://www.reddit.com/',
};

interface RedditListing {
  data?: {
    after?: string | null;
    children?: Array<{ data: Record<string, unknown> }>;
  };
}

export interface RedditScanAdapterDeps {
  fetchImpl?: typeof fetch;
  publicGet?: typeof redditPublicGet;
}

// Reddit implementation of the scan primitive.
//   keyword scope  → global /search across all subreddits
//   channel scope  → /r/{sub}/search with restrict_sr (scope.key = subreddit)
//   (no tracked scope here — author timelines are an X concern)
//
// Reddit search has no since_id, so incremental is TIME-based: sort=new, page
// via `after`, and stop as soon as a post is older than cursor.lastSeenAt.
// Tries the OAuth endpoint first (token), then falls back to the public path
// (loid + tiered proxy via redditPublicGet).
export class RedditScanAdapter implements PlatformScanAdapter {
  readonly platform = 'reddit';
  readonly caps: AdapterCaps = {
    incrementalById: false,
    pagination: true,
    channelScoped: true,
    trackedScoped: false,
    maxPerCall: REDDIT_LIMIT,
  };

  private readonly _fetch: typeof fetch;
  private readonly _publicGet: typeof redditPublicGet;

  constructor(deps: RedditScanAdapterDeps = {}) {
    this._fetch = deps.fetchImpl ?? fetch;
    this._publicGet = deps.publicGet ?? redditPublicGet;
  }

  async searchScoped(args: SearchScopedArgs): Promise<ScanResult> {
    const { scope, keywords, cursor, budget, token } = args;
    const log = resolveLogger(args.log);
    const empty: ScanResult = {
      posts: [],
      nextCursor: { ...cursor },
      rate: { limited: false },
    };

    if (!keywords.length) return empty;
    if (scope.type === 'channel' && !scope.key) {
      log.warn('Reddit channel scan skipped: scope.key (subreddit) missing');
      return empty;
    }
    if (scope.type === 'tracked') {
      log.warn('Reddit adapter does not support tracked scope');
      return empty;
    }

    // Stop line for the sort=new descending scan. Two inputs:
    //   • the incremental cursor (don't re-fetch what we've seen), and
    //   • the freshness floor `now - window` (don't surface stale posts on a
    //     first scan / long gap).
    // Take the LATER (max) of the two — the more recent floor wins, mirroring the
    // X adapter's `start_time = max(cursor, now-window)`. Reddit has no
    // start_time param, but it pages sort=new and breaks on the first post at/
    // older than this line, so the stop line IS the freshness cutoff — no
    // separate client-side filter needed.
    const cutoffMs =
      args.freshnessWindowMs != null && args.freshnessWindowMs > 0
        ? Date.now() - args.freshnessWindowMs
        : null;
    const lastSeenMs = cursor.lastSeenAt ? cursor.lastSeenAt.getTime() : null;
    const stopBefore =
      lastSeenMs == null
        ? cutoffMs
        : cutoffMs == null
          ? lastSeenMs
          : Math.max(lastSeenMs, cutoffMs);
    const posts: RawPost[] = [];
    let newestAt = cursor.lastSeenAt ?? null;
    let newestId = cursor.lastSeenExternalId ?? null;
    let rate: RateLimitInfo = { limited: false };
    let callsUsed = 0;

    for (const query of batchKeywordsOr(keywords, REDDIT_QUERY_MAX_LEN)) {
      let after: string | null | undefined;
      let reachedSeen = false;
      do {
        if (callsUsed >= budget.maxCalls) {
          log.warn(`Reddit scan hit call budget (${budget.maxCalls}); backlog remains`);
          return {
            posts,
            nextCursor: cur(newestId, newestAt),
            rate,
            backlogRemaining: true,
          };
        }
        // Space consecutive page fetches per the configured pacing (no delay on
        // the very first call). Reddit's public path is WAF-sensitive, so this
        // matters even server-side.
        if (callsUsed > 0) {
          await applyPageDelay(budget);
        }
        args.heartbeat?.({
          stage: 'reddit_search',
          scope: scope.key ?? 'global',
          query: query.slice(0, 60),
        });

        const { listing, rate: pageRate } = await this._fetchPage(
          scope.key,
          query,
          after ?? undefined,
          token ?? null,
          log
        );
        callsUsed++;
        rate = pageRate;
        if (pageRate.limited) {
          return { posts, nextCursor: cur(newestId, newestAt), rate };
        }
        if (!listing) break;

        const children = listing.data?.children ?? [];
        for (const child of children) {
          const p = child.data;
          if (p.subreddit_type === 'private') continue;
          const at = ((p.created_utc as number) ?? 0) * 1000;
          if (stopBefore != null && at <= stopBefore) {
            reachedSeen = true; // sort=new is descending → everything after is older
            break;
          }
          if (!newestAt || at > newestAt.getTime()) newestAt = new Date(at);
          newestId = newestId ?? (p.name as string) ?? null;
          posts.push(toRawPost(p));
        }
        // First page's first item is the newest overall → capture its fullname.
        if (children.length && cursor.lastSeenExternalId == null && !after) {
          newestId = (children[0].data.name as string) ?? newestId;
        }
        after = reachedSeen ? null : listing.data?.after;
      } while (after);
    }

    log.log(
      `Reddit ${scope.type} scan${scope.key ? ` r/${scope.key}` : ''}: ${posts.length} post(s), ${callsUsed} call(s)`
    );
    return { posts, nextCursor: cur(newestId, newestAt), rate };
  }

  private async _fetchPage(
    subreddit: string | undefined,
    query: string,
    after: string | undefined,
    token: string | null,
    log: ReturnType<typeof resolveLogger>
  ): Promise<{ listing: RedditListing | null; rate: RateLimitInfo }> {
    const q = encodeURIComponent(query);
    const afterParam = after ? `&after=${encodeURIComponent(after)}` : '';
    const path = subreddit
      ? `/r/${encodeURIComponent(subreddit)}/search?q=${q}&restrict_sr=true&sort=new&limit=${REDDIT_LIMIT}&type=link${afterParam}`
      : `/search?q=${q}&sort=new&limit=${REDDIT_LIMIT}&type=link${afterParam}`;

    // OAuth path (has rate-limit headers).
    if (token) {
      const res = await this._fetch(`https://oauth.reddit.com${path}`, {
        headers: redditAuthHeaders(token),
        signal: AbortSignal.timeout(10_000),
      });
      const rate = parseRedditRateLimit(res);
      if (res.status === 429) {
        log.warn('Reddit OAuth search rate-limited (429)');
        return { listing: null, rate };
      }
      if (res.ok) {
        try {
          return { listing: (await res.json()) as RedditListing, rate };
        } catch (err) {
          // Guard the parse like the public path below: a malformed 2xx body must
          // break the loop (preserving collected posts), not abort the scan unit.
          log.warn(`Reddit OAuth search parse failed: ${(err as Error).message}`);
          return { listing: null, rate };
        }
      }
      const body = await res.text().catch(() => '<unreadable>');
      log.warn(`Reddit OAuth search ${res.status}: ${body.slice(0, 160)} — falling back to public`);
    }

    // Public path (loid + tiered proxy; no rate-limit headers exposed).
    const publicBase = subreddit
      ? `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.json?q=${q}&restrict_sr=on&sort=new&limit=${REDDIT_LIMIT}&type=link${afterParam}`
      : `https://www.reddit.com/search.json?q=${q}&sort=new&limit=${REDDIT_LIMIT}&type=link${afterParam}`;
    const res = await this._publicGet(publicBase, REDDIT_BROWSER_EXTRA, {
      log: (m) => log.warn(m),
    });
    if (!res.ok) {
      log.warn(`Reddit public search ${res.status}`);
      return { listing: null, rate: { limited: res.status === 429 } };
    }
    try {
      return { listing: JSON.parse(await res.text()) as RedditListing, rate: { limited: false } };
    } catch (err) {
      log.warn(`Reddit public search parse failed: ${(err as Error).message}`);
      return { listing: null, rate: { limited: false } };
    }
  }
}

function cur(id: string | null, at: Date | null): ScanCursor {
  return { lastSeenExternalId: id, lastSeenAt: at };
}

function toRawPost(p: Record<string, unknown>): RawPost {
  const subreddit = p.subreddit as string;
  return {
    id: `reddit_${p.id as string}`,
    platform: 'reddit',
    externalPostId: p.id as string,
    externalPostUrl: `https://www.reddit.com${p.permalink as string}`,
    channelId: subreddit,
    channelName: `r/${subreddit}`,
    authorUsername: p.author as string,
    // Reddit has no meaningful per-author follower count in search results; leave it
    // null. Community authority is driven by the subreddit's audience size below.
    authorFollowers: undefined,
    channelFollowers: (p.subreddit_subscribers as number) ?? 0,
    postContent: `${p.title as string}${p.selftext ? '\n' + (p.selftext as string) : ''}`.trim(),
    postPublishedAt: new Date(((p.created_utc as number) ?? 0) * 1000),
    metricLikes: 0,
    metricReplies: 0,
    metricRetweets: 0,
    metricQuotes: 0,
    metricBookmarks: 0,
    metricViews: 0,
    metricShares: 0,
    metricSaves: 0,
    metricScore: (p.score as number) ?? 0,
    metricUpvoteRatio: (p.upvote_ratio as number) ?? 0,
    metricComments: (p.num_comments as number) ?? 0,
    rawData: p,
  };
}

// Reddit OAuth responses carry x-ratelimit-* headers. `reset` is SECONDS until
// the window resets (not an epoch), unlike X.
export function parseRedditRateLimit(
  res: { status: number; headers: { get(name: string): string | null } },
  now: number = Date.now()
): RateLimitInfo {
  const remainingRaw = res.headers.get('x-ratelimit-remaining');
  const resetRaw = res.headers.get('x-ratelimit-reset');
  const remaining = remainingRaw != null ? Number(remainingRaw) : undefined;
  const resetSecs = resetRaw != null ? Number(resetRaw) : undefined;
  const resetAt =
    resetSecs != null && !Number.isNaN(resetSecs)
      ? new Date(now + resetSecs * 1000)
      : undefined;
  return {
    remaining: Number.isNaN(remaining as number) ? undefined : remaining,
    resetAt,
    retryAfterMs:
      res.status === 429 && resetSecs != null && !Number.isNaN(resetSecs)
        ? resetSecs * 1000
        : undefined,
    limited: res.status === 429,
  };
}

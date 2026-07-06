// Defensive parsing of X internal-GraphQL tweet nodes into a flat shape. X has
// shipped several response variants over time (legacy vs core user fields, note
// tweets, visibility wrappers); this tolerates all of them and returns null for
// anything it can't read rather than throwing.

export interface ParsedTweet {
  id: string;
  text: string;
  createdAt: string; // ISO 8601
  authorUsername: string;
  authorDisplayName?: string;
  authorAvatarUrl?: string;
  authorFollowers?: number;
  likes: number;
  replies: number;
  retweets: number;
  quotes: number;
  bookmarks: number;
  views: number;
}

/** Unwrap a `tweet_results.result` node to the actual tweet object. */
export function unwrapTweet(result: any): any | null {
  if (!result) return null;
  if (result.__typename === 'TweetWithVisibilityResults') {
    return result.tweet ?? null;
  }
  // Some shapes nest the tweet without a __typename discriminator.
  if (result.tweet && !result.legacy) return result.tweet;
  return result;
}

export function parseTweetResult(result: any): ParsedTweet | null {
  const t = unwrapTweet(result);
  const legacy = t?.legacy;
  const id = t?.rest_id ?? legacy?.id_str;
  if (!t || !legacy || !id) return null;

  // The publish time MUST come from the tweet itself. A missing/unparseable
  // created_at used to fall back to `new Date()`, which silently stamped the
  // SCAN moment as the publish time — corrupting recency scoring and the feed's
  // date on every affected opportunity. We never fabricate it: an undateable
  // tweet is treated as unparseable and dropped, consistent with returning null
  // for anything we can't reliably read.
  const createdAtMs = legacy.created_at ? Date.parse(legacy.created_at) : NaN;
  if (!Number.isFinite(createdAtMs)) return null;

  const user = t?.core?.user_results?.result;
  const uLegacy = user?.legacy;
  const screenName = uLegacy?.screen_name ?? user?.core?.screen_name ?? '';
  const name = uLegacy?.name ?? user?.core?.name;
  let avatar: string | undefined =
    user?.avatar?.image_url ?? uLegacy?.profile_image_url_https ?? undefined;
  if (avatar) avatar = avatar.replace('_normal', '_400x400');
  const followers =
    typeof uLegacy?.followers_count === 'number'
      ? uLegacy.followers_count
      : undefined;

  // Longform "note" tweets carry the full body separately from legacy.full_text.
  const noteText = t?.note_tweet?.note_tweet_results?.result?.text;
  const text = noteText ?? legacy.full_text ?? legacy.text ?? '';
  const views = Number(t?.views?.count ?? 0) || 0;

  return {
    id: String(id),
    text: String(text),
    createdAt: new Date(createdAtMs).toISOString(),
    authorUsername: String(screenName || ''),
    authorDisplayName: name ? String(name) : undefined,
    authorAvatarUrl: avatar || undefined,
    authorFollowers: followers,
    likes: Number(legacy.favorite_count) || 0,
    replies: Number(legacy.reply_count) || 0,
    retweets: Number(legacy.retweet_count) || 0,
    quotes: Number(legacy.quote_count) || 0,
    bookmarks: Number(legacy.bookmark_count) || 0,
    views,
  };
}

/** Parse tweet entries from any X timeline instruction list. */
export function parseTimelineTweets(instructions: any[]): ParsedTweet[] {
  const tweets: ParsedTweet[] = [];
  const push = (result: any) => {
    const parsed = parseTweetResult(result);
    if (parsed) tweets.push(parsed);
  };
  for (const instruction of instructions ?? []) {
    for (const entry of instruction?.entries ?? []) {
      const id: string = entry?.entryId ?? '';
      const content = entry?.content;
      if (id.startsWith('tweet-')) {
        push(content?.itemContent?.tweet_results?.result);
      } else if (Array.isArray(content?.items)) {
        for (const item of content.items) {
          push(item?.item?.itemContent?.tweet_results?.result);
        }
      }
    }
  }
  return tweets;
}

/** Compare two numeric-string tweet ids without precision loss; larger = newer. */
export function newerId(
  a?: string | null,
  b?: string | null
): string | undefined {
  if (a == null) return b ?? undefined;
  if (b == null) return a ?? undefined;
  try {
    return BigInt(a) >= BigInt(b) ? a : b;
  } catch {
    return a;
  }
}

/** True when `id` is strictly newer than `sinceId` (or no sinceId set). */
export function isNewerThan(id: string, sinceId?: string | null): boolean {
  if (!sinceId) return true;
  try {
    return BigInt(id) > BigInt(sinceId);
  } catch {
    return true;
  }
}

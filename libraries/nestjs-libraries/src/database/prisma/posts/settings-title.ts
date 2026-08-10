// Where a post's headline actually lives inside `Post.settings`.
//
// Every title-submitting platform stores it somewhere different, and there is
// no single field that covers them all:
//
//   reddit / lemmy   settings.subreddit[0].value.title   (nested per community)
//   devto / medium /
//   hackernews /
//   hashnode / …     settings.title                     (top level)
//
// This is deliberately the ONE place that knowledge lives. Both the write path
// (createOrUpdatePost, which persists it to Post.title) and the read path
// (getDuePublishPosts, which must still cope with rows written before that)
// call in here, so the two can never drift apart — they already did once:
// getDuePublishPosts read only `settings.title`, which is simply not where
// Reddit keeps it, so every Reddit post reached the extension titleless, was
// rejected as "reddit post needs a title", and — because a rejected item never
// leaves Post.state=QUEUE — was re-offered on every poll forever.

/** Platforms whose title is nested under `settings.subreddit[].value.title`. */
export const COMMUNITY_TITLE_PLATFORMS = ['reddit', 'lemmy'];

/**
 * The post title carried in `settings`, or undefined when there is none.
 * `settings` is the already-parsed object (callers own the JSON.parse, since
 * they differ on how a malformed blob should be handled).
 *
 * Falls back to the top-level `settings.title` for EVERY platform, including
 * the community ones: a caller that shaped the settings by hand may have put
 * it there, and an unexpected title is better than a titleless post.
 */
export function titleFromSettings(
  platform: string | null | undefined,
  settings: Record<string, any> | null | undefined
): string | undefined {
  if (!settings) return undefined;
  const p = (platform || settings.__type || '').toLowerCase();

  if (COMMUNITY_TITLE_PLATFORMS.includes(p)) {
    const nested = settings.subreddit?.[0]?.value?.title;
    if (typeof nested === 'string' && nested.trim()) return nested;
  }

  const top = settings.title;
  if (typeof top === 'string' && top.trim()) return top;

  return undefined;
}

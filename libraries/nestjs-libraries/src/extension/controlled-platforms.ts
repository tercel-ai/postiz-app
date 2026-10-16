export const canonicalControlledPlatform = (platform: string) => platform === 'linkedin-page' ? 'linkedin' : platform;

export const CONTROLLED_SEND_PLATFORMS = [
  'x', 'reddit', 'linkedin', 'medium', 'quora', 'hackernews', 'devto',
] as const;

export function controlledReplySettings(platform: string, id: string, url?: string) {
  platform = canonicalControlledPlatform(platform);
  if (platform === 'x') return { reply_to_tweet_id: id };
  if (platform === 'reddit') return { replyToId: id };
  if (!(CONTROLLED_SEND_PLATFORMS as readonly string[]).includes(platform)) return null;
  return { replyToId: id, ...(url ? { replyUrl: url } : {}) };
}

export function hasControlledReplyTarget(platform: string, settings: Record<string, unknown>) {
  platform = canonicalControlledPlatform(platform);
  if (platform === 'x') return typeof settings.reply_to_tweet_id === 'string' && !!settings.reply_to_tweet_id;
  if (platform === 'reddit') return typeof settings.replyToId === 'string' && !!settings.replyToId;
  // Opaque external IDs alone cannot reconstruct every platform's target URL.
  if (!(CONTROLLED_SEND_PLATFORMS as readonly string[]).includes(platform) || typeof settings.replyUrl !== 'string') return false;
  try {
    const url = new URL(settings.replyUrl);
    const hosts: Record<string, string[]> = {
      linkedin: ['linkedin.com', 'www.linkedin.com', 'lnkd.in'],
      medium: ['medium.com', 'www.medium.com'], quora: ['quora.com', 'www.quora.com'],
      hackernews: ['news.ycombinator.com'], devto: ['dev.to', 'www.dev.to'],
    };
    const knownHost = !!hosts[platform]?.includes(url.hostname) ||
      (platform === 'quora' && /^[a-z0-9-]+\.quora\.com$/.test(url.hostname));
    // Medium custom publications are addressed through their canonical story ID.
    const mediumStory = platform === 'medium' && /(?:\/p\/|[-/])[a-f0-9]{12}(?:\/|$)/i.test(url.pathname);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (knownHost || mediumStory) && url.pathname !== '/';
  } catch { return false; }
}

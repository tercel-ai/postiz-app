// Medium scan executor via Medium's public RSS feeds (Medium has no search API):
//   keyword / channel → https://medium.com/feed/tag/<tag>
//   tracked           → https://medium.com/feed/@<user>   (or /feed/<publication>)
// The feed is newest-first, so incremental is TIME-based (like the Reddit/Dev.to
// scanners): stop once an item is older than the cursor's lastSeenAt.
//
// The MV3 service worker has NO DOMParser, so the RSS XML is parsed with small,
// well-scoped regexes over <item> blocks (CDATA-aware). Gated OFF by default via
// MEDIUM_EXECUTOR_ENABLED — the fetch carries the user's medium.com session.
//
// RSS has no clap/response counts, so scanned Medium posts have no engagement
// metrics (a later metrics.medium pass fills them when enabled).

import {
  EngageScanTask,
  ScanIngestPost,
  ScanRunResult,
  ScanTaskCursor,
} from './executor.types';

const MEDIUM_BASE = 'https://medium.com';

/** Build the RSS feed URL for a task. */
export function buildMediumFeedUrl(task: EngageScanTask): string {
  if (task.scanType === 'tracked') {
    const key = task.scanKey.trim().replace(/^\/+|\/+$/g, '');
    // @user → author feed; bare word → publication feed.
    const path = key.startsWith('@') ? key : `@${key.replace(/^@/, '')}`;
    return `${MEDIUM_BASE}/feed/${path}`;
  }
  const tag = encodeURIComponent(task.scanKey.trim().toLowerCase().replace(/\s+/g, '-'));
  return `${MEDIUM_BASE}/feed/tag/${tag}`;
}

/** Strip one layer of CDATA / HTML tags / entities to plain text. */
function unwrap(raw: string): string {
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function tagContent(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : null;
}

export interface MediumFeedItem {
  guid: string;
  link: string;
  title: string;
  author: string;
  contentSnippet: string;
  publishedAtMs: number | null;
}

/**
 * Parse a Medium RSS document into items WITHOUT DOMParser. Exposed for tests.
 * Each <item> yields guid/link/title/dc:creator/pubDate/content:encoded.
 */
export function parseMediumFeed(xml: string): MediumFeedItem[] {
  const items: MediumFeedItem[] = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  for (const block of blocks) {
    const link = unwrap(tagContent(block, 'link') ?? '');
    const guid = unwrap(tagContent(block, 'guid') ?? '') || link;
    const title = unwrap(tagContent(block, 'title') ?? '');
    const author = unwrap(
      tagContent(block, 'dc:creator') ?? tagContent(block, 'creator') ?? ''
    );
    const pub = tagContent(block, 'pubDate');
    const publishedAtMs = pub ? Date.parse(unwrap(pub)) : NaN;
    const contentRaw =
      tagContent(block, 'content:encoded') ??
      tagContent(block, 'description') ??
      '';
    items.push({
      guid,
      link: link.split(/[?#]/)[0],
      title,
      author,
      contentSnippet: unwrap(contentRaw).slice(0, 500),
      publishedAtMs: Number.isFinite(publishedAtMs) ? publishedAtMs : null,
    });
  }
  return items;
}

/** Derive a stable external id from a Medium post URL (the trailing hash). */
export function mediumExternalId(link: string, guid: string): string {
  const fromUrl = link.split(/[?#]/)[0].match(/-([0-9a-f]{6,})$/i)?.[1];
  if (fromUrl) return fromUrl;
  const fromGuid = guid.match(/([0-9a-f]{6,})$/i)?.[1];
  return fromGuid || link || guid;
}

export async function scanMedium(
  task: EngageScanTask,
  gate: () => Promise<boolean>
): Promise<ScanRunResult> {
  const { cursor } = task;
  if (!(await gate())) {
    return { posts: [], nextCursor: cursor, exhausted: false };
  }

  let xml = '';
  try {
    const res = await fetch(buildMediumFeedUrl(task), {
      credentials: 'include',
      headers: { accept: 'application/rss+xml, application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`[aisee][scan][medium] ${res.status} for ${task.scanKey}`);
      return { posts: [], nextCursor: cursor, exhausted: false };
    }
    xml = await res.text();
  } catch (e) {
    console.warn('[aisee][scan][medium] fetch failed', e);
    return { posts: [], nextCursor: cursor, exhausted: false };
  }

  const stopBefore = cursor.lastSeenAt ? Date.parse(cursor.lastSeenAt) : null;
  const items = parseMediumFeed(xml);
  const posts: ScanIngestPost[] = [];
  let newestAtMs = stopBefore ?? 0;
  let newestId: string | null = cursor.lastSeenExternalId ?? null;
  let firstSeen = false;

  for (const it of items) {
    if (it.publishedAtMs == null || !it.link) continue; // undateable → drop
    if (stopBefore != null && it.publishedAtMs <= stopBefore) continue; // already seen
    const id = mediumExternalId(it.link, it.guid);
    if (!firstSeen || it.publishedAtMs > newestAtMs) {
      newestId = id;
      newestAtMs = it.publishedAtMs;
    }
    firstSeen = true;
    posts.push({
      platform: 'medium',
      externalPostId: id,
      externalPostUrl: it.link,
      authorUsername: it.author,
      postContent: `${it.title}${it.contentSnippet ? '\n' + it.contentSnippet : ''}`.trim(),
      postPublishedAt: new Date(it.publishedAtMs).toISOString(),
    });
  }

  const nextCursor: ScanTaskCursor = {
    lastSeenExternalId: newestId,
    lastSeenAt: newestAtMs > 0 ? new Date(newestAtMs).toISOString() : cursor.lastSeenAt,
  };
  console.debug('[aisee][scan][medium] complete', {
    scanType: task.scanType,
    scanKey: task.scanKey,
    parsed: items.length,
    posts: posts.length,
  });
  // RSS returns the full recent window in one shot — always exhausted.
  return { posts, nextCursor, exhausted: true };
}

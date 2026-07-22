// Self-contained functions injected into linkedin.com via
// chrome.scripting.executeScript. Each MUST be fully self-contained (no
// outer-scope references) — executeScript serialises the function and runs it in
// the page, so module imports and shared helpers are invisible to it. They read
// only what LinkedIn's own web app already rendered for the logged-in user (DOM
// scrape), never calling the Voyager API from the worker.
//
// The parsing here is intentionally duplicated from dom.ts (which stays
// node-testable): keeping the page scripts standalone is the constraint that
// forces the copy, exactly like x.poster's in-page helpers vs x.parse.

/** True when the current page is a LinkedIn login / auth-wall (not signed in). */
export function detectLinkedinAuthWall(): boolean {
  const text = [
    window.location.href || '',
    document.title || '',
    document.body ? (document.body.innerText || '').slice(0, 4000) : '',
  ]
    .join('\n')
    .toLowerCase();
  return (
    /linkedin\.com\/(?:login|checkpoint|authwall|uas)/i.test(text) ||
    /\b(sign in|log in|join linkedin|captcha|verification required)\b/i.test(
      text
    ) ||
    /(请登录|登录领英|安全验证)/.test(text)
  );
}

/** Raw post row shape returned by extractLinkedinPosts (mirrors RawLinkedinPost). */
export interface ScrapedPostsPayload {
  rows: Array<{
    author: string;
    authorProfileUrl: string;
    authorAvatarUrl: string;
    posted_at: string;
    body: string;
    reactions: number;
    comments: number;
    reposts: number;
    impressions: number;
    url: string;
    urn: string;
    raw_text: string;
  }>;
  url: string;
  title: string;
}

/**
 * Extract post cards from a LinkedIn search-content / feed / activity page.
 * Adapted from ../opencli/clis/linkedin/posts-core.js buildPostsScript, kept
 * fully self-contained so it can be serialised by executeScript.
 */
export function extractLinkedinPosts(): ScrapedPostsPayload {
  const clean = (s: unknown) =>
    String(s || '')
      .replace(/[  ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const parseMetric = (s: unknown) => {
    const raw = clean(s).toLowerCase().replace(/,/g, '');
    const m = raw.match(/(\d+(?:\.\d+)?)(k|m)?/i);
    if (!m) return 0;
    const n = Number(m[1]);
    if ((m[2] || '').toLowerCase() === 'k') return Math.round(n * 1000);
    if ((m[2] || '').toLowerCase() === 'm') return Math.round(n * 1000000);
    return Math.round(n);
  };
  const parseReactionText = (value: unknown) => {
    const text = clean(value);
    const explicit = text.match(/(\d[\d,.]*\s*(?:k|m)?\s+reactions?)/i);
    if (explicit) return parseMetric(explicit[1]);
    const namedOthers = text.match(
      /(?:^|\s)(\d[\d,.]*\s*(?:k|m)?)\s+[A-Z][^.!?\n]{0,100}\s+and\s+\d[\d,.]*\s+others/i
    );
    if (namedOthers) return parseMetric(namedOthers[1]);
    const beforeComments = text.match(
      /(?:^|\s)(\d[\d,.]*\s*(?:k|m)?)\s+(?:\d[\d,.]*\s+comments?|\d[\d,.]*\s+reposts?)/i
    );
    if (beforeComments) return parseMetric(beforeComments[1]);
    const andOthers = text.match(/\band\s+(\d[\d,.]*\s*(?:k|m)?)\s+others?\b/i);
    if (andOthers) return parseMetric(andOthers[1]) + 1;
    const trailing = text.match(/(?:^|\s)(\d[\d,.]*\s*(?:k|m)?)\s*$/i);
    return trailing ? parseMetric(trailing[1]) : 0;
  };
  const safeHttpUrl = (value: string) => {
    try {
      const parsed = new URL(value, location.origin);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        return '';
      if (parsed.username || parsed.password) return '';
      return parsed.toString();
    } catch {
      return '';
    }
  };
  const stopLine = (line: string) =>
    /^(like|comment|repost|send|share|copy link|follow|following|connect|message|activate to view|promoted|show more|see more)$/i.test(
      line
    ) ||
    /^\d[\d,.]*\s*(?:k|m)?\s+(?:reactions?|comments?|reposts?|shares?|impressions?)$/i.test(
      line
    ) ||
    /^[A-Z][A-Za-z ]+\s+and\s+\d[\d,.]*\s+others$/i.test(line);
  const readBody = (root: Element, lines: string[]) => {
    const selectors = [
      '.feed-shared-update-v2__description',
      '.update-components-text',
      '.feed-shared-text',
      '[data-test-id*="main-feed-activity-card"] [dir="ltr"]',
      '[class*="update-components-text"]',
    ];
    for (const selector of selectors) {
      const node = root.querySelector(selector) as HTMLElement | null;
      const value = clean(node?.innerText || node?.textContent || '');
      if (value && value.length > 8) return value.replace(/…more$/i, '').trim();
    }
    const timestampIndex = lines.findIndex((line) =>
      /^\d+\s*(?:s|m|h|d|w|mo|yr|min)\b/i.test(line)
    );
    const start =
      timestampIndex >= 0 ? timestampIndex + 1 : Math.min(3, lines.length);
    const body: string[] = [];
    for (const line of lines.slice(start)) {
      if (stopLine(line)) break;
      if (/^(visible to anyone|edited|author|view .* profile)$/i.test(line))
        continue;
      body.push(line);
    }
    return clean(body.join(' ')).replace(/…more$/i, '').trim();
  };

  const cards = Array.from(
    document.querySelectorAll(
      'article, [role="article"], .feed-shared-update-v2, .occludable-update'
    )
  ).filter(
    (card) =>
      clean((card as HTMLElement).innerText || card.textContent || '').length >
      60
  );
  const rows: ScrapedPostsPayload['rows'] = [];
  const seen = new Set<Element>();
  for (const card of cards) {
    const root =
      card.closest(
        'article, [role="article"], .feed-shared-update-v2, .occludable-update'
      ) || card;
    if (!root || seen.has(root)) continue;
    seen.add(root);
    const rawFullText = String(
      (root as HTMLElement).innerText || root.textContent || ''
    );
    const rawText = clean(rawFullText);
    if (!rawText || rawText.length < 20) continue;
    const permalink = root.querySelector(
      'a[href*="/feed/update/"], a[href*="/posts/"], a[href*="/pulse/"]'
    ) as HTMLAnchorElement | null;
    const url = permalink?.href
      ? new URL(permalink.href, location.origin).toString()
      : '';
    const urnEl = root.getAttribute('data-urn') || '';
    const urn = urnEl || (url.match(/urn:li:[a-z]+:\d+/i) || [''])[0];
    const authorLink = root.querySelector(
      'a[href*="/in/"], a[href*="/company/"]'
    ) as HTMLAnchorElement | null;
    const authorProfileUrl = authorLink?.href
      ? safeHttpUrl(authorLink.href)
      : '';
    const avatarImg = root.querySelector(
      'img[class*="presence-entity__image"], img.ivm-view-attr__img--centered, img[class*="EntityPhoto"]'
    ) as HTMLImageElement | null;
    const authorAvatarUrl = avatarImg
      ? safeHttpUrl(avatarImg.currentSrc || avatarImg.src || '')
      : '';
    const lines = rawFullText.split(/\n+/).map(clean).filter(Boolean);
    const author =
      clean(authorLink?.innerText || authorLink?.textContent || '') ||
      lines.find(
        (line) =>
          line &&
          !/^feed post/i.test(line) &&
          !/verified|you|senior|engineer|developer/i.test(line)
      ) ||
      '';
    const timestamp = (rawText.match(/\b\d+\s*(?:s|m|h|d|w|mo|yr|min)\b/i) || [
      '',
    ])[0];
    const reactions = parseReactionText(rawText);
    const comments = parseMetric(
      (rawText.match(/(\d[\d,.]*\s*(?:k|m)?\s+comments?)/i) || [''])[0]
    );
    const reposts = parseMetric(
      (rawText.match(/(\d[\d,.]*\s*(?:k|m)?\s+reposts?)/i) || [''])[0]
    );
    const impressions = parseMetric(
      (rawText.match(/(\d[\d,.]*\s*(?:k|m)?\s+impressions?)/i) || [''])[0]
    );
    const body = readBody(root, lines);
    if (!body && !url) continue;
    rows.push({
      author,
      authorProfileUrl,
      authorAvatarUrl,
      posted_at: timestamp,
      body,
      reactions,
      comments,
      reposts,
      impressions,
      url,
      urn,
      raw_text: rawText,
    });
  }
  return { rows, url: location.href, title: document.title || '' };
}

/** Single-post counters scraped from a post detail page. */
export interface ScrapedPostMetrics {
  reactions: number;
  comments: number;
  reposts: number;
  impressions: number;
  found: boolean;
}

/**
 * Extract engagement counters from a single LinkedIn post page. Reads the
 * social-counts bar of the FIRST (main) post on the page. `impressions` is only
 * present on the author's own posts (LinkedIn hides it from other viewers).
 */
export function extractLinkedinPostMetrics(): ScrapedPostMetrics {
  const clean = (s: unknown) =>
    String(s || '')
      .replace(/[  ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const parseMetric = (s: unknown) => {
    const raw = clean(s).toLowerCase().replace(/,/g, '');
    const m = raw.match(/(\d+(?:\.\d+)?)(k|m)?/i);
    if (!m) return 0;
    const n = Number(m[1]);
    if ((m[2] || '').toLowerCase() === 'k') return Math.round(n * 1000);
    if ((m[2] || '').toLowerCase() === 'm') return Math.round(n * 1000000);
    return Math.round(n);
  };
  const parseReactionText = (value: unknown) => {
    const text = clean(value);
    const explicit = text.match(/(\d[\d,.]*\s*(?:k|m)?\s+reactions?)/i);
    if (explicit) return parseMetric(explicit[1]);
    const namedOthers = text.match(
      /(?:^|\s)(\d[\d,.]*\s*(?:k|m)?)\s+[A-Z][^.!?\n]{0,100}\s+and\s+\d[\d,.]*\s+others/i
    );
    if (namedOthers) return parseMetric(namedOthers[1]);
    const beforeComments = text.match(
      /(?:^|\s)(\d[\d,.]*\s*(?:k|m)?)\s+(?:\d[\d,.]*\s+comments?|\d[\d,.]*\s+reposts?)/i
    );
    if (beforeComments) return parseMetric(beforeComments[1]);
    const andOthers = text.match(/\band\s+(\d[\d,.]*\s*(?:k|m)?)\s+others?\b/i);
    if (andOthers) return parseMetric(andOthers[1]) + 1;
    return 0;
  };
  const root =
    document.querySelector(
      'article, [role="article"], .feed-shared-update-v2, .occludable-update'
    ) || document.body;
  if (!root) {
    return { reactions: 0, comments: 0, reposts: 0, impressions: 0, found: false };
  }
  const rawText = clean(
    (root as HTMLElement).innerText || root.textContent || ''
  );
  const reactions = parseReactionText(rawText);
  const comments = parseMetric(
    (rawText.match(/(\d[\d,.]*\s*(?:k|m)?\s+comments?)/i) || [''])[0]
  );
  const reposts = parseMetric(
    (rawText.match(/(\d[\d,.]*\s*(?:k|m)?\s+reposts?)/i) || [''])[0]
  );
  const impressions = parseMetric(
    (rawText.match(/(\d[\d,.]*\s*(?:k|m)?\s+impressions?)/i) || [''])[0]
  );
  return {
    reactions,
    comments,
    reposts,
    impressions,
    found: rawText.length > 20,
  };
}

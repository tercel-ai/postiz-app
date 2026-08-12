// Quora scan executor. Quora has NO public API, so — like the LinkedIn scanner —
// it opens a real background quora.com tab with the user's own session and
// scrapes the rendered DOM. Whether it runs is governed by the backend scan
// allowlist (the server only leases Quora tasks when the platform is allowed).
//   keyword / channel → /search?q=<kw>&type=answer
//   tracked           → /profile/<user>
//
// Quora's markup is a heavily obfuscated SPA, so scraping is best-effort. Quora
// rarely exposes a machine-readable publish time in search results; following
// the same discipline as every other scanner, an undateable answer is DROPPED
// (never stamped with a fabricated time), so yield depends on Quora surfacing a
// timestamp on the card.

import {
  EngageScanTask,
  ScanIngestPost,
  ScanRunResult,
  ScanTaskCursor,
} from './executor.types';
import { closeTab, openTab, runInPage, sleep } from '@gitroom/extension/utils/tab-automation';

const QUORA_BASE = 'https://www.quora.com';
const RENDER_SETTLE_MS = 2_500;

/** Build the search / profile URL for a task. */
export function buildQuoraScanUrl(task: EngageScanTask): string {
  if (task.scanType === 'tracked') {
    const user = task.scanKey.trim().replace(/^\/+|\/+$/g, '').replace(/^profile\//, '');
    return `${QUORA_BASE}/profile/${encodeURIComponent(user)}`;
  }
  const q = encodeURIComponent(task.rawQuery || task.scanKey);
  return `${QUORA_BASE}/search?q=${q}&type=answer`;
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Parse a Quora time string ("2y", "answered 3mo ago", "March 5, 2023", "Jun 16",
 * "Sat") to an epoch-ms relative to `nowMs`, or null when it can't be dated.
 * Exposed for tests.
 */
export function quoraTimeToMs(raw: string | null | undefined, nowMs: number): number | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const rel = s.match(/(\d+)\s*(y|mo|w|d|h|m)\b/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const ms: Record<string, number> = {
      y: 365 * 24 * 3600e3,
      mo: 30 * 24 * 3600e3,
      w: 7 * 24 * 3600e3,
      d: 24 * 3600e3,
      h: 3600e3,
      m: 60e3,
    };
    if (ms[unit]) return nowMs - n * ms[unit];
  }
  // Quora labels anything within the last week with a bare weekday
  // ("Sat") — no date at all. Resolve to the most recent past (or today's)
  // occurrence of that weekday.
  const weekday = s.match(/^(sun|mon|tue|wed|thu|fri|sat)$/i);
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday[1].toLowerCase());
    const now = new Date(nowMs);
    const diff = (now.getDay() - target + 7) % 7;
    const result = new Date(now);
    result.setDate(now.getDate() - diff);
    result.setHours(0, 0, 0, 0);
    return result.getTime();
  }
  // Anything older than a week but within the current year is labelled
  // "Mon D" with NO year — `Date.parse` on that alone defaults to a fixed
  // reference year (e.g. 2001 in V8), silently fabricating the wrong decade,
  // so it must be resolved against `nowMs` instead of falling through.
  const monthDay = s.match(/^([A-Za-z]{3})\s+(\d{1,2})$/);
  if (monthDay) {
    const now = new Date(nowMs);
    const candidate = new Date(`${monthDay[1]} ${monthDay[2]}, ${now.getFullYear()}`);
    if (Number.isFinite(candidate.getTime())) {
      // Quora never shows a future date without a year, so a same-year guess
      // landing after "now" actually belongs to last year.
      if (candidate.getTime() > nowMs) {
        candidate.setFullYear(now.getFullYear() - 1);
      }
      return candidate.getTime();
    }
  }
  const abs = Date.parse(s.replace(/^(answered|updated)\s+/i, ''));
  return Number.isFinite(abs) ? abs : null;
}

export interface ScrapedQuoraRow {
  url: string;
  author: string;
  text: string;
  upvotes: number | null;
  comments: number | null;
  shares: number | null;
  timeText: string;
}

/**
 * Runs INSIDE the quora.com page (self-contained). Collects answer cards:
 * their permalink, author, text snippet, engagement counters and time label.
 * Exposed for tests (jsdom), not called anywhere but `scanQuora`.
 */
export function scrapeQuoraInPage(): ScrapedQuoraRow[] {
  const norm = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
  const stripQuery = (raw: string | null | undefined) => String(raw || '').split(/[?#]/)[0];
  const parseNum = (raw: string | null | undefined): number | null => {
    const m = (raw || '').replace(/[,\s]/g, '').match(/(\d+(?:\.\d+)?)([KM])?/i);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    const suf = (m[2] || '').toUpperCase();
    if (suf === 'K') n *= 1000;
    else if (suf === 'M') n *= 1000000;
    return Math.round(n);
  };

  // Quora sizes a counter by rendering a HIDDEN "999" spacer next to it and
  // overlaying the real number absolutely on top, so `textContent` on the
  // upvote button of a 658-upvote answer reads "Upvote · 999658". Concatenate
  // only the text nodes that sit outside one of those spacers.
  const HIDDEN = /qu-visibility--hidden|qu-display--none/;
  const visibleText = (root: Element): string => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let out = '';
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let el: HTMLElement | null = node.parentElement;
      let hidden = false;
      while (el && el !== root.parentElement) {
        // SVG elements expose className as an SVGAnimatedString — String() on
        // it is inert here, it just never matches.
        if (HIDDEN.test(String(el.className || ''))) {
          hidden = true;
          break;
        }
        el = el.parentElement;
      }
      if (!hidden) out += node.nodeValue;
    }
    return norm(out);
  };

  /** The counter on a "<n> comments" / "<n> shares" button, via its aria-label. */
  const labelledCount = (scope: Element | null, noun: string): number | null => {
    const re = new RegExp(`^[\\d.,km]+\\s+${noun}s?$`, 'i');
    const btn = Array.from(scope?.querySelectorAll('button') || []).find((b) =>
      re.test(b.getAttribute('aria-label') || '')
    );
    return btn ? parseNum(btn.getAttribute('aria-label')) : null;
  };

  const rows: ScrapedQuoraRow[] = [];
  const seen = new Set<string>();
  // Anchor on the answer's own timestamp link: its href IS the answer permalink
  // and its text IS the publish label — the two fields ingest hard-requires.
  // Enumerating every quora.com link instead (as this once did) makes the site
  // chrome — the logo, /following, /spaces, /notifications — look like answers:
  // each is a unique href whose card walk climbs out to the whole page, so they
  // fill the row budget with 8k-char nav blobs before a real answer is seen.
  const ANCHOR_SEL = 'a[class*="answer_timestamp"], a[href*="/answer/"]';
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>(ANCHOR_SEL));
  for (const a of anchors) {
    let href = stripQuery(a.getAttribute('href'));
    if (!href) continue;
    if (href.startsWith('/')) href = 'https://www.quora.com' + href;
    if (!/quora\.com\//.test(href)) continue;
    if (seen.has(href)) continue;

    // Walk up to the answer BODY. The byline block directly wrapping the
    // timestamp is ~90 chars and holds the author line ONLY — no answer text —
    // so a low threshold stops one level short of the content and every row
    // then fails the server-side keyword match. A real body is 300+ chars.
    let body: HTMLElement | null = a;
    for (let i = 0; i < 12 && body; i++) {
      if ((body.textContent || '').length >= 300) break;
      body = body.parentElement;
    }
    const bodyText = norm(body?.textContent);
    if (bodyText.length < 60) continue;

    // Then keep climbing to the CARD — the question title and the action bar
    // (upvote / comments / shares) are siblings of the body, several levels
    // further out. The ONLY stop condition is isolation: go up while the next
    // parent still holds exactly this one answer. Stopping early at "the first
    // ancestor that contains a button" looks tempting but lands 3 levels too
    // low — the action bar shows up long before the question title does.
    let card: HTMLElement = body as HTMLElement;
    for (let i = 0; i < 8; i++) {
      const parent = card.parentElement;
      if (!parent || parent.querySelectorAll(ANCHOR_SEL).length > 1) break;
      card = parent;
    }

    // Quora emits BOTH relative ("/profile/x") and absolute
    // ("https://www.quora.com/profile/x") profile hrefs on the same card, and
    // the anchor text is often empty (avatar-only link) — so match the href
    // loosely and take the slug from it rather than from the text.
    const profileHref = stripQuery(
      card.querySelector<HTMLAnchorElement>('a[href*="/profile/"]')?.getAttribute('href')
    );
    const author = profileHref.split('/profile/')[1] || '';

    // Comments and shares state their count in the aria-label ("159 comments").
    // The upvote control does NOT — it is labelled just "Upvote" — so its count
    // has to come from the rendered text, which reads "Upvote658" / "Upvote1.5K"
    // once the hidden 999-spacer is stripped. Parsing the raw textContent
    // instead would persist 999658 and hand the post a top-band heat score.
    const voteBtn = Array.from(card.querySelectorAll('button')).find((b) =>
      /^upvote\b/i.test(b.getAttribute('aria-label') || '')
    );
    const upvotes = voteBtn
      ? parseNum(visibleText(voteBtn).replace(/^upvote/i, ''))
      : null;

    // postContent must be the QUESTION + ANSWER only. Feeding the whole card in
    // drags the byline along ("Geo Ashe · Follow BSME in Engineering…"), and the
    // server-side keyword filter then matches author names and bios: a scan for
    // "geo" hit 10/10 rows purely on users called Geo Ashe / Geo Kay, none of
    // which mention it in the answer. Quora tags both parts with stable
    // `puppeteer_test_*` hooks, so select them positively rather than trying to
    // subtract the byline.
    const titleEl = card.querySelector('[class*="question_title"]');
    const contentEl = card.querySelector('[class*="answer_content"]');
    let text = norm(
      [titleEl?.textContent, contentEl?.textContent].filter(Boolean).join(' ')
    );
    if (!text) {
      // Layout drift / a surface without those hooks — fall back to the body
      // with the byline block cut out, rather than losing the row entirely.
      const stripped = body!.cloneNode(true) as HTMLElement;
      stripped
        .querySelectorAll('[class*="spacing_log_answer_header"]')
        .forEach((el) => el.remove());
      text = norm(stripped.textContent) || bodyText;
    }

    seen.add(href);
    rows.push({
      url: href,
      author,
      text: text.slice(0, 500),
      upvotes,
      comments: labelledCount(card, 'comment'),
      shares: labelledCount(card, 'share'),
      // The timestamp anchor's own text — a relative unit ("3d", "2y"), a bare
      // weekday for the last week ("Sat"), "Mon D" within the current year, or
      // a full "Mon D, YYYY". quoraTimeToMs() resolves all four; reading it
      // straight off this anchor removes the old heuristic scan that could
      // latch onto a 4-digit year inside the author's bio line instead.
      timeText: norm(a.textContent),
    });
    if (rows.length >= 40) break;
  }
  return rows;
}

/**
 * Runs INSIDE the quora.com page (self-contained). True when the page is still
 * Cloudflare's "Just a moment…" managed-challenge interstitial rather than the
 * real Quora app — happens on a fresh session with no `cf_clearance` cookie yet,
 * and background (never-focused/never-moved) tabs are more likely to trip it.
 * Exposed for tests (jsdom), not called anywhere but `scanQuora`.
 *
 * Order matters: the app check comes FIRST. Quora keeps a Turnstile SDK
 * <script src="challenges.cloudflare.com/turnstile/v0/api.js"> in <head> of
 * EVERY page for its login flow, so testing for that script alone reported a
 * challenge on perfectly healthy pages — which made scanQuora burn the poll
 * budget and bail with zero posts on every single Quora unit.
 */
export function detectQuoraChallengeInPage(): boolean {
  // The interstitial REPLACES the document, so a rendered Quora app and a live
  // challenge can never coexist. `q-box` is Quora's server-rendered layout
  // primitive and is present on search, profile and question pages alike.
  if (document.querySelector('[class*="q-box"], [class*="answer_timestamp"]')) {
    return false;
  }
  if (document.querySelector('#challenge-running, #challenge-stage, #challenge-form')) {
    return true;
  }
  const title = (document.title || '').toLowerCase();
  if (/just a moment|attention required|请稍候|安全验证/.test(title)) {
    return true;
  }
  // A Turnstile widget MOUNT (not the SDK script) with no Quora app around it
  // is the interstitial mid-render.
  return !!document.querySelector('.cf-turnstile');
}

const CHALLENGE_POLL_MS = 1_500;
const CHALLENGE_MAX_WAIT_MS = 9_000;

export async function scanQuora(
  task: EngageScanTask,
  gate: () => Promise<boolean>
): Promise<ScanRunResult> {
  const { cursor } = task;
  // Every bail-out below returns the SAME shape a healthy empty scan would
  // (no posts, untouched cursor), so without a log line the ingest payload
  // cannot tell them apart — say which one fired.
  const bail = (why: string): ScanRunResult => {
    console.warn('[aisee][scan][quora] aborted', { why, scanType: task.scanType, scanKey: task.scanKey });
    return { posts: [], nextCursor: cursor, exhausted: false };
  };

  if (!(await gate())) return bail('pacing gate closed');

  const handle = await openTab(buildQuoraScanUrl(task), { settleMs: RENDER_SETTLE_MS });
  if (!handle) return bail('tab could not be opened');

  let rows: ScrapedQuoraRow[] | null = null;
  try {
    // Cloudflare's JS challenge auto-solves and reloads on its own — poll
    // instead of scraping the interstitial and reporting a false "0 results".
    let waited = 0;
    while (
      waited < CHALLENGE_MAX_WAIT_MS &&
      (await runInPage(handle.tabId, detectQuoraChallengeInPage))
    ) {
      await sleep(CHALLENGE_POLL_MS);
      waited += CHALLENGE_POLL_MS;
    }
    if (await runInPage(handle.tabId, detectQuoraChallengeInPage)) {
      // Still blocked after the wait budget — don't advance the cursor;
      // report not-exhausted so the backend keeps the unit due for a retry.
      return bail('cloudflare challenge did not clear');
    }

    const maxPages = Math.max(1, Math.floor(task.pacing.maxPages || 1));
    for (let page = 1; page < maxPages; page++) {
      await runInPage(handle.tabId, () =>
        window.scrollBy({ top: window.innerHeight * 1.5, behavior: 'smooth' })
      );
      await sleep(Math.max(700, task.pacing.pageDelayMs || 900));
    }
    rows = await runInPage(handle.tabId, scrapeQuoraInPage);
  } finally {
    await closeTab(handle.tabId);
  }

  if (!rows) return bail('scrape injection failed');

  const nowMs = Date.now();
  // Quora's /search is RELEVANCE-ranked, not reverse-chronological: the same
  // batch of years-old answers comes back every run, and the strongest ones are
  // usually the oldest. A "newer than last time" cursor buries them for good —
  // the coarsest label Quora prints is "1y", so the first run advances the
  // cursor to ~now-1y and every genuinely old, high-upvote answer is dropped
  // from then on. It also buys nothing here: the page is rendered and scraped in
  // full either way, and EngageOpportunity is upserted on
  // @@unique([platform, externalPostId]), so re-sending a post is a no-op.
  // Profile scans DO come back newest-first, so the cursor still earns its keep.
  const stopBefore =
    task.scanType === 'tracked' && cursor.lastSeenAt ? Date.parse(cursor.lastSeenAt) : null;
  const posts: ScanIngestPost[] = [];
  let newestAtMs = stopBefore ?? 0;
  let newestId: string | null = cursor.lastSeenExternalId ?? null;
  let firstSeen = false;

  for (const row of rows) {
    const atMs = quoraTimeToMs(row.timeText, nowMs);
    if (atMs == null) continue; // undateable → drop, never fabricate a publish time
    if (stopBefore != null && atMs <= stopBefore) continue;
    const id = row.url; // Quora has no short id; the permalink is the stable key
    if (!firstSeen || atMs > newestAtMs) {
      newestId = id;
      newestAtMs = atMs;
    }
    firstSeen = true;
    posts.push({
      platform: 'quora',
      externalPostId: id,
      externalPostUrl: row.url,
      authorUsername: row.author,
      postContent: row.text,
      postPublishedAt: new Date(atMs).toISOString(),
      // Quora's action bar is the platform's only public engagement signal, and
      // the community heat band is computed from upvotes + comments + shares —
      // omitting them floors every answer at the lowest band regardless of how
      // big it actually is.
      metricScore: row.upvotes ?? undefined,
      metricComments: row.comments ?? undefined,
      metricShares: row.shares ?? undefined,
    });
  }

  const nextCursor: ScanTaskCursor = {
    lastSeenExternalId: newestId,
    lastSeenAt: newestAtMs > 0 ? new Date(newestAtMs).toISOString() : cursor.lastSeenAt,
  };
  console.debug('[aisee][scan][quora] complete', {
    scanType: task.scanType,
    scanKey: task.scanKey,
    scraped: rows.length,
    posts: posts.length,
  });
  return { posts, nextCursor, exhausted: true };
}

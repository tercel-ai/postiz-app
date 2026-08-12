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

interface ScrapedQuoraRow {
  url: string;
  author: string;
  text: string;
  upvotes: number | null;
  timeText: string;
}

/**
 * Runs INSIDE the quora.com page (self-contained). Collects answer cards:
 * their permalink, author, text snippet, upvote count and any time label.
 */
function scrapeQuoraInPage(): ScrapedQuoraRow[] {
  const norm = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
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

  const rows: ScrapedQuoraRow[] = [];
  const seen = new Set<string>();
  // Answer permalinks contain "/answer/"; question links are "/<slug>".
  const anchors = Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/answer/"], a[href*="quora.com/"]')
  );
  for (const a of anchors) {
    let href = a.getAttribute('href') || '';
    if (!href) continue;
    if (href.startsWith('/')) href = 'https://www.quora.com' + href;
    if (!/quora\.com\//.test(href)) continue;
    href = href.split(/[?#]/)[0];
    if (seen.has(href)) continue;

    // Walk up to a reasonably-sized card container.
    let card: HTMLElement | null = a;
    for (let i = 0; i < 5 && card; i++) {
      if ((card.textContent || '').length > 120) break;
      card = card.parentElement;
    }
    const cardText = norm(card?.textContent);
    if (cardText.length < 40) continue; // skip nav/util links

    const authorEl = card?.querySelector<HTMLAnchorElement>('a[href^="/profile/"]');
    const upEl = Array.from(card?.querySelectorAll<HTMLElement>('button, span') || []).find((el) =>
      /upvote/i.test(el.getAttribute('aria-label') || el.textContent || '')
    );
    // Quora renders the answer date as one of three shapes depending on age:
    // a relative unit ("3d", "2y"), a bare weekday for the last week ("Sat"),
    // or "Mon D" (no year) for anything older within the current year — all
    // three must match here or quoraTimeToMs() never sees the text at all.
    // The author's bio line ("Founder at X (2021–present)") also carries a
    // 4-digit year and sits earlier in the card, so it's excluded by length —
    // a real date badge is always short, a bio sentence never is.
    const timeEl = Array.from(card?.querySelectorAll<HTMLElement>('a, span') || []).find((el) => {
      const t = norm(el.textContent);
      if (!t || t.length > 32) return false;
      return (
        /\b\d+\s*(y|mo|w|d|h)\b|answered|updated|\b(19|20)\d{2}\b/i.test(t) ||
        /^(sun|mon|tue|wed|thu|fri|sat)$/i.test(t) ||
        /^[a-z]{3}\s+\d{1,2}$/i.test(t)
      );
    });

    seen.add(href);
    rows.push({
      url: href,
      author: norm(authorEl?.textContent),
      text: cardText.slice(0, 500),
      upvotes: parseNum(upEl?.getAttribute('aria-label') || upEl?.textContent),
      timeText: norm(timeEl?.textContent),
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
 */
function detectQuoraChallengeInPage(): boolean {
  if (document.querySelector('#challenge-running, #challenge-stage, #challenge-form, .cf-turnstile')) {
    return true;
  }
  if (document.querySelector('script[src*="challenges.cloudflare.com"]')) {
    return true;
  }
  const title = (document.title || '').toLowerCase();
  return /just a moment|attention required|请稍候|安全验证/.test(title);
}

const CHALLENGE_POLL_MS = 1_500;
const CHALLENGE_MAX_WAIT_MS = 9_000;

export async function scanQuora(
  task: EngageScanTask,
  gate: () => Promise<boolean>
): Promise<ScanRunResult> {
  const { cursor } = task;
  if (!(await gate())) {
    return { posts: [], nextCursor: cursor, exhausted: false };
  }

  const handle = await openTab(buildQuoraScanUrl(task), { settleMs: RENDER_SETTLE_MS });
  if (!handle) return { posts: [], nextCursor: cursor, exhausted: false };

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
      return { posts: [], nextCursor: cursor, exhausted: false };
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

  if (!rows) return { posts: [], nextCursor: cursor, exhausted: false };

  const nowMs = Date.now();
  const stopBefore = cursor.lastSeenAt ? Date.parse(cursor.lastSeenAt) : null;
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
      metricScore: row.upvotes ?? undefined,
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

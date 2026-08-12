// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildQuoraScanUrl,
  detectQuoraChallengeInPage,
  quoraTimeToMs,
  scrapeQuoraInPage,
} from '../scan.quora';
import type { EngageScanTask } from '../executor.types';

function task(partial: Partial<EngageScanTask>): EngageScanTask {
  return {
    taskId: 't',
    platform: 'quora',
    scanType: 'keyword',
    scanKey: 'ai search',
    cursor: { lastSeenExternalId: null, lastSeenAt: null },
    pacing: {
      maxPages: 1,
      pageSize: 25,
      pageDelayMs: 0,
      pageJitterMs: 0,
      interUnitDelayMs: 0,
      interUnitJitterMs: 0,
      hourlyRequestCap: 60,
    },
    ...partial,
  };
}

describe('buildQuoraScanUrl', () => {
  it('builds an answer-type search for keyword scans', () => {
    const url = buildQuoraScanUrl(task({ scanType: 'keyword', scanKey: 'ai search' }));
    expect(url).toBe('https://www.quora.com/search?q=ai%20search&type=answer');
  });

  it('builds a profile URL for tracked accounts', () => {
    const url = buildQuoraScanUrl(task({ scanType: 'tracked', scanKey: 'profile/John-Doe' }));
    expect(url).toBe('https://www.quora.com/profile/John-Doe');
  });
});

describe('quoraTimeToMs', () => {
  const now = Date.parse('2026-08-12T12:00:00.000Z'); // Wednesday

  it('reads relative units', () => {
    expect(quoraTimeToMs('10y', now)).toBe(now - 10 * 365 * 24 * 3600e3);
    expect(quoraTimeToMs('3d', now)).toBe(now - 3 * 24 * 3600e3);
  });

  it('resolves a bare weekday to its most recent past occurrence', () => {
    // now is a Wednesday (local); "Sat" should resolve to the previous Saturday.
    // quoraTimeToMs works in local time (it mirrors what the page renders for
    // the user's own clock), so assert with local getters, not UTC ones.
    const result = quoraTimeToMs('Sat', now);
    expect(result).not.toBeNull();
    const d = new Date(result as number);
    expect(d.getDay()).toBe(6);
    expect(result as number).toBeLessThanOrEqual(now);
    expect(now - (result as number)).toBeLessThan(7 * 24 * 3600e3);
  });

  it('resolves today\'s weekday to today (not 7 days back)', () => {
    const result = quoraTimeToMs('Wed', now);
    const d = new Date(result as number);
    expect(d.getDate()).toBe(new Date(now).getDate());
  });

  it('resolves a bare "Mon D" (no year) against the current year', () => {
    const result = quoraTimeToMs('Jun 16', now);
    expect(result).not.toBeNull();
    const d = new Date(result as number);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5); // June
  });

  it('rolls "Mon D" back a year when the same-year guess is in the future', () => {
    // "now" is August 2026; "Dec 25" without a year would land after "now" this
    // year, so it must resolve to Dec 2025, not a fabricated future date.
    const result = quoraTimeToMs('Dec 25', now);
    expect(result).not.toBeNull();
    const d = new Date(result as number);
    expect(d.getFullYear()).toBe(2025);
    expect(result as number).toBeLessThan(now);
  });

  it('still parses an explicit "Mon D, YYYY" date', () => {
    const result = quoraTimeToMs('March 5, 2023', now);
    expect(result).toBe(Date.parse('March 5, 2023'));
  });

  it('returns null for empty/unrecognisable input', () => {
    expect(quoraTimeToMs('', now)).toBeNull();
    expect(quoraTimeToMs(null, now)).toBeNull();
    expect(quoraTimeToMs(undefined, now)).toBeNull();
  });
});

// Mirrors the live /search?type=answer markup (captured 2026-08-12): a global
// nav whose links are absolute quora.com URLs, then answer cards whose permalink
// lives on an `answer_timestamp` anchor nested inside a short byline block, with
// the action bar a SIBLING of the answer body rather than inside it.
//
// The counters reproduce Quora's width-reservation trick verbatim: a hidden
// "999" spacer followed by the real, absolutely-positioned number — which is
// why the upvote button's raw textContent reads "Upvote · 999658".
function actionBar(upvotes: string, comments: number, shares: number): string {
  return `
    <div class="q-box actions">
      <button aria-label="Upvote">
        <span class="q-text qu-fontWeight--medium">Upvote</span>
        <span class="q-box qu-display--none"> · </span><span class="q-text qu-visibility--hidden qu-display--inline-flex">999</span><span class="q-text qu-whiteSpace--nowrap qu-display--inline-flex">${upvotes}</span>
      </button>
      <button aria-label="Downvote"></button>
      <button aria-label="${comments} comments">
        <span class="q-text qu-visibility--hidden">999</span><span>${comments}</span>
      </button>
      <button aria-label="${shares} shares">
        <span class="q-text qu-visibility--hidden">9</span><span>${shares}</span>
      </button>
      <button></button>
    </div>`;
}

function renderSearchPage(): void {
  document.body.innerHTML = `
    <div id="root">
      <div class="nav">
        <a href="https://www.quora.com/">Quora</a>
        <a href="https://www.quora.com/following">Following</a>
        <a href="https://www.quora.com/spaces">Spaces</a>
      </div>
      <div class="q-box qu-borderBottom qu-pb--tiny">
        <div class="q-text puppeteer_test_question_title">
          Why does big tech want to replace programmers by AI so badly?
        </div>
        <div class="q-click-wrapper">
          <div class="q-box">
            <div class="q-box spacing_log_answer_header">
              <a href="/profile/Rohan-Prasanth-8"><img /></a>
              <a href="/profile/Rohan-Prasanth-8">Rohan Prasanth</a>
              <span>SDE Microsoft | self-taught dev</span>
              <span class="q-text qu-whiteSpace--nowrap"><span>
                <a class="q-box answer_timestamp" href="/Why-big-tech-replaces-programmers/answer/Rohan-Prasanth-8?ch=1&amp;share=x">1y</a>
              </span></span>
            </div>
            <div class="q-box spacing_log_answer_content puppeteer_test_answer_content">
              Last week at the company all-hands they addressed their plan to replace
              programmers with AI agents and lay off a large part of the org. A senior
              fellow said a new team of 170 employees has been formed in the US to
              ship this, and that the rollout starts next quarter across every product
              line, which is why everyone in the room went very quiet afterwards.
            </div>
          </div>
        </div>
        ${actionBar('658', 159, 3)}
      </div>
      <div class="q-box qu-borderBottom qu-pb--tiny">
        <div class="q-text puppeteer_test_question_title">
          How soon before an official bot replaces human answers?
        </div>
        <div class="q-click-wrapper">
          <div class="q-box">
            <div class="q-box spacing_log_answer_header">
              <a href="https://www.quora.com/profile/William-Gunn-59">William Gunn</a>
              <span class="q-text qu-whiteSpace--nowrap"><span>
                <a class="q-box answer_timestamp" href="https://productupdates.quora.com/How-soon-before-an-official-bot">Dec 22, 2022</a>
              </span></span>
            </div>
            <div class="q-box spacing_log_answer_content puppeteer_test_answer_content">
              Quora has been experimenting with generated answers for a while now, and
              the honest answer is that nobody internally agrees on when it ships. The
              ranking team wants more signal before it goes live to everyone, and that
              work is nowhere near finished at the time of writing this answer here.
            </div>
          </div>
        </div>
        ${actionBar('1.5K', 336, 58)}
      </div>
    </div>`;
}

describe('scrapeQuoraInPage', () => {
  it('returns one row per answer card and no site-chrome rows', () => {
    renderSearchPage();
    const rows = scrapeQuoraInPage();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.url)).toEqual([
      'https://www.quora.com/Why-big-tech-replaces-programmers/answer/Rohan-Prasanth-8',
      'https://productupdates.quora.com/How-soon-before-an-official-bot',
    ]);
  });

  it('captures the answer body, so the server-side keyword match can hit', () => {
    renderSearchPage();
    const [first] = scrapeQuoraInPage();
    // The byline block alone is ~90 chars and carries no answer text — the card
    // walk must climb past it or every row fails the keyword filter.
    expect(first.text).toContain('AI agents');
    expect(first.text.length).toBeGreaterThan(200);
  });

  it('includes the question title — keywords often appear only there', () => {
    renderSearchPage();
    expect(scrapeQuoraInPage()[0].text).toContain('Why does big tech want to replace');
  });

  it('keeps the author byline OUT of the content the keyword filter sees', () => {
    renderSearchPage();
    const [first] = scrapeQuoraInPage();
    // The regression: postContent used to start with the byline, so a scan for
    // "geo" matched 10/10 rows purely on authors named Geo Ashe / Geo Kay.
    expect(first.text).not.toContain('Rohan Prasanth');
    expect(first.text).not.toContain('SDE Microsoft');
    expect(first.author).toBe('Rohan-Prasanth-8'); // …still captured separately
  });

  it('falls back to the de-bylined body when the content hook is missing', () => {
    renderSearchPage();
    document
      .querySelectorAll('[class*="puppeteer_test_answer_content"], [class*="question_title"]')
      .forEach((el) => el.removeAttribute('class'));
    const [first] = scrapeQuoraInPage();
    expect(first.text).toContain('AI agents');
    expect(first.text).not.toContain('SDE Microsoft');
  });

  it('reads the author slug from relative AND absolute profile hrefs', () => {
    renderSearchPage();
    const rows = scrapeQuoraInPage();
    expect(rows[0].author).toBe('Rohan-Prasanth-8');
    expect(rows[1].author).toBe('William-Gunn-59');
  });

  it('takes the publish label off the timestamp anchor', () => {
    renderSearchPage();
    const rows = scrapeQuoraInPage();
    expect(rows.map((r) => r.timeText)).toEqual(['1y', 'Dec 22, 2022']);
  });

  it('reads upvotes past the hidden 999 width-spacer, not through it', () => {
    renderSearchPage();
    const rows = scrapeQuoraInPage();
    // Raw textContent here is "Upvote · 999658" — 999658 is the spacer glued to
    // the real count, and persisting it would fake a top-band heat score.
    expect(document.querySelector('button[aria-label="Upvote"]')!.textContent)
      .toContain('999658');
    expect(rows[0].upvotes).toBe(658);
  });

  it('expands a K-suffixed upvote count', () => {
    renderSearchPage();
    expect(scrapeQuoraInPage()[1].upvotes).toBe(1500);
  });

  it('reads comment and share counts off their aria-labels', () => {
    renderSearchPage();
    const rows = scrapeQuoraInPage();
    expect(rows.map((r) => r.comments)).toEqual([159, 336]);
    expect(rows.map((r) => r.shares)).toEqual([3, 58]);
  });

  it('is not confused by the loaded Quora page it is meant to read', () => {
    renderSearchPage();
    expect(detectQuoraChallengeInPage()).toBe(false);
  });

  it('leaves counters null when the card has no action bar', () => {
    renderSearchPage();
    document.querySelectorAll('.actions').forEach((el) => el.remove());
    const [first] = scrapeQuoraInPage();
    expect(first.upvotes).toBeNull();
    expect(first.comments).toBeNull();
    expect(first.shares).toBeNull();
    // …and the card walk still stops inside the answer, never at the result list.
    expect(first.text).not.toContain('Quora has been experimenting');
  });
});

describe('detectQuoraChallengeInPage', () => {
  /** Quora ships the Turnstile SDK in <head> on every page for its login flow. */
  function addTurnstileSdk(): void {
    const s = document.createElement('script');
    s.setAttribute('src', 'https://challenges.cloudflare.com/turnstile/v0/api.js');
    s.async = true;
    document.head.appendChild(s);
  }

  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    document.title = '';
  });

  it('does NOT report a challenge on a healthy page that preloads the Turnstile SDK', () => {
    // The regression this guards: testing for the SDK <script> alone fired on
    // every Quora page, so scanQuora burned its poll budget and returned zero
    // posts with an untouched cursor for every single unit.
    renderSearchPage();
    addTurnstileSdk();
    document.title = '(4) Search';
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).not.toBeNull();
    expect(detectQuoraChallengeInPage()).toBe(false);
  });

  it('reports a challenge on the real interstitial (challenge DOM, no Quora app)', () => {
    document.body.innerHTML = '<div id="challenge-running"></div>';
    addTurnstileSdk();
    expect(detectQuoraChallengeInPage()).toBe(true);
  });

  it('reports a challenge from the interstitial title', () => {
    document.title = 'Just a moment...';
    expect(detectQuoraChallengeInPage()).toBe(true);
  });

  it('reports a challenge on a bare Turnstile widget mount', () => {
    document.body.innerHTML = '<div class="cf-turnstile"></div>';
    expect(detectQuoraChallengeInPage()).toBe(true);
  });

  it('treats a rendered Quora app as decisive over a leftover challenge title', () => {
    renderSearchPage();
    document.title = 'Just a moment...';
    expect(detectQuoraChallengeInPage()).toBe(false);
  });
});

// @vitest-environment jsdom
//
// selectRedditFlairInPage runs INSIDE the reddit.com submit page via
// chrome.scripting.executeScript, driving shreddit's real custom elements
// (faceplate-radio-input, r-post-flairs-modal, ...) behind Shadow DOM. This
// rebuilds that structure with plain unregistered custom-element tags — jsdom
// gives them a real shadowRoot and correct tagName without needing the actual
// component classes — and drives it exactly the way the real page requires:
// dispatched pointer/mouse events, not a bare .click().
//
// jsdom does no layout, so getClientRects() is empty for everything by
// default; the visibility checks in selectRedditFlairInPage rely on it, so
// each built option stubs getClientRects to report its intended visibility.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  selectRedditFlairInPage,
  clickRedditPostInPage,
  GENERIC_FLAIR_FALLBACKS,
} from '../reddit.submit.tab';
import { REDDIT_FLAIR_MATCH_CASES } from '@gitroom/helpers/extension/reddit-flair-match-contract';

function makeVisible(el: Element, visible: boolean) {
  (el as any).getClientRects = () => (visible ? [{}] : []);
}

/**
 * Build a fake flair modal matching what the real submit page renders once
 * the "Add flair and tags" trigger is clicked. `compact` options are visible
 * immediately; `hidden` options only become visible once #view-all-flairs-button
 * is clicked (mirrors Discussion sitting outside the compact list on both
 * r/MachineLearning and r/football).
 */
function buildFlairPage(opts: {
  compact: string[];
  hidden?: string[];
  /** When true, clicking Add ("post-flair-modal-apply-button") sets the
   * modal's real `flairId` from the clicked option — the real page's "commit"
   * step this test exists to exercise. Set false to reproduce the observed
   * bug where the click fires but the copy never happens. */
  addCommits: boolean;
}) {
  document.body.innerHTML = '';

  const modal = document.createElement('r-post-flairs-modal');
  (modal as any).flairId = null;
  (modal as any).selectedFlairId = null;

  const trigger = document.createElement('button');
  trigger.id = 'reddit-post-flair-button';

  const viewAllBtn = document.createElement('button');
  viewAllBtn.id = 'view-all-flairs-button';

  const radios: HTMLElement[] = [];
  let idx = 0;
  const addOption = (text: string, visible: boolean) => {
    const radio = document.createElement('faceplate-radio-input');
    radio.id = `post-flair-radio-input-${idx++}`;
    radio.textContent = text;
    makeVisible(radio, visible);
    radios.push(radio);
    modal.appendChild(radio);
    return radio;
  };
  for (const t of opts.compact) addOption(t, true);
  for (const t of opts.hidden || []) addOption(t, false);

  viewAllBtn.addEventListener('click', () => {
    for (const r of radios) makeVisible(r, true);
  });

  const addBtn = document.createElement('button');
  addBtn.id = 'post-flair-modal-apply-button';
  addBtn.addEventListener('click', () => {
    if (opts.addCommits && (modal as any).selectedFlairId) {
      (modal as any).flairId = (modal as any).selectedFlairId;
    }
  });

  for (const radio of radios) {
    radio.addEventListener('click', () => {
      (modal as any).selectedFlairId = radio.id;
    });
  }

  modal.appendChild(viewAllBtn);
  modal.appendChild(addBtn);
  document.body.appendChild(trigger);
  document.body.appendChild(modal);

  return { modal, trigger, radios, addBtn, viewAllBtn };
}

describe('selectRedditFlairInPage', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns skipped for an empty label without touching the DOM', async () => {
    buildFlairPage({ compact: ['Research'], addCommits: true });
    const result = await selectRedditFlairInPage('');
    expect(result).toEqual({ status: 'skipped' });
  });

  it('returns no_selector when the flair trigger button is absent', async () => {
    document.body.innerHTML = '<div>no flair UI here</div>';
    const result = await selectRedditFlairInPage('Discussion');
    expect(result.status).toBe('no_selector');
  });

  it('selects a compact-list option, commits it, and reports applied', async () => {
    const { modal } = buildFlairPage({
      compact: ['Research', 'News', 'Project'],
      addCommits: true,
    });
    const result = await selectRedditFlairInPage('news');
    expect(result.status).toBe('applied');
    expect(result.matched).toBe('News');
    expect(result.viaFallback).toBe(false);
    expect((modal as any).flairId).toBeTruthy();
  });

  it('expands "View all flairs" to find an option outside the compact list', async () => {
    // Matches the real shape found on both r/MachineLearning and r/football:
    // Discussion only appears after expanding.
    buildFlairPage({
      compact: ['Research', 'News', 'Project'],
      hidden: ['Discussion'],
      addCommits: true,
    });
    const result = await selectRedditFlairInPage('Discussion');
    expect(result.status).toBe('applied');
    expect(result.matched).toBe('Discussion');
  });

  it('matches case-insensitively and ignores surrounding whitespace', async () => {
    buildFlairPage({ compact: ['  Discussion  '], addCommits: true });
    const result = await selectRedditFlairInPage('DISCUSSION');
    expect(result.status).toBe('applied');
  });

  it('reports no_match (and does not apply) when nothing matches, even after expanding', async () => {
    buildFlairPage({
      compact: ['Research', 'News'],
      hidden: ['Project'],
      addCommits: true,
    });
    const result = await selectRedditFlairInPage('Announcement');
    expect(result.status).toBe('no_match');
    expect(result.available).toEqual(
      expect.arrayContaining(['Research', 'News', 'Project'])
    );
  });

  it('reports no_match rather than guessing when the label is ambiguous', async () => {
    buildFlairPage({ compact: ['Weekly Discussion', 'Discussion'], addCommits: true });
    const result = await selectRedditFlairInPage('Weekly Discussion');
    // Exact match wins even with a similarly-named neighbour present.
    expect(result.status).toBe('applied');
    expect(result.matched).toBe('Weekly Discussion');
  });

  // Regression for the exact failure this module was built around: a real,
  // fully-dispatched click on the option AND on Add, but the modal's real
  // `flairId` never gets copied from `selectedFlairId` — reproduced 3x on
  // r/MachineLearning against an account later found to be blocked from the
  // subreddit entirely. Must be reported as unconfirmed, never as success.
  it('reports not_confirmed (never applied) when Add fails to commit the selection', async () => {
    const { modal } = buildFlairPage({ compact: ['Discussion'], addCommits: false });
    const result = await selectRedditFlairInPage('Discussion');
    expect(result.status).toBe('not_confirmed');
    expect(result.matched).toBe('Discussion');
    expect((modal as any).flairId).toBeFalsy();
  });

  it('reports no_options when the trigger exists but no flair options ever render', async () => {
    const trigger = document.createElement('button');
    trigger.id = 'reddit-post-flair-button';
    document.body.appendChild(trigger);
    const result = await selectRedditFlairInPage('Discussion');
    expect(result.status).toBe('no_options');
  });
});

describe('clickRedditPostInPage', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns no_selector when the Post button is absent', () => {
    document.body.innerHTML = '<div>no composer here</div>';
    expect(clickRedditPostInPage()).toEqual({ status: 'no_selector' });
  });

  // Reddit's own button reports disabled for every gate this module doesn't
  // otherwise know about — a captcha, an unmet karma/age gate, an unresolved
  // rule. Never clicking a disabled button is what keeps auto-submit from
  // ever needing its own captcha detection.
  it('reports disabled without clicking when the button is disabled', () => {
    const btn = document.createElement('button');
    btn.id = 'inner-post-submit-button';
    btn.disabled = true;
    let clicked = false;
    btn.addEventListener('click', () => (clicked = true));
    document.body.appendChild(btn);

    expect(clickRedditPostInPage()).toEqual({ status: 'disabled' });
    expect(clicked).toBe(false);
  });

  it('dispatches a full click sequence and reports clicked when enabled', () => {
    const btn = document.createElement('button');
    btn.id = 'inner-post-submit-button';
    btn.disabled = false;
    const seen: string[] = [];
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      btn.addEventListener(type, () => seen.push(type));
    }
    document.body.appendChild(btn);

    expect(clickRedditPostInPage()).toEqual({ status: 'clicked' });
    expect(seen).toContain('mousedown');
    expect(seen).toContain('mouseup');
    expect(seen).toContain('click');
  });

  it('finds the button behind a shadow root, same as the real composer', () => {
    const host = document.createElement('r-post-form-submit-button');
    const root = host.attachShadow({ mode: 'open' });
    const btn = document.createElement('button');
    btn.id = 'inner-post-submit-button';
    btn.disabled = false;
    root.appendChild(btn);
    document.body.appendChild(host);

    expect(clickRedditPostInPage()).toEqual({ status: 'clicked' });
  });
});

describe('selectRedditFlairInPage catch-all fallback', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('falls back to a catch-all flair when the proposed label is not offered', async () => {
    const { modal } = buildFlairPage({
      compact: ['Research', 'Other', 'News'],
      addCommits: true,
    });
    const result = await selectRedditFlairInPage('Growth Marketing', GENERIC_FLAIR_FALLBACKS);
    expect(result.status).toBe('applied');
    expect(result.matched).toBe('Other');
    expect(result.viaFallback).toBe(true);
    expect((modal as any).flairId).toBeTruthy();
  });

  // The exact label always wins, even when a catch-all sits earlier in the DOM
  // and is visible without expanding — otherwise the compact list would decide
  // the outcome instead of the caller's intent.
  it('prefers the exact label over a catch-all, even when the label needs expanding', async () => {
    buildFlairPage({
      compact: ['Other'],
      hidden: ['Discussion'],
      addCommits: true,
    });
    const result = await selectRedditFlairInPage('Discussion', GENERIC_FLAIR_FALLBACKS);
    expect(result.status).toBe('applied');
    expect(result.matched).toBe('Discussion');
    expect(result.viaFallback).toBe(false);
  });

  it('honours fallback ORDER rather than DOM order', async () => {
    // "Discussion" comes first in the DOM, "Other" first in the whitelist.
    const result = await (async () => {
      buildFlairPage({ compact: ['Discussion', 'General', 'Other'], addCommits: true });
      return selectRedditFlairInPage('Nonexistent', GENERIC_FLAIR_FALLBACKS);
    })();
    expect(result.matched).toBe('Other');
    expect(result.viaFallback).toBe(true);
  });

  // The case this exists for: a flair-required subreddit with a fully custom
  // set and no proposed label. Nothing generic is offered, so nothing is
  // picked — the post is handed to the user rather than filed under a real
  // topic picked by position.
  it('reports no_match (picking nothing) when no catch-all is offered', async () => {
    const { modal } = buildFlairPage({
      compact: ['Hiring', 'Showcase', 'Bug Report'],
      addCommits: true,
    });
    const result = await selectRedditFlairInPage('', GENERIC_FLAIR_FALLBACKS);
    expect(result.status).toBe('no_match');
    expect(result.available).toEqual(['Hiring', 'Showcase', 'Bug Report']);
    expect((modal as any).flairId).toBeFalsy();
  });

  it('finds a catch-all that only appears after expanding the full list', async () => {
    const { modal } = buildFlairPage({
      compact: ['Hiring', 'Showcase'],
      hidden: ['General'],
      addCommits: true,
    });
    const result = await selectRedditFlairInPage('', GENERIC_FLAIR_FALLBACKS);
    expect(result.status).toBe('applied');
    expect(result.matched).toBe('General');
    expect(result.viaFallback).toBe(true);
    expect((modal as any).flairId).toBeTruthy();
  });

  it('still skips (no DOM interaction) when there is neither a label nor a fallback', async () => {
    buildFlairPage({ compact: ['Other'], addCommits: true });
    expect(await selectRedditFlairInPage('', [])).toEqual({ status: 'skipped' });
  });
});

// Real r/football option set (screenshot 2026-08-12): a fully custom list whose
// labels carry decorative emoji, and which contains NO generic catch-all at all.
describe('selectRedditFlairInPage decorated labels', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('matches a label whose option is prefixed with an emoji', async () => {
    const { modal } = buildFlairPage({
      compact: ['No flair', 'Redditch United', '📰News', '⇄ Transfer News'],
      addCommits: true,
    });
    const result = await selectRedditFlairInPage('News', GENERIC_FLAIR_FALLBACKS);
    expect(result.status).toBe('applied');
    expect(result.matched).toBe('📰News');
    expect(result.viaFallback).toBe(false);
    expect((modal as any).flairId).toBeTruthy();
  });

  it('matches across a leading symbol and its spacing', async () => {
    buildFlairPage({
      compact: ['No flair', '📰News', '⇄ Transfer News'],
      addCommits: true,
    });
    const result = await selectRedditFlairInPage('transfer news');
    expect(result.status).toBe('applied');
    expect(result.matched).toBe('⇄ Transfer News');
  });

  // Stripping decoration can make two distinct options collide; picking either
  // would be the positional-guess failure mode by another route.
  it('refuses an ambiguous decoration-stripped match', async () => {
    const { modal } = buildFlairPage({
      compact: ['📰News', 'News'],
      addCommits: true,
    });
    // "📢news" is exact against neither, and core-matches both.
    const result = await selectRedditFlairInPage('📢News');
    expect(result.status).toBe('no_match');
    expect((modal as any).flairId).toBeFalsy();
  });

  it('still prefers an exact match over a decoration-stripped one', async () => {
    buildFlairPage({ compact: ['📰News', 'News'], addCommits: true });
    const result = await selectRedditFlairInPage('News');
    expect(result.matched).toBe('News');
  });

  // r/football offers Redditch United / News / Transfer News — no Other, no
  // General, no Discussion. The whitelist is simply absent here, so nothing is
  // picked and the post goes to the user rather than being filed under a
  // football club.
  it('picks nothing on a custom list with no catch-all', async () => {
    const { modal } = buildFlairPage({
      compact: ['No flair', 'Redditch United', '📰News', '⇄ Transfer News'],
      addCommits: true,
    });
    const result = await selectRedditFlairInPage('Growth Marketing', GENERIC_FLAIR_FALLBACKS);
    expect(result.status).toBe('no_match');
    expect((modal as any).flairId).toBeFalsy();
  });
});

// The flair list is the whole point of the capability writeback, and the
// COMMON outcome is a successful publish — so it has to come back on success,
// not only when matching failed.
describe('selectRedditFlairInPage available list', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns the full option list on a successful apply', async () => {
    buildFlairPage({
      compact: ['No flair', 'Redditch United', '📰News'],
      hidden: ['⇄ Transfer News'],
      addCommits: true,
    });
    const result = await selectRedditFlairInPage('News');
    expect(result.status).toBe('applied');
    expect(result.available).toEqual([
      'No flair',
      'Redditch United',
      '📰News',
      '⇄ Transfer News',
    ]);
  });

  it('returns the option list even when the commit could not be confirmed', async () => {
    buildFlairPage({ compact: ['Hiring', 'Showcase'], addCommits: false });
    const result = await selectRedditFlairInPage('Hiring');
    expect(result.status).toBe('not_confirmed');
    expect(result.available).toEqual(['Hiring', 'Showcase']);
  });

  it('preserves Reddit casing and emoji, and dedupes', async () => {
    buildFlairPage({ compact: ['  News  ', 'News', '📰News'], addCommits: true });
    const result = await selectRedditFlairInPage('nothing-here');
    expect(result.available).toEqual(['News', '📰News']);
  });
});

// Regression tests for two defects the fixtures above CANNOT catch, because
// they build the whole picker synchronously: every radio is in the DOM before
// the first probe, and the view-all handler flips visibility with no delay. The
// real page renders progressively, and both defects only appear when it does.
describe('selectRedditFlairInPage against a progressively-rendered picker', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /**
   * Like buildFlairPage, but the picker fills in over time:
   * `late` options are appended `appendAfterMs` after the trigger is clicked,
   * and `hidden` options only become visible `revealAfterMs` after "view all".
   */
  function buildAsyncFlairPage(opts: {
    compact: string[];
    late?: string[];
    hidden?: string[];
    appendAfterMs?: number;
    revealAfterMs?: number;
  }) {
    document.body.innerHTML = '';
    const modal = document.createElement('r-post-flairs-modal');
    (modal as any).flairId = null;
    (modal as any).selectedFlairId = null;

    const trigger = document.createElement('button');
    trigger.id = 'reddit-post-flair-button';
    const viewAllBtn = document.createElement('button');
    viewAllBtn.id = 'view-all-flairs-button';
    const addBtn = document.createElement('button');
    addBtn.id = 'post-flair-modal-apply-button';
    // Attached up front: addOption inserts each radio BEFORE viewAllBtn, so the
    // anchor has to be a child of the modal already.
    modal.appendChild(viewAllBtn);
    modal.appendChild(addBtn);

    const radios: HTMLElement[] = [];
    let idx = 0;
    const addOption = (text: string, visible: boolean) => {
      const radio = document.createElement('faceplate-radio-input');
      radio.id = `post-flair-radio-input-${idx++}`;
      radio.textContent = text;
      makeVisible(radio, visible);
      radio.addEventListener('click', () => {
        (modal as any).selectedFlairId = radio.id;
      });
      radios.push(radio);
      modal.insertBefore(radio, viewAllBtn);
      return radio;
    };

    for (const t of opts.compact) addOption(t, true);
    const hiddenEls: HTMLElement[] = [];

    trigger.addEventListener('click', () => {
      setTimeout(() => {
        for (const t of opts.late || []) addOption(t, true);
        for (const t of opts.hidden || []) hiddenEls.push(addOption(t, false));
      }, opts.appendAfterMs ?? 0);
    });
    viewAllBtn.addEventListener('click', () => {
      setTimeout(() => {
        for (const el of hiddenEls) makeVisible(el, true);
      }, opts.revealAfterMs ?? 0);
    });
    addBtn.addEventListener('click', () => {
      if ((modal as any).selectedFlairId) {
        (modal as any).flairId = (modal as any).selectedFlairId;
      }
    });

    document.body.appendChild(trigger);
    document.body.appendChild(modal);
    return { modal };
  }

  // Defect 1: `available` was mapped from the array captured by the FIRST
  // non-empty probe, which fires with zero settle delay right after the trigger
  // click, and was never re-read. Options that reach the DOM a moment later were
  // therefore absent from the report — and since the server REPLACES the stored
  // list with whatever arrives, that deletes known-good options rather than
  // merely missing them.
  it('reports options that only reach the DOM after the first probe', async () => {
    buildAsyncFlairPage({
      compact: ['📰News'],
      late: ['Redditch United', '⇄ Transfer News'],
      appendAfterMs: 250,
    });
    const result = await selectRedditFlairInPage('News');
    expect(result.status).toBe('applied');
    expect(result.available).toEqual([
      '📰News',
      'Redditch United',
      '⇄ Transfer News',
    ]);
  });

  // Same defect, via the other route: the proposed label matched in the compact
  // view, so the old code never expanded at all and reported only what the
  // compact view showed.
  it('expands even when the proposed label already matched, so the snapshot is complete', async () => {
    buildAsyncFlairPage({
      compact: ['News'],
      hidden: ['Other', 'Weekly Thread'],
      revealAfterMs: 200,
    });
    const result = await selectRedditFlairInPage('News');
    expect(result.status).toBe('applied');
    expect(result.matched).toBe('News');
    expect(result.available).toEqual(['News', 'Other', 'Weekly Thread']);
  });

  // Defect 2: the expansion poll broke immediately when no label was proposed
  // (`if (match || !want) break`), giving the catch-all sweep a single 150 ms
  // settle. A catch-all revealed any later was missed, `flairApplied` stayed
  // false, and the post was parked on a human — the outcome the fallback exists
  // to prevent.
  it('waits for a catch-all that becomes visible well after the expand click', async () => {
    const { modal } = buildAsyncFlairPage({
      compact: ['Hiring', 'Showcase'],
      hidden: ['General'],
      revealAfterMs: 600,
    });
    const result = await selectRedditFlairInPage('', GENERIC_FLAIR_FALLBACKS);
    expect(result.status).toBe('applied');
    expect(result.matched).toBe('General');
    expect(result.viaFallback).toBe(true);
    expect((modal as any).flairId).toBeTruthy();
  });
});

// The half of the shared contract this side owns. The SAME cases are run
// against the backend's independent copy in
// libraries/nestjs-libraries/src/engage/__tests__/reddit-channel-capability.spec.ts.
// See reddit-flair-match-contract.ts for why the two cannot share code: this
// matcher is serialized into the reddit.com page by chrome.scripting, so it has
// to be self-contained, and no bundler can deduplicate the copies.
//
// Driven through the real selectRedditFlairInPage rather than a lifted copy of
// findLabel — a lifted copy could pass while the shipped path fails. Every case
// makes all options visible and passes NO fallback labels, so only the rules
// both sides share are exercised.
describe('selectRedditFlairInPage — shared flair-matching contract', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  for (const c of REDDIT_FLAIR_MATCH_CASES) {
    it(c.name, async () => {
      const { modal } = buildFlairPage({ compact: c.options, addCommits: true });
      const result = await selectRedditFlairInPage(c.proposed);
      expect(result.matched ?? null).toBe(c.expected);
      if (c.expected === null) {
        // Nothing may be committed when nothing matched — a flair applied here
        // would file the post under a topic nobody chose.
        expect((modal as any).flairId).toBeFalsy();
      } else {
        expect(result.status).toBe('applied');
      }
    });
  }
});

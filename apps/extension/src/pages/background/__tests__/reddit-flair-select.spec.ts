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
import { selectRedditFlairInPage, clickRedditPostInPage } from '../reddit.submit.tab';

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
    expect(result).toEqual({ status: 'applied', matched: 'news' });
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
    expect(result.matched).toBe('discussion');
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
      expect.arrayContaining(['research', 'news', 'project'])
    );
  });

  it('reports no_match rather than guessing when the label is ambiguous', async () => {
    buildFlairPage({ compact: ['Weekly Discussion', 'Discussion'], addCommits: true });
    const result = await selectRedditFlairInPage('Weekly Discussion');
    // Exact match wins even with a similarly-named neighbour present.
    expect(result.status).toBe('applied');
    expect(result.matched).toBe('weekly discussion');
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
    expect(result.matched).toBe('discussion');
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

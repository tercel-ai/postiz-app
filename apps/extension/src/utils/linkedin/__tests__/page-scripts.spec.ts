// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extractLinkedinPosts } from '../page-scripts';

describe('extractLinkedinPosts engagement counters', () => {
  it('reads legacy-card counts from the aria-labelled social-counts bar', () => {
    // Mirrors linkedin.com/in/<handle>/recent-activity/all/ — verified live:
    // the reactions/comments/reposts buttons each carry the full count in
    // their own aria-label ("1,232 reactions", "63 comments on ...'s post").
    document.body.innerHTML = `
      <article>
        <a href="https://www.linkedin.com/in/mustafa-suleyman/">Mustafa Suleyman</a>
        <span>2h</span>
        <div class="feed-shared-text">Legacy layout body text about AI search, long enough to pass the body-extraction length threshold.</div>
        <button aria-label="1,232 reactions">1,232</button>
        <button aria-label="63 comments on Mustafa Suleyman's post">Comment</button>
        <button aria-label="119 reposts of Mustafa Suleyman's post">Repost</button>
      </article>
    `;
    const { rows } = extractLinkedinPosts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reactions: 1232, comments: 63, reposts: 119 });
  });

  it('reads SDUI search-card counts from bare digits when no aria-label carries a number', () => {
    // Mirrors linkedin.com/search/results/content/ — verified live: the action
    // buttons carry only generic labels ("Reaction button state: no reaction",
    // "Comment", "Repost"); the digit is bare text on the button itself
    // (Comment/Repost) or on its parent (the reactions-menu trigger).
    document.body.innerHTML = `
      <div id="expandedABC123FeedType_FLAGSHIP_SEARCH">
        <a href="https://www.linkedin.com/in/jane-doe/">Jane Doe</a>
        <button aria-label="Open control menu for post by Jane Doe">...</button>
        <span>3m</span>
        <div class="feed-shared-text">Hello from the SDUI search results card, long enough body text to clear the extraction threshold.</div>
        <span>12<button aria-label="Open reactions menu"></button></span>
        <button aria-label="Reaction button state: no reaction"></button>
        <button aria-label="Comment">6</button>
        <button aria-label="Repost"></button>
        <button aria-label="Send"></button>
      </div>
    `;
    const { rows } = extractLinkedinPosts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reactions: 12,
      comments: 6,
      reposts: 0, // no visible digit and no "reposts" text anywhere → default 0
    });
  });
});

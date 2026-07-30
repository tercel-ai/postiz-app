// Publication confirmation for the dev.to poster. The queue treats an
// unconfirmed publish as a FAILURE (never a silent success), so this predicate
// is what decides whether a post is reported as published — a false positive
// here means an article marked live that nobody can open.
import { describe, expect, it } from 'vitest';

import { isPublishedDevtoUrl } from '../devto.poster';

describe('isPublishedDevtoUrl', () => {
  it('accepts a published article at /<username>/<slug>', () => {
    expect(
      isPublishedDevtoUrl('https://dev.to/tercelyi/hello-world-4a2b')
    ).toBe(true);
  });

  it('ignores query strings and fragments', () => {
    expect(
      isPublishedDevtoUrl('https://dev.to/tercelyi/hello-world-4a2b?utm=x#top')
    ).toBe(true);
  });

  it('rejects the editor itself — the tab starts there', () => {
    // The poller runs from the moment Publish is clicked, so /new must never
    // count as the destination or every post would "publish" instantly.
    expect(isPublishedDevtoUrl('https://dev.to/new')).toBe(false);
  });

  it('rejects Forem system paths that share the two-segment shape', () => {
    expect(isPublishedDevtoUrl('https://dev.to/settings/extensions')).toBe(
      false
    );
    expect(isPublishedDevtoUrl('https://dev.to/dashboard/drafts')).toBe(false);
  });

  it('rejects a profile page (one segment) and deeper paths', () => {
    expect(isPublishedDevtoUrl('https://dev.to/tercelyi')).toBe(false);
    expect(isPublishedDevtoUrl('https://dev.to/a/b/c')).toBe(false);
  });

  it('rejects other hosts, including look-alikes', () => {
    expect(isPublishedDevtoUrl('https://medium.com/@me/post')).toBe(false);
    expect(isPublishedDevtoUrl('https://notdev.to/user/post')).toBe(false);
    expect(isPublishedDevtoUrl('')).toBe(false);
  });
});

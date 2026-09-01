import { describe, it, expect } from 'vitest';
import {
  classifyItem,
  parseItemId,
} from './backfill-hackernews-visibility';

describe('parseItemId', () => {
  it('reads the id out of an HN item url', () => {
    expect(parseItemId('https://news.ycombinator.com/item?id=49512124')).toBe('49512124');
  });

  it('accepts a subdomain but refuses a lookalike host', () => {
    expect(parseItemId('https://hn.ycombinator.com/item?id=1')).toBe('1');
    // The row selector is a `contains 'ycombinator.com'` LIKE, which also
    // matches this — the parse is what has to reject it.
    expect(parseItemId('https://ycombinator.com.evil.test/item?id=1')).toBeNull();
  });

  it('refuses anything without a numeric id', () => {
    expect(parseItemId('https://news.ycombinator.com/threads?id=tercelyi')).toBeNull();
    expect(parseItemId('https://news.ycombinator.com/newest')).toBeNull();
    expect(parseItemId('not a url')).toBeNull();
    expect(parseItemId('')).toBeNull();
  });
});

describe('classifyItem', () => {
  it('reads a killed item as hidden', () => {
    expect(classifyItem({ dead: true })).toBe('hidden');
  });

  it('reads an author-removed item as removed', () => {
    expect(classifyItem({ deleted: true })).toBe('removed');
  });

  it('reads an ordinary item as visible', () => {
    expect(classifyItem({})).toBe('visible');
    expect(classifyItem({ dead: false, deleted: false })).toBe('visible');
  });

  // Not hypothetical: HN item 49119595 is both dead and deleted.
  it('prefers hidden over removed when both are set', () => {
    expect(classifyItem({ dead: true, deleted: true })).toBe('hidden');
  });

  // HN's JSON omits these keys entirely on a healthy item; only `true` counts.
  it('treats a truthy non-true value as not set', () => {
    expect(classifyItem({ dead: 'true' })).toBe('visible');
    expect(classifyItem({ dead: 1 })).toBe('visible');
  });
});

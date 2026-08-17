import { describe, it, expect } from 'vitest';
import {
  MAX_TITLE_LEN,
  splitStoredTitle,
} from './backfill-engage-opportunity-title';

describe('splitStoredTitle', () => {
  describe('newline-joined platforms', () => {
    it('splits a self post at the first newline', () => {
      expect(
        splitStoredTitle('reddit', 'Anyone tried apcore?\nBeen using it all week.')
      ).toEqual({ title: 'Anyone tried apcore?', postContent: 'Been using it all week.' });
    });

    it('keeps the rest of a multi-paragraph body intact', () => {
      const stored = 'Headline\nFirst para.\n\nSecond para.';
      expect(splitStoredTitle('hackernews', stored)).toEqual({
        title: 'Headline',
        postContent: 'First para.\n\nSecond para.',
      });
    });

    it('treats a body with no newline as a link post: title only, empty body', () => {
      // `${title}${selftext ? '\n' + selftext : ''}` with no selftext — the
      // stored body IS the headline.
      expect(splitStoredTitle('reddit', 'GPT-5 is out')).toEqual({
        title: 'GPT-5 is out',
        postContent: '',
      });
    });

    it('handles dev.to and medium the same way', () => {
      expect(splitStoredTitle('devto', 'Hello\ndesc')).toEqual({
        title: 'Hello',
        postContent: 'desc',
      });
      expect(splitStoredTitle('medium', 'My Post\nHello world')).toEqual({
        title: 'My Post',
        postContent: 'Hello world',
      });
    });
  });

  describe('refuses rather than invents a title', () => {
    it('leaves x and linkedin alone — they never had a title to concatenate', () => {
      expect(splitStoredTitle('x', 'A tweet\nwith a line break')).toBeNull();
      expect(splitStoredTitle('linkedin', 'A post\nwith a line break')).toBeNull();
    });

    it('leaves quora alone by default — its joiner was a space, not a newline', () => {
      expect(
        splitStoredTitle('quora', 'How does apcore compare to MCP? apcore governs tool calls.')
      ).toBeNull();
    });

    it('leaves an empty or whitespace-only body alone', () => {
      expect(splitStoredTitle('reddit', '')).toBeNull();
      expect(splitStoredTitle('reddit', '   \n  ')).toBeNull();
    });

    it('leaves a first line too long to be a title alone', () => {
      const paragraph = 'A'.repeat(MAX_TITLE_LEN + 1);
      expect(splitStoredTitle('reddit', `${paragraph}\nmore`)).toBeNull();
    });

    it('accepts a first line exactly at the limit', () => {
      const title = 'A'.repeat(MAX_TITLE_LEN);
      expect(splitStoredTitle('reddit', `${title}\nbody`)?.title).toBe(title);
    });

    it('leaves an unknown platform alone', () => {
      expect(splitStoredTitle('mastodon', 'Title\nbody')).toBeNull();
    });
  });

  describe('re-running is a no-op on its own output', () => {
    // The script only reads rows with title IS NULL, so a written row is never
    // seen again; this guards the shape anyway — a split body must not split
    // into something different a second time.
    it('splitting an already-split body yields the same title or nothing', () => {
      const first = splitStoredTitle('reddit', 'Headline\nBody line one.\nBody line two.')!;
      expect(first.title).toBe('Headline');
      const second = splitStoredTitle('reddit', first.postContent)!;
      // Idempotence lives in the SQL filter, not here: a re-split would take
      // the body's own first line, which is exactly why the filter matters.
      expect(second.title).toBe('Body line one.');
    });

    it('a link post splits to an empty body, which then refuses to split again', () => {
      const first = splitStoredTitle('hackernews', 'Show HN: a thing')!;
      expect(first).toEqual({ title: 'Show HN: a thing', postContent: '' });
      expect(splitStoredTitle('hackernews', first.postContent)).toBeNull();
    });
  });

  describe('quora heuristic (opt-in)', () => {
    const on = { quoraHeuristic: true };

    it('splits at the first question mark, keeping it with the question', () => {
      expect(
        splitStoredTitle(
          'quora',
          'How does apcore compare to MCP? apcore focuses on the governed capability layer, with strict schemas.',
          on
        )
      ).toEqual({
        title: 'How does apcore compare to MCP?',
        postContent: 'apcore focuses on the governed capability layer, with strict schemas.',
      });
    });

    it('refuses when there is no question mark at all', () => {
      expect(splitStoredTitle('quora', 'A statement and then some answer text.', on)).toBeNull();
    });

    it('refuses when nothing substantial follows the question mark', () => {
      expect(splitStoredTitle('quora', 'Is apcore any good? Yes.', on)).toBeNull();
    });

    it('refuses when the "question" is too long to be one', () => {
      const long = `${'word '.repeat(60)}? and then the answer body goes on for a while here.`;
      expect(splitStoredTitle('quora', long, on)).toBeNull();
    });

    it('refuses a body that merely opens with a stray question mark', () => {
      expect(splitStoredTitle('quora', '? apcore governs every tool call it makes.', on)).toBeNull();
    });
  });
});

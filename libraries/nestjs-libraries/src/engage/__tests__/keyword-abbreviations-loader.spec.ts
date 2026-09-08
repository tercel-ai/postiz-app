import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReadFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync,
  };
});

import {
  getKeywordAbbreviations,
  _resetKeywordAbbreviationsCacheForTests,
} from '../keyword-abbreviations-loader';

describe('keyword-abbreviations-loader', () => {
  beforeEach(() => {
    _resetKeywordAbbreviationsCacheForTests();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
    // Default: the file "exists" at the very first candidate findUp tries
    // (this repo root vs. some deeper nested dist dir is irrelevant to every
    // test below except the "never found" one, which overrides this).
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses the JSON file into a lookup table', () => {
    mockReadFileSync.mockReturnValue('{"mcp": ["model context protocol"]}');
    expect(getKeywordAbbreviations()).toEqual({
      mcp: ['model context protocol'],
    });
  });

  it('walks up from the compiled module\'s own directory until it finds the file', () => {
    // Mirrors the real failure this loader was rewritten to avoid: the repo
    // root file is several directories above wherever tsc puts the compiled
    // .js for either apps/backend or apps/orchestrator. existsSync says "no"
    // for the first two candidates, "yes" on the third.
    let calls = 0;
    mockExistsSync.mockImplementation(() => {
      calls += 1;
      return calls >= 3;
    });
    mockReadFileSync.mockReturnValue('{"mcp": ["model context protocol"]}');

    expect(getKeywordAbbreviations()).toEqual({
      mcp: ['model context protocol'],
    });
    expect(calls).toBe(3);
  });

  it('does not re-read the file within the recheck window, even if content changed', () => {
    mockReadFileSync.mockReturnValue('{"mcp": ["model context protocol"]}');
    expect(getKeywordAbbreviations()).toEqual({
      mcp: ['model context protocol'],
    });

    mockReadFileSync.mockReturnValue('{"mcp": ["something else"]}');
    // Same call within the 10s recheck window — must return the cached
    // table without even invoking readFileSync again.
    expect(getKeywordAbbreviations()).toEqual({
      mcp: ['model context protocol'],
    });
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it('re-reads and picks up a real content change once the recheck window has passed', () => {
    vi.useFakeTimers();
    mockReadFileSync.mockReturnValue('{"mcp": ["model context protocol"]}');
    expect(getKeywordAbbreviations()).toEqual({
      mcp: ['model context protocol'],
    });

    mockReadFileSync.mockReturnValue('{"mcp": ["updated expansion"]}');
    vi.advanceTimersByTime(10_001);
    expect(getKeywordAbbreviations()).toEqual({ mcp: ['updated expansion'] });
  });

  it('does not re-parse when the recheck window passes but content is byte-identical', () => {
    vi.useFakeTimers();
    const content = '{"mcp": ["model context protocol"]}';
    mockReadFileSync.mockReturnValue(content);
    const first = getKeywordAbbreviations();

    vi.advanceTimersByTime(10_001);
    const second = getKeywordAbbreviations();
    // Same object reference — proves this was a hash-compare-and-skip, not a
    // re-parse that happened to produce an equal-looking object.
    expect(second).toBe(first);
  });

  it('falls back to the last good table when the file becomes unreadable', () => {
    vi.useFakeTimers();
    mockReadFileSync.mockReturnValue('{"mcp": ["model context protocol"]}');
    expect(getKeywordAbbreviations()).toEqual({
      mcp: ['model context protocol'],
    });

    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.advanceTimersByTime(10_001);
    expect(getKeywordAbbreviations()).toEqual({
      mcp: ['model context protocol'],
    });
  });

  it('falls back to the last good table on malformed JSON, and recovers on a later fix', () => {
    vi.useFakeTimers();
    mockReadFileSync.mockReturnValue('{"mcp": ["model context protocol"]}');
    expect(getKeywordAbbreviations()).toEqual({
      mcp: ['model context protocol'],
    });

    mockReadFileSync.mockReturnValue('{not valid json');
    vi.advanceTimersByTime(10_001);
    expect(getKeywordAbbreviations()).toEqual({
      mcp: ['model context protocol'],
    });

    // A broken intermediate edit must not permanently wedge the cache —
    // the loader does not update its stored hash on a parse failure, so the
    // NEXT recheck retries parsing instead of treating the bad content as
    // "already seen, nothing to do".
    mockReadFileSync.mockReturnValue('{"mcp": ["fixed"]}');
    vi.advanceTimersByTime(10_001);
    expect(getKeywordAbbreviations()).toEqual({ mcp: ['fixed'] });
  });

  it('returns an empty table when the file can never be located at all', () => {
    // The exact failure mode this rewrite targets: a build layout where the
    // file simply isn't reachable from the compiled module's directory.
    mockExistsSync.mockReturnValue(false);
    expect(getKeywordAbbreviations()).toEqual({});
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('returns an empty table when the file is found but never readable', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(getKeywordAbbreviations()).toEqual({});
  });
});

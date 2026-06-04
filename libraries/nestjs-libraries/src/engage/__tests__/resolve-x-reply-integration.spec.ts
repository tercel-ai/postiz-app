import { describe, it, expect } from 'vitest';
import {
  parseXHandle,
  pickXReplyIntegration,
  XIntegrationCandidate,
} from '@gitroom/nestjs-libraries/engage/resolve-x-reply-integration';

describe('parseXHandle', () => {
  it('extracts the lowercased handle from x.com and twitter.com URLs', () => {
    expect(parseXHandle('https://x.com/zhngyq310334/status/2061267353544146949?s=20')).toBe('zhngyq310334');
    expect(parseXHandle('https://twitter.com/AIPartnerUp/status/2061981755566125311')).toBe('aipartnerup');
  });

  it('strips a leading @', () => {
    expect(parseXHandle('https://x.com/@SomeUser/status/123')).toBe('someuser');
  });

  it('returns null for non-status URLs or null input', () => {
    expect(parseXHandle('https://x.com/zhngyq310334')).toBeNull();
    expect(parseXHandle(undefined)).toBeNull();
    expect(parseXHandle(null)).toBeNull();
  });
});

describe('pickXReplyIntegration', () => {
  const author: XIntegrationCandidate = { id: 'int-author', profile: 'zhngyq310334' };
  const bound: XIntegrationCandidate = { id: 'int-bound', profile: 'brandhq', engageEnabled: true };
  const other: XIntegrationCandidate = { id: 'int-other', profile: 'someoneelse' };

  it('returns null when there are no candidates', () => {
    expect(pickXReplyIntegration([], 'https://x.com/zhngyq310334/status/1')).toBeNull();
  });

  it('prefers an exact handle match (the tweet author) above all', () => {
    const r = pickXReplyIntegration([bound, other, author], 'https://x.com/zhngyq310334/status/1');
    expect(r).toEqual({ integrationId: 'int-author', matchedBy: 'handle' });
  });

  it('matches handle case-insensitively and ignores @', () => {
    const r = pickXReplyIntegration(
      [{ id: 'x', profile: '@ZhngYQ310334' }],
      'https://x.com/zhngyq310334/status/1'
    );
    expect(r).toEqual({ integrationId: 'x', matchedBy: 'handle' });
  });

  it('returns null when no candidate handle matches the author (no fallback)', () => {
    // The reply was posted from an external account: attaching an unrelated
    // integration would misrepresent authorship, so we attach nothing.
    expect(pickXReplyIntegration([other, bound], 'https://x.com/nobody/status/1')).toBeNull();
    expect(pickXReplyIntegration([other, author], 'https://x.com/nobody/status/1')).toBeNull();
  });

  it('returns null when the reply URL has no parseable handle', () => {
    expect(pickXReplyIntegration([other, bound], undefined)).toBeNull();
    expect(pickXReplyIntegration([other], undefined)).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import {
  normalizeHandle,
  matchExtensionSessionCandidate,
  mergeSessionHandleIntoMetadata,
  ExtensionSessionCandidate,
} from '../extension-session.utils';

function candidate(
  id: string,
  internalId: string,
  profile: string | null = null
): ExtensionSessionCandidate {
  return { id, internalId, profile };
}

describe('normalizeHandle', () => {
  it('should lowercase and trim when the handle carries stray casing or spaces', () => {
    expect(normalizeHandle('  AiPartnerUp  ')).toBe('aipartnerup');
  });

  it('should strip a leading @ when the platform displays handles that way', () => {
    expect(normalizeHandle('@aipartnerup')).toBe('aipartnerup');
  });

  it("should strip a leading u/ when the handle comes from Reddit's display form", () => {
    expect(normalizeHandle('u/Consistent_Habit')).toBe('consistent_habit');
  });

  it('should leave an already-plain handle unchanged', () => {
    expect(normalizeHandle('tercelyi')).toBe('tercelyi');
  });
});

describe('matchExtensionSessionCandidate', () => {
  const rows = [
    candidate('int_team', '2035636349181759488', 'AipartnerupTeam'),
    candidate('int_solo', '2035914746877345792', 'aipartnerup'),
    candidate('int_abcc', '1626045799187742722', '0xabcc'),
  ];

  it('should match on internalId when the probe recovered a platform account id', () => {
    expect(
      matchExtensionSessionCandidate({ id: '2035914746877345792' }, rows)
    ).toBe('int_solo');
  });

  it('should prefer internalId over handle when the two point at different rows', () => {
    // id names the team account, handle names the solo one — id wins.
    expect(
      matchExtensionSessionCandidate(
        { id: '2035636349181759488', handle: 'aipartnerup' },
        rows
      )
    ).toBe('int_team');
  });

  it('should fall back to handle when no id was reported', () => {
    expect(matchExtensionSessionCandidate({ handle: '@0xabcc' }, rows)).toBe(
      'int_abcc'
    );
  });

  it('should fall back to handle when the reported id matches nothing', () => {
    expect(
      matchExtensionSessionCandidate(
        { id: 'id-from-an-unbound-account', handle: 'AipartnerupTeam' },
        rows
      )
    ).toBe('int_team');
  });

  it('should return null when the browser is signed into an account this org never bound', () => {
    expect(
      matchExtensionSessionCandidate(
        { id: '999', handle: 'aiperceivable' },
        rows
      )
    ).toBeNull();
  });

  it('should return null rather than guess when nothing identifies the account', () => {
    expect(matchExtensionSessionCandidate({}, rows)).toBeNull();
  });

  it('should return null when the org has no integrations on the platform', () => {
    expect(matchExtensionSessionCandidate({ handle: 'aipartnerup' }, [])).toBeNull();
  });

  it('should skip rows with no stored profile when matching by handle', () => {
    const withNullProfile = [candidate('int_null', 'internal-1', null)];
    expect(
      matchExtensionSessionCandidate({ handle: 'anything' }, withNullProfile)
    ).toBeNull();
  });
});

describe('mergeSessionHandleIntoMetadata', () => {
  it('should preserve unrelated keys when recording the handle', () => {
    expect(
      mergeSessionHandleIntoMetadata({ someOtherFeature: 'keep me' }, 'aipartnerup')
    ).toEqual({ someOtherFeature: 'keep me', extensionSessionHandle: 'aipartnerup' });
  });

  it('should overwrite only its own key when a previous handle was recorded', () => {
    expect(
      mergeSessionHandleIntoMetadata(
        { extensionSessionHandle: 'old', someOtherFeature: 'keep me' },
        'new'
      )
    ).toEqual({ extensionSessionHandle: 'new', someOtherFeature: 'keep me' });
  });

  it('should drop its own key but keep the rest when the platform is signed out', () => {
    expect(
      mergeSessionHandleIntoMetadata(
        { extensionSessionHandle: 'old', someOtherFeature: 'keep me' },
        null
      )
    ).toEqual({ someOtherFeature: 'keep me' });
  });

  it('should return null when clearing the handle leaves the bucket empty', () => {
    expect(
      mergeSessionHandleIntoMetadata({ extensionSessionHandle: 'old' }, null)
    ).toBeNull();
  });

  it('should start a fresh object when the row has no metadata yet', () => {
    expect(mergeSessionHandleIntoMetadata(null, 'aipartnerup')).toEqual({
      extensionSessionHandle: 'aipartnerup',
    });
  });

  it('should ignore a non-object metadata value rather than spread it', () => {
    // A JSON column can legally hold a scalar or array; neither is a bucket.
    expect(mergeSessionHandleIntoMetadata(['a', 'b'], 'aipartnerup')).toEqual({
      extensionSessionHandle: 'aipartnerup',
    });
    expect(mergeSessionHandleIntoMetadata('a string', 'aipartnerup')).toEqual({
      extensionSessionHandle: 'aipartnerup',
    });
  });

  it('should return null when there is neither existing metadata nor a handle', () => {
    expect(mergeSessionHandleIntoMetadata(null, null)).toBeNull();
  });
});

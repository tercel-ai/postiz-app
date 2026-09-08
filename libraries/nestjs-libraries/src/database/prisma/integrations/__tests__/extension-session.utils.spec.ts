import { describe, it, expect } from 'vitest';
import {
  normalizeHandle,
  normalizeAccountId,
  matchExtensionSessionCandidate,
  mergeSessionHandleIntoMetadata,
  isUsableStoredPicture,
  buildExtensionSessionSeed,
  planExtensionSessionSync,
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

describe('isUsableStoredPicture', () => {
  it('should reject the .html avatar an error page left behind', () => {
    // Observed in production: an avatar url that answered with an error page
    // was re-hosted as HTML and has rendered broken ever since.
    expect(
      isUsableStoredPicture('https://files.aisee.live/HhV1fkROgq.html')
    ).toBe(false);
  });

  it('should keep a normal re-hosted image', () => {
    expect(
      isUsableStoredPicture('https://files.aisee.live/Jhz2748YZ0.jpeg')
    ).toBe(true);
  });

  it('should treat a missing or blank picture as unusable', () => {
    expect(isUsableStoredPicture(null)).toBe(false);
    expect(isUsableStoredPicture('   ')).toBe(false);
  });

  it('should leave an extension-less CDN url alone rather than churn it', () => {
    expect(isUsableStoredPicture('https://cdn.example.com/avatar/12345')).toBe(
      true
    );
  });

  it('should judge the path, not a query string that happens to contain dots', () => {
    expect(
      isUsableStoredPicture('https://cdn.example.com/a.jpg?v=1.2.html')
    ).toBe(true);
  });
});

describe('buildExtensionSessionSeed', () => {
  it('should seed a channel from the platform id when the probe recovered one', () => {
    expect(
      buildExtensionSessionSeed({
        id: 'tercelyi',
        handle: 'tercelyi',
        name: 'Tercel Yi',
        picture: 'https://cdn.example.com/a.jpg',
      })
    ).toEqual({
      internalId: 'tercelyi',
      name: 'Tercel Yi',
      username: 'tercelyi',
      picture: 'https://cdn.example.com/a.jpg',
    });
  });

  it('should fall back to the handle as the identity when no id was reported', () => {
    expect(buildExtensionSessionSeed({ handle: 'Tercel-Yi' })).toEqual({
      internalId: 'Tercel-Yi',
      name: 'Tercel-Yi',
      username: 'Tercel-Yi',
    });
  });

  it('should refuse to seed a channel it cannot name', () => {
    expect(buildExtensionSessionSeed({})).toBeNull();
    expect(buildExtensionSessionSeed({ name: 'Someone' })).toBeNull();
  });

  it('should drop an avatar the server could never fetch', () => {
    const seed = buildExtensionSessionSeed({
      handle: 'a',
      picture: 'blob:https://quora.com/9f2',
    });
    expect(seed).not.toHaveProperty('picture');
  });
});

describe('planExtensionSessionSync', () => {
  const row = {
    id: 'int_1',
    internalId: 'u-42',
    profile: 'oldhandle',
    picture: 'https://files.aisee.live/ok.jpeg',
  };

  it('should correct a stale handle when the report matched the row by platform id', () => {
    expect(
      planExtensionSessionSync(row, { id: 'u-42', handle: 'newhandle' })
    ).toEqual({ profile: 'newhandle' });
  });

  it('should not touch the handle on a handle-only match', () => {
    // Without an id there is no way to tell a renamed account from a different
    // one — writing the handle here could relabel the wrong row.
    expect(planExtensionSessionSync(row, { handle: 'newhandle' })).toEqual({});
  });

  it('should leave an already-correct handle alone, prefix and casing aside', () => {
    expect(
      planExtensionSessionSync(row, { id: 'u-42', handle: '@OldHandle' })
    ).toEqual({});
  });

  it('should replace a picture that was stored as a non-image', () => {
    expect(
      planExtensionSessionSync(
        { ...row, picture: 'https://files.aisee.live/broken.html' },
        { id: 'u-42', handle: 'oldhandle', picture: 'https://cdn.example.com/a.jpg' }
      )
    ).toEqual({ picture: 'https://cdn.example.com/a.jpg' });
  });

  it('should backfill a picture for a row that never had one', () => {
    expect(
      planExtensionSessionSync(
        { ...row, picture: null },
        { id: 'u-42', handle: 'oldhandle', picture: 'https://cdn.example.com/a.jpg' }
      )
    ).toEqual({ picture: 'https://cdn.example.com/a.jpg' });
  });

  it('should not re-upload a picture the row already has', () => {
    // The stored copy is re-hosted and can never compare equal to the platform
    // url; refreshing on every hourly report would churn storage and overwrite
    // a picture the user set by hand.
    expect(
      planExtensionSessionSync(row, {
        id: 'u-42',
        handle: 'oldhandle',
        picture: 'https://cdn.example.com/a.jpg',
      })
    ).toEqual({});
  });
});

describe('normalizeAccountId', () => {
  it("should strip Reddit's t2_ fullname prefix so both sides compare equal", () => {
    expect(normalizeAccountId('t2_abc123')).toBe('abc123');
  });

  it('should leave a bare id untouched', () => {
    expect(normalizeAccountId('abc123')).toBe('abc123');
    expect(normalizeAccountId('2035914746877345792')).toBe(
      '2035914746877345792'
    );
  });
});

describe('matchExtensionSessionCandidate — Reddit id forms', () => {
  it('should match the JWT fullname against the bare id the OAuth flow stored', () => {
    // The whole reason a Reddit login never flipped its own channel: the probe
    // reports `t2_abc123`, /api/v1/me stored `abc123`, and the cookie-only
    // probe has no handle to fall back on.
    expect(
      matchExtensionSessionCandidate({ id: 't2_abc123' }, [
        candidate('int_reddit', 'abc123', null),
      ])
    ).toBe('int_reddit');
  });

  it('should match a row that was itself created carrying the prefix', () => {
    expect(
      matchExtensionSessionCandidate({ id: 'abc123' }, [
        candidate('int_reddit', 't2_abc123', null),
      ])
    ).toBe('int_reddit');
  });
});

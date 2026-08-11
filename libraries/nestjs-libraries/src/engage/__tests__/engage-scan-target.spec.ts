import { describe, it, expect } from 'vitest';
import {
  buildScanTargetKey,
  CHANNEL_SCOPE_PLATFORMS,
  isValidTargetKey,
  normalizePlatform,
  partitionScanTargets,
  scanKeyFor,
  scanTypeFor,
  SUBREDDIT_NAME_RE,
  toChannelShape,
} from '../engage-scan-target';
import { normalizeUsername } from '../engage-scan-lease.service';

// The scan-target merge rests entirely on this module: it replaced a
// discriminator COLUMN with a derivation from `platform`. Nothing was testing it
// directly — every assertion went through the repository — so a change to the
// derivation could only be caught indirectly, if at all.

const row = (over: Partial<Parameters<typeof toChannelShape>[0]> = {}) => ({
  id: 'row-1',
  configId: 'cfg-1',
  organizationId: 'org-1',
  platform: 'reddit',
  username: 'askreddit',
  displayName: 'r/AskReddit',
  picture: null,
  categoryLabel: null,
  audienceSize: 42,
  enabled: true,
  lastCheckedAt: new Date('2026-08-01T00:00:00Z'),
  metadata: { avatar: 'https://x/a.png' },
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-02T00:00:00Z'),
  ...over,
});

describe('scanTypeFor / normalizePlatform', () => {
  it('derives channel scope for reddit and tracked scope for everything else', () => {
    expect(scanTypeFor('reddit')).toBe('channel');
    for (const p of ['x', 'linkedin', 'devto', 'hackernews', 'medium', 'quora']) {
      expect(scanTypeFor(p)).toBe('tracked');
    }
  });

  it('is case- and whitespace-insensitive, so a legacy "Reddit" row still resolves', () => {
    expect(scanTypeFor('Reddit')).toBe('channel');
    expect(scanTypeFor('  REDDIT ')).toBe('channel');
    expect(normalizePlatform('  Reddit ')).toBe('reddit');
  });

  it('falls back to tracked for a missing platform rather than throwing', () => {
    expect(scanTypeFor(null)).toBe('tracked');
    expect(scanTypeFor(undefined)).toBe('tracked');
    expect(scanTypeFor('')).toBe('tracked');
  });

  it('keeps reddit as the ONLY channel-scope platform', () => {
    // Widening this set changes which endpoint owns a row and which scanner
    // serves it; the assertion is here so that is never an accident.
    expect([...CHANNEL_SCOPE_PLATFORMS]).toEqual(['reddit']);
  });
});

describe('toChannelShape', () => {
  it('renders the legacy monitored-channel field names', () => {
    const shaped = toChannelShape(row());
    expect(shaped).toMatchObject({
      id: 'row-1',
      platform: 'reddit',
      channelId: 'askreddit',
      channelName: 'r/AskReddit',
      audienceSize: 42,
      enabled: true,
      metadata: { avatar: 'https://x/a.png' },
    });
    expect(shaped.lastScannedAt).toEqual(new Date('2026-08-01T00:00:00Z'));
  });

  it('falls back to the key when displayName is null (old column was NOT NULL)', () => {
    expect(toChannelShape(row({ displayName: null })).channelName).toBe('askreddit');
  });

  it('emits null — never undefined — for the optional legacy fields', () => {
    const shaped = toChannelShape(row({ lastCheckedAt: null, metadata: null }));
    expect(shaped.lastScannedAt).toBeNull();
    expect(shaped.metadata).toBeNull();
  });
});

describe('partitionScanTargets', () => {
  it('routes every row to exactly one list, order preserved', () => {
    const rows = [
      row({ id: 'c1', platform: 'reddit', username: 'seo' }),
      row({ id: 'a1', platform: 'x', username: 'alice' }),
      row({ id: 'c2', platform: 'reddit', username: 'webdev' }),
      row({ id: 'a2', platform: 'linkedin', username: 'bob' }),
    ];
    const { monitoredChannels, trackedAccounts } = partitionScanTargets(rows);

    expect(monitoredChannels.map((c) => c.channelId)).toEqual(['seo', 'webdev']);
    expect(trackedAccounts.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(monitoredChannels.length + trackedAccounts.length).toBe(rows.length);
  });

  it('renders only the channel side in the legacy shape; tracked rows pass through raw', () => {
    const { monitoredChannels, trackedAccounts } = partitionScanTargets([
      row({ platform: 'reddit' }),
      row({ id: 'a1', platform: 'x', username: 'alice' }),
    ]);
    expect(monitoredChannels[0]).toHaveProperty('channelId');
    expect(trackedAccounts[0]).toHaveProperty('username');
    expect(trackedAccounts[0]).not.toHaveProperty('channelId');
  });

  it('returns two empty lists for an empty relation', () => {
    expect(partitionScanTargets([])).toEqual({
      monitoredChannels: [],
      trackedAccounts: [],
    });
  });
});

describe('scanKeyFor', () => {
  it('agrees with normalizeUsername — one key function for both scopes', () => {
    for (const [platform, raw] of [
      ['reddit', 'r/AskReddit'],
      ['reddit', 'askreddit'],
      ['x', '@Alice'],
      ['linkedin', 'Some-Person'],
    ] as const) {
      expect(scanKeyFor({ platform, username: raw })).toBe(
        normalizeUsername(platform, raw)
      );
    }
  });

  it('collapses the prefix/case variants of one subreddit onto one cursor key', () => {
    const keys = ['AskReddit', 'r/AskReddit', '/r/askreddit', 'r/AskReddit/'].map(
      (u) => scanKeyFor({ platform: 'reddit', username: u })
    );
    expect(new Set(keys)).toEqual(new Set(['askreddit']));
  });

  it('defaults a missing platform to x rather than producing an unkeyed unit', () => {
    expect(scanKeyFor({ platform: null, username: '@Alice' })).toBe('alice');
  });
});

describe('isValidTargetKey', () => {
  it('validates a channel key with the SUBREDDIT alphabet, not the handle one', () => {
    expect(isValidTargetKey('reddit', 'askreddit')).toBe(true);
    expect(isValidTargetKey('reddit', 'ask_reddit')).toBe(true);
    // `-` is legal in a reddit USERNAME and illegal in a subreddit name. The
    // write path used to accept it, then the operation-plan resolver silently
    // dropped the row from the Tier-1 pool.
    expect(isValidTargetKey('reddit', 'foo-bar')).toBe(false);
    expect(isValidTargetKey('reddit', 'a')).toBe(false); // too short
    expect(isValidTargetKey('reddit', 'x'.repeat(22))).toBe(false); // too long
  });

  it('validates a tracked key with the platform handle alphabet', () => {
    expect(isValidTargetKey('x', 'alice')).toBe(true);
    expect(isValidTargetKey('x', 'evil) OR is:verified')).toBe(false);
    expect(isValidTargetKey('x', 'a'.repeat(16))).toBe(false); // X caps at 15
  });

  it('shares SUBREDDIT_NAME_RE with the operation-plan resolver', () => {
    expect(SUBREDDIT_NAME_RE.test('askreddit')).toBe(true);
    expect(SUBREDDIT_NAME_RE.test('foo-bar')).toBe(false);
  });
});

describe('buildScanTargetKey — the single write boundary', () => {
  it('canonicalises the platform and normalises the key', () => {
    expect(buildScanTargetKey('  Reddit ', 'r/AskReddit/', 'channel')).toEqual({
      platform: 'reddit',
      username: 'askreddit',
    });
    expect(buildScanTargetKey('X', '@Alice', 'tracked')).toEqual({
      platform: 'x',
      username: 'alice',
    });
  });

  it('rejects the wrong door for each scope', () => {
    // A reddit "tracked account" used to be storable and was then fetched as
    // /r/<username>; an x "channel" was searched as a bare keyword.
    expect(() => buildScanTargetKey('reddit', 'spez', 'tracked')).toThrow(
      /no author scope/
    );
    expect(() => buildScanTargetKey('x', 'somesub', 'channel')).toThrow(
      /no channel scope/
    );
  });

  it('rejects a key that could shape the X from: query', () => {
    expect(() =>
      buildScanTargetKey('x', 'evil) OR is:verified', 'tracked')
    ).toThrow(/Invalid x username/);
  });

  it('rejects a channel key that is not a legal subreddit name', () => {
    expect(() => buildScanTargetKey('reddit', 'foo-bar', 'channel')).toThrow(
      /Invalid reddit channel/
    );
    // `u/alice` normalises to `alice`, which IS a legal subreddit name — the
    // caller asked for a community and gets one. Documented, not a silent bug:
    // the handle prefix is stripped by design so `r/`/`u/` paste-ins work.
    expect(buildScanTargetKey('reddit', 'u/alice', 'channel').username).toBe('alice');
  });

  it('rejects a missing platform', () => {
    expect(() => buildScanTargetKey('', 'askreddit', 'channel')).toThrow(
      /requires a platform/
    );
    expect(() => buildScanTargetKey(null, 'askreddit', 'channel')).toThrow(
      /requires a platform/
    );
  });

  it('rejects a platform no scanner exists for', () => {
    // Previously `POST /engage/tracked-accounts {platform:'youtube'}` returned
    // 200 and stored a row that showed in the UI, consumed the org's
    // per-platform priority-accounts budget, and was never scanned — the scan
    // enumerator silently skips it. Same defect the channel door was narrowed
    // to eliminate, so both doors now reject it.
    for (const p of ['youtube', 'qq', 'discord', 'instagram']) {
      expect(() => buildScanTargetKey(p, 'someone', 'tracked')).toThrow(
        /has no scanner/
      );
    }
  });

  it('accepts a platform that has a scanner but is not currently enabled', () => {
    // CAPABILITY, not configuration. The operator's allowlist
    // (ENGAGE_SUPPORTED_PLATFORMS, default 'x,reddit') is a state they flip; a
    // write must not 400 because scanning happens to be off today.
    expect(buildScanTargetKey('linkedin', 'Some-Person', 'tracked')).toEqual({
      platform: 'linkedin',
      username: 'Some-Person',
    });
    expect(buildScanTargetKey('hackernews', 'PaulG', 'tracked')).toEqual({
      platform: 'hackernews',
      username: 'PaulG',
    });
  });

  it('produces a key the derivation agrees with (write/read round-trip)', () => {
    const { platform, username } = buildScanTargetKey('Reddit', 'r/SEO', 'channel');
    expect(scanTypeFor(platform)).toBe('channel');
    expect(scanKeyFor({ platform, username })).toBe(username);
    expect(toChannelShape(row({ platform, username })).channelId).toBe(username);
  });
});

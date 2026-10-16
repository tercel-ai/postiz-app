import { describe, expect, it } from 'vitest';
import {
  hashSecret,
  nodeSecret,
  resolveObservedAccount,
  sessionDecision,
  channelAvailability,
} from '../extension-node.protocol';

const now = new Date('2026-10-14T03:00:00Z');
const live = {
  platform: 'x',
  loggedIn: true,
  id: '123',
  identityNamespace: 'x.rest_id',
  evidenceKind: 'LIVE_COOKIE_ID',
  verificationStatus: 'VERIFIED',
  probeId: 'probe-1',
  identityObservedAt: now.toISOString(),
};
const account = {
  id: 'account-1',
  internalId: '123',
  identityNamespace: 'x.rest_id',
  providerIdentifier: 'x',
  profile: 'alice',
};

describe('extension account identity', () => {
  it('matches stable identity without confusing platforms', () => {
    expect(
      resolveObservedAccount(live, [
        { ...account, providerIdentifier: 'reddit' },
        account,
      ])
    ).toBe('account-1');
  });
  it('never falls back to a handle after a stable ID mismatch', () => {
    expect(
      resolveObservedAccount({ ...live, id: '456', handle: 'alice' }, [account])
    ).toBeNull();
  });
  it('does not equate different identity namespaces', () => {
    expect(
      resolveObservedAccount({ ...live, identityNamespace: 'x.other' }, [
        account,
      ])
    ).toBeNull();
  });
  it('requires verified aliases for a browser identity in another namespace', () => {
    const li = {
      ...account,
      providerIdentifier: 'linkedin',
      identityNamespace: 'linkedin.oauth_sub',
      internalId: 'sub-1',
      metadata: {
        identityAliases: [{ namespace: 'linkedin.member_id', id: '42' }],
      },
    };
    expect(
      resolveObservedAccount(
        {
          ...live,
          platform: 'linkedin',
          identityNamespace: 'linkedin.member_id',
          id: '42',
        },
        [li]
      )
    ).toBe('account-1');
  });
  it('keeps case sensitive handle identities distinct', () => {
    const hn = {
      ...account,
      providerIdentifier: 'hackernews',
      identityNamespace: 'hackernews.handle',
      internalId: 'Alice',
    };
    expect(
      resolveObservedAccount(
        {
          ...live,
          platform: 'hackernews',
          identityNamespace: 'hackernews.handle',
          id: undefined,
          handle: 'alice',
        },
        [hn]
      )
    ).toBeNull();
  });
  it('normalizes Reddit fullname IDs', () => {
    expect(
      resolveObservedAccount(
        {
          ...live,
          platform: 'reddit',
          identityNamespace: 'reddit.user_id',
          id: 't2_abc',
        },
        [
          {
            ...account,
            providerIdentifier: 'reddit',
            identityNamespace: 'reddit.user_id',
            internalId: 'abc',
          },
        ]
      )
    ).toBe('account-1');
  });
  it('refuses ambiguous matching accounts and unknown legacy namespaces', () => {
    expect(
      resolveObservedAccount(live, [account, { ...account, id: 'other' }])
    ).toBeNull();
    expect(
      resolveObservedAccount(live, [{ ...account, identityNamespace: null }])
    ).toBeNull();
  });
});

describe('extension session evidence', () => {
  it('removes the original association when a live probe observes an unregistered different actor', () => {
    const previous = {
      ...sessionDecision(live, null, now, 'account-1'),
      accountIdentity: { id: '123', namespace: 'x.rest_id' },
    };
    const result = sessionDecision(
      { ...live, id: '456', probeId: 'unregistered' },
      previous,
      now,
      null
    );
    expect(result.integrationId).toBeNull();
    expect(result.verifiedAt).toBeNull();
    expect(result.verificationStatus).toBe('UNKNOWN');
  });
  it('accepts a new live observation and limits expiry by its original age', () => {
    const at = new Date(now.getTime() - 30_000).toISOString();
    const result = sessionDecision(
      { ...live, identityObservedAt: at },
      null,
      now,
      'account-1'
    );
    expect(result.verificationStatus).toBe('VERIFIED');
    expect(result.verificationExpiresAt?.getTime()).toBe(
      now.getTime() + 270_000
    );
    expect(result.sessionRevision).toBe(1);
  });
  it('does not extend verification for replayed probes', () => {
    const previous = sessionDecision(live, null, now, 'account-1');
    const result = sessionDecision(
      live,
      previous,
      new Date(now.getTime() + 10_000),
      'account-1'
    );
    expect(result.verifiedAt).toEqual(previous.verifiedAt);
    expect(result.verificationExpiresAt).toEqual(
      previous.verificationExpiresAt
    );
    expect(result.sessionRevision).toBe(1);
  });
  it('does not give first-time cache evidence a sending identity', () => {
    expect(
      sessionDecision(
        { ...live, evidenceKind: 'CACHED' },
        null,
        now,
        'account-1'
      ).verificationStatus
    ).toBe('UNKNOWN');
  });
  it('invalidates an explicit unknown and increments the session revision', () => {
    const previous = sessionDecision(live, null, now, 'account-1');
    const result = sessionDecision(
      { ...live, verificationStatus: 'UNKNOWN' },
      previous,
      now,
      'account-1'
    );
    expect(result.verificationStatus).toBe('UNKNOWN');
    expect(result.sessionRevision).toBe(2);
    expect(result.verifiedAt).toEqual(previous.verifiedAt);
  });
  it('clears the association and verification on logout', () => {
    const previous = sessionDecision(live, null, now, 'account-1');
    const result = sessionDecision(
      { ...live, loggedIn: false },
      previous,
      now,
      null
    );
    expect(result.integrationId).toBeNull();
    expect(result.verifiedAt).toBeNull();
    expect(result.verificationStatus).toBe('LOGGED_OUT');
  });
  it.each([-301_000, 30_000])(
    'refuses stale or future observations (%i)',
    (delta) => {
      expect(
        sessionDecision(
          {
            ...live,
            identityObservedAt: new Date(now.getTime() + delta).toISOString(),
          },
          null,
          now,
          'account-1'
        ).verificationStatus
      ).toBe('UNKNOWN');
    }
  );
  it('keeps a fresh same-account probe at the same session revision', () => {
    const previous = sessionDecision(live, null, now, 'account-1');
    expect(
      sessionDecision(
        { ...live, probeId: 'probe-2' },
        previous,
        now,
        'account-1'
      ).sessionRevision
    ).toBe(1);
  });
  it('clears the old association on a known account switch without fresh evidence', () => {
    const previous = sessionDecision(live, null, now, 'account-1');
    const result = sessionDecision(
      { ...live, probeId: 'other', evidenceKind: 'CACHED' },
      previous,
      now,
      'account-2'
    );
    expect(result.integrationId).toBeNull();
    expect(result.verifiedAt).toBeNull();
    expect(result.verificationStatus).toBe('UNKNOWN');
  });
});

describe('node credential and availability', () => {
  it('uses deterministic secret replay with tenant and user isolation', () => {
    const key = 'a'.repeat(32);
    expect(nodeSecret(key, 'org', 'user', 'node', 'salt')).toBe(
      nodeSecret(key, 'org', 'user', 'node', 'salt')
    );
    expect(nodeSecret(key, 'org', 'user', 'node', 'salt')).not.toBe(
      nodeSecret(key, 'other', 'user', 'node', 'salt')
    );
    expect(hashSecret('token')).not.toContain('token');
  });
  it('prefers any fully capable terminal over other failures', () => {
    expect(
      channelAvailability(false, [
        { online: false, verified: true, capable: true },
        { online: true, verified: true, capable: true },
      ])
    ).toBe('AVAILABLE');
  });
  it('distinguishes disabled, offline, unverified, and unsupported', () => {
    expect(channelAvailability(true, [])).toBe('ACCOUNT_DISABLED');
    expect(channelAvailability(false, [])).toBe('WAITING_FOR_TERMINAL');
    expect(
      channelAvailability(false, [
        { online: true, verified: false, capable: true },
      ])
    ).toBe('SESSION_UNVERIFIED');
    expect(
      channelAvailability(false, [
        { online: true, verified: true, capable: false },
      ])
    ).toBe('CAPABILITY_UNSUPPORTED');
  });
});

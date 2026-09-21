import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import {
  isRedditBackendReadAvailable,
  recordRedditEgressFailure,
  recordRedditEgressSuccess,
  redditBackendReadBlockedReason,
  redditEgressSnapshot,
  resetRedditEgressBreaker,
} from '@gitroom/nestjs-libraries/engage/reddit-egress';

// The module reads its knobs from the environment on every call, so each test
// states the deployment it is describing rather than inheriting whatever .env
// the suite happened to load.
function configure(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) vi.stubEnv(key, '');
    else vi.stubEnv(key, value);
  }
}

const PROXY_DEPLOYMENT = {
  REDDIT_EGRESS_MODE: 'auto',
  REDDIT_PROXY: 'http://proxy.example:8080',
  HTTPS_PROXY: '',
  HTTP_PROXY: '',
  REDDIT_DIRECT_READ: '',
  REDDIT_EGRESS_FAILURE_THRESHOLD: '3',
  REDDIT_EGRESS_OPEN_MS: '600000',
};

beforeEach(() => {
  resetRedditEgressBreaker();
  configure(PROXY_DEPLOYMENT);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('egress gate — which deployments may read Reddit at all', () => {
  it('allows reads when a proxy is configured', () => {
    expect(isRedditBackendReadAvailable()).toBe(true);
    expect(redditBackendReadBlockedReason()).toBeNull();
  });

  it('refuses reads when no proxy is configured — the extension is the only route', () => {
    configure({ REDDIT_PROXY: '', HTTPS_PROXY: '', HTTP_PROXY: '' });
    expect(isRedditBackendReadAvailable()).toBe(false);
    expect(redditBackendReadBlockedReason()).toMatch(/no REDDIT_PROXY/);
  });

  it('allows an unproxied host that declares it reaches reddit.com directly', () => {
    configure({ REDDIT_PROXY: '', REDDIT_DIRECT_READ: 'true' });
    expect(isRedditBackendReadAvailable()).toBe(true);
  });

  it('honours an explicit extension-only mode even with a working proxy', () => {
    configure({ REDDIT_EGRESS_MODE: 'extension' });
    expect(isRedditBackendReadAvailable()).toBe(false);
    expect(redditBackendReadBlockedReason()).toMatch(/extension/);
  });

  it('honours an explicit backend mode with no proxy configured', () => {
    configure({ REDDIT_EGRESS_MODE: 'backend', REDDIT_PROXY: '' });
    expect(isRedditBackendReadAvailable()).toBe(true);
  });
});

describe('circuit breaker', () => {
  it('stays closed below the failure threshold', () => {
    recordRedditEgressFailure('boom');
    recordRedditEgressFailure('boom');
    expect(isRedditBackendReadAvailable()).toBe(true);
  });

  it('opens on the threshold failure and reports why', () => {
    recordRedditEgressFailure('HTTP 403 after all tiers');
    recordRedditEgressFailure('HTTP 403 after all tiers');
    recordRedditEgressFailure('HTTP 403 after all tiers');
    expect(isRedditBackendReadAvailable()).toBe(false);
    expect(redditBackendReadBlockedReason()).toBe('HTTP 403 after all tiers');
  });

  it('a success mid-run clears the failure count', () => {
    recordRedditEgressFailure('boom');
    recordRedditEgressFailure('boom');
    recordRedditEgressSuccess();
    recordRedditEgressFailure('boom');
    recordRedditEgressFailure('boom');
    // Four failures total, but never three CONSECUTIVE ones.
    expect(isRedditBackendReadAvailable()).toBe(true);
  });

  it('a success closes an open breaker', () => {
    for (let i = 0; i < 3; i++) recordRedditEgressFailure('boom');
    expect(isRedditBackendReadAvailable()).toBe(false);
    recordRedditEgressSuccess();
    expect(isRedditBackendReadAvailable()).toBe(true);
  });

  it('half-opens after the window and lets exactly ONE caller through', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) recordRedditEgressFailure('boom', t0);
    expect(isRedditBackendReadAvailable(t0 + 1_000)).toBe(false);

    // Window elapsed: the first caller is admitted...
    const later = t0 + 600_001;
    expect(isRedditBackendReadAvailable(later)).toBe(true);

    // ...and its failure re-opens immediately, without needing three more.
    recordRedditEgressFailure('still broken', later);
    expect(isRedditBackendReadAvailable(later + 1)).toBe(false);
  });

  it('a successful half-open probe returns the breaker to normal', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) recordRedditEgressFailure('boom', t0);
    const later = t0 + 600_001;
    expect(isRedditBackendReadAvailable(later)).toBe(true);

    recordRedditEgressSuccess(later);
    // Back to a full threshold's worth of headroom, not one failure from open.
    recordRedditEgressFailure('blip', later + 1);
    recordRedditEgressFailure('blip', later + 2);
    expect(isRedditBackendReadAvailable(later + 3)).toBe(true);
  });

  it('the mode gate outranks a closed breaker', () => {
    configure({ REDDIT_EGRESS_MODE: 'extension' });
    recordRedditEgressSuccess();
    expect(isRedditBackendReadAvailable()).toBe(false);
  });
});

describe('snapshot', () => {
  it('does NOT consume the half-open probe slot', () => {
    // A dashboard read must not decide which caller gets to retry Reddit. The
    // gate below half-opens as a side effect; the snapshot must not.
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) recordRedditEgressFailure('boom', t0);
    const later = t0 + 600_001;

    const snap = redditEgressSnapshot(later);
    expect(snap.available).toBe(true); // the window HAS elapsed

    // The real gate still has its one probe to hand out.
    expect(isRedditBackendReadAvailable(later)).toBe(true);
    // ...and it was consumed by that call, not by the snapshot.
    recordRedditEgressFailure('still broken', later);
    expect(isRedditBackendReadAvailable(later + 1)).toBe(false);
  });

  it('reports the deployment and the breaker state together', () => {
    for (let i = 0; i < 3; i++) recordRedditEgressFailure('dead proxy', 5_000);
    const snap = redditEgressSnapshot(5_500);
    expect(snap.available).toBe(false);
    expect(snap.proxyConfigured).toBe(true);
    expect(snap.consecutiveFailures).toBe(3);
    expect(snap.lastReason).toBe('dead proxy');
    expect(snap.openUntil).toBe(new Date(5_000 + 600_000).toISOString());
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SOCIAL_MERGED_TASK_QUEUE,
  computeRootWorkerSpecs,
  getTemporalWorkerMode,
  getSocialTaskQueue,
  getEnabledProviderAllowlist,
  isProviderEnabled,
} from '../task-queue';

// Snapshot env vars so tests don't leak state when mutating process.env.
const originalMode = process.env.TEMPORAL_WORKER_MODE;
const originalAllowlist = process.env.ENABLED_PROVIDERS;

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = original;
  }
}

afterEach(() => {
  restoreEnv('TEMPORAL_WORKER_MODE', originalMode);
  restoreEnv('ENABLED_PROVIDERS', originalAllowlist);
});

describe('getTemporalWorkerMode', () => {
  it('returns "merged" when env unset', () => {
    delete process.env.TEMPORAL_WORKER_MODE;
    expect(getTemporalWorkerMode()).toBe('merged');
  });

  it('returns "merged" for unrecognized values', () => {
    process.env.TEMPORAL_WORKER_MODE = 'banana';
    expect(getTemporalWorkerMode()).toBe('merged');
  });

  it('returns "per-provider" only for the exact literal', () => {
    process.env.TEMPORAL_WORKER_MODE = 'per-provider';
    expect(getTemporalWorkerMode()).toBe('per-provider');
  });
});

describe('getSocialTaskQueue', () => {
  beforeEach(() => {
    delete process.env.ENABLED_PROVIDERS;
  });

  it('returns the merged queue in merged mode regardless of identifier', () => {
    process.env.TEMPORAL_WORKER_MODE = 'merged';
    expect(getSocialTaskQueue('x')).toBe(SOCIAL_MERGED_TASK_QUEUE);
    expect(getSocialTaskQueue('linkedin-page')).toBe(SOCIAL_MERGED_TASK_QUEUE);
  });

  it('returns the identifier root in per-provider mode', () => {
    process.env.TEMPORAL_WORKER_MODE = 'per-provider';
    expect(getSocialTaskQueue('x')).toBe('x');
    expect(getSocialTaskQueue('linkedin')).toBe('linkedin');
  });

  it('strips sub-variant suffix and lowercases in per-provider mode', () => {
    process.env.TEMPORAL_WORKER_MODE = 'per-provider';
    expect(getSocialTaskQueue('linkedin-page')).toBe('linkedin');
    expect(getSocialTaskQueue('INSTAGRAM-STANDALONE')).toBe('instagram');
  });
});

describe('getEnabledProviderAllowlist', () => {
  it('returns null when env unset', () => {
    delete process.env.ENABLED_PROVIDERS;
    expect(getEnabledProviderAllowlist()).toBeNull();
  });

  it('returns null for an empty string', () => {
    process.env.ENABLED_PROVIDERS = '';
    expect(getEnabledProviderAllowlist()).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    process.env.ENABLED_PROVIDERS = '   ';
    expect(getEnabledProviderAllowlist()).toBeNull();
  });

  it('parses a simple CSV and lowercases entries', () => {
    process.env.ENABLED_PROVIDERS = 'X,LinkedIn';
    const allowlist = getEnabledProviderAllowlist();
    expect(allowlist).toEqual(new Set(['x', 'linkedin']));
  });

  it('trims whitespace and drops empty tokens', () => {
    process.env.ENABLED_PROVIDERS = ' x , , linkedin-page ,';
    const allowlist = getEnabledProviderAllowlist();
    expect(allowlist).toEqual(new Set(['x', 'linkedin-page']));
  });
});

describe('isProviderEnabled', () => {
  it('returns true when allowlist is null (no restriction)', () => {
    expect(isProviderEnabled('x', null)).toBe(true);
    expect(isProviderEnabled('any-weird-thing', null)).toBe(true);
  });

  it('matches by exact identifier', () => {
    const allowlist = new Set(['x', 'linkedin']);
    expect(isProviderEnabled('x', allowlist)).toBe(true);
    expect(isProviderEnabled('linkedin', allowlist)).toBe(true);
    expect(isProviderEnabled('reddit', allowlist)).toBe(false);
  });

  it('matches sub-variant by its root', () => {
    // When allowlist names the root ('linkedin'), sub-variants ('linkedin-page')
    // are also enabled. This is the common, expected case.
    const allowlist = new Set(['linkedin']);
    expect(isProviderEnabled('linkedin', allowlist)).toBe(true);
    expect(isProviderEnabled('linkedin-page', allowlist)).toBe(true);
  });

  it('does NOT match root when only a sub-variant is listed', () => {
    // This is the C1 scenario: allowlist has only 'linkedin-page', so the
    // LinkedinProvider (identifier='linkedin') is NOT enabled. The fix for
    // the orphaned-worker bug lives in temporal.module.ts — this function is
    // deliberately strict about root vs variant distinction.
    const allowlist = new Set(['linkedin-page']);
    expect(isProviderEnabled('linkedin', allowlist)).toBe(false);
    expect(isProviderEnabled('linkedin-page', allowlist)).toBe(true);
  });

  it('is case-insensitive', () => {
    const allowlist = new Set(['linkedin']);
    expect(isProviderEnabled('LINKEDIN', allowlist)).toBe(true);
    expect(isProviderEnabled('LinkedIn-Page', allowlist)).toBe(true);
  });
});

describe('computeRootWorkerSpecs', () => {
  it('returns an empty map for an empty provider list', () => {
    expect(computeRootWorkerSpecs([])).toEqual(new Map());
  });

  it('creates one spec per root identifier', () => {
    const specs = computeRootWorkerSpecs([
      { identifier: 'x', maxConcurrentJob: 1 },
      { identifier: 'linkedin', maxConcurrentJob: 2 },
      { identifier: 'reddit', maxConcurrentJob: 1 },
    ]);
    expect(specs.size).toBe(3);
    expect(specs.get('x')).toEqual({ maxConcurrentJob: 1 });
    expect(specs.get('linkedin')).toEqual({ maxConcurrentJob: 2 });
    expect(specs.get('reddit')).toEqual({ maxConcurrentJob: 1 });
  });

  it('regression for C1: derives a root spec from a sub-variant only', () => {
    // This is the exact bug scenario: user sets ENABLED_PROVIDERS="linkedin-page".
    // Without this derivation, the linkedin worker would not spawn and posts
    // would hang because getSocialTaskQueue('linkedin-page') routes to 'linkedin'.
    const specs = computeRootWorkerSpecs([
      { identifier: 'linkedin-page', maxConcurrentJob: 2 },
    ]);
    expect(specs.has('linkedin')).toBe(true);
    expect(specs.get('linkedin')).toEqual({ maxConcurrentJob: 2 });
  });

  it('merges root + sub-variant into one spec', () => {
    const specs = computeRootWorkerSpecs([
      { identifier: 'linkedin', maxConcurrentJob: 2 },
      { identifier: 'linkedin-page', maxConcurrentJob: 2 },
    ]);
    expect(specs.size).toBe(1);
    expect(specs.get('linkedin')).toEqual({ maxConcurrentJob: 2 });
  });

  it('picks the smallest maxConcurrentJob across variants sharing a root', () => {
    // Preserves the strictest rate limit when variants disagree.
    const specs = computeRootWorkerSpecs([
      { identifier: 'linkedin-page', maxConcurrentJob: 5 },
      { identifier: 'linkedin', maxConcurrentJob: 2 },
    ]);
    expect(specs.get('linkedin')).toEqual({ maxConcurrentJob: 2 });
  });

  it('leaves maxConcurrentJob undefined when no variant declares one', () => {
    const specs = computeRootWorkerSpecs([
      { identifier: 'custom-a' },
      { identifier: 'custom-b' },
    ]);
    expect(specs.get('custom')).toEqual({ maxConcurrentJob: undefined });
  });

  it('prefers a variant with a defined cap over one without', () => {
    const specs = computeRootWorkerSpecs([
      { identifier: 'linkedin' }, // no cap
      { identifier: 'linkedin-page', maxConcurrentJob: 2 },
    ]);
    expect(specs.get('linkedin')).toEqual({ maxConcurrentJob: 2 });
  });

  it('lowercases the root key', () => {
    const specs = computeRootWorkerSpecs([
      { identifier: 'LinkedIn-Page', maxConcurrentJob: 2 },
    ]);
    expect(specs.has('linkedin')).toBe(true);
    expect(specs.has('LinkedIn')).toBe(false);
  });
});

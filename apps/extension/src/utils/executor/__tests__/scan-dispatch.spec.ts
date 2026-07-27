import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngageScanTask, ScanRunResult } from '../executor.types';

const ok = (): ScanRunResult => ({
  posts: [{ platform: 'x', externalPostId: '1', externalPostUrl: 'u', authorUsername: 'a', postContent: 'c', postPublishedAt: '2026-01-01T00:00:00Z' }],
  nextCursor: { lastSeenExternalId: '1', lastSeenAt: '2026-01-01T00:00:00Z' },
  exhausted: true,
});

const {
  scanReddit, scanX, scanLinkedin, scanDevto, scanHackernews, scanMedium, scanQuora,
} = vi.hoisted(() => ({
  scanReddit: vi.fn(async () => ok()),
  scanX: vi.fn(async () => ok()),
  scanLinkedin: vi.fn(async () => ok()),
  scanDevto: vi.fn(async () => ok()),
  scanHackernews: vi.fn(async () => ok()),
  scanMedium: vi.fn(async () => ok()),
  scanQuora: vi.fn(async () => ok()),
}));

vi.mock('../scan.reddit', () => ({ scanReddit }));
vi.mock('../scan.x', () => ({ scanX }));
vi.mock('../scan.linkedin', () => ({ scanLinkedin }));
vi.mock('../scan.devto', () => ({ scanDevto }));
vi.mock('../scan.hackernews', () => ({ scanHackernews }));
vi.mock('../scan.medium', () => ({ scanMedium }));
vi.mock('../scan.quora', () => ({ scanQuora }));
// Risk-controlled platforms gated OFF (as in a default build); public API ones on.
vi.mock('../flags', () => ({
  X_EXECUTOR_ENABLED: false,
  LINKEDIN_EXECUTOR_ENABLED: false,
  MEDIUM_EXECUTOR_ENABLED: false,
  QUORA_EXECUTOR_ENABLED: false,
}));
vi.mock('../pacing', () => ({
  tryConsumeHourly: vi.fn(async () => true),
  remainingHourlyBudget: vi.fn(async () => 100),
  selectUnitDelay: vi.fn(() => ({ baseMs: 0, jitterMs: 0 })),
  applyDelay: vi.fn(async () => {}),
}));

import { dispatchScan } from '../scan.runner';

const task = (platform: EngageScanTask['platform']): EngageScanTask => ({
  taskId: 't',
  platform,
  scanType: 'keyword',
  scanKey: 'kw',
  cursor: { lastSeenExternalId: null, lastSeenAt: null },
  pacing: {
    maxPages: 1, pageSize: 10, pageDelayMs: 0, pageJitterMs: 0,
    interUnitDelayMs: 0, interUnitJitterMs: 0, hourlyRequestCap: 100,
  },
});
const gate = () => Promise.resolve(true);

describe('dispatchScan routing + gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes ungated public-API platforms to their scanner', async () => {
    await dispatchScan(task('reddit'), gate);
    await dispatchScan(task('devto'), gate);
    await dispatchScan(task('hackernews'), gate);
    expect(scanReddit).toHaveBeenCalledOnce();
    expect(scanDevto).toHaveBeenCalledOnce();
    expect(scanHackernews).toHaveBeenCalledOnce();
  });

  it('refuses gated platforms WITHOUT calling their scanner when the flag is off', async () => {
    for (const p of ['x', 'linkedin', 'medium', 'quora'] as const) {
      const r = await dispatchScan(task(p), gate);
      expect(r.posts).toHaveLength(0);
      expect(r.exhausted).toBe(true);
    }
    expect(scanX).not.toHaveBeenCalled();
    expect(scanLinkedin).not.toHaveBeenCalled();
    expect(scanMedium).not.toHaveBeenCalled();
    expect(scanQuora).not.toHaveBeenCalled();
  });

  it('returns exhausted with no posts for an unknown platform', async () => {
    const r = await dispatchScan(task('myspace' as any), gate);
    expect(r).toMatchObject({ posts: [], exhausted: true });
  });
});

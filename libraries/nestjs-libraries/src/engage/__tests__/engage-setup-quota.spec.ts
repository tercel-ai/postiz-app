import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { EngageService } from '@gitroom/nestjs-libraries/engage/engage.service';

/**
 * POST /engage/setup bulk-writes all three unit types at once. It used to skip
 * entitlement checks entirely, which made it a hole straight through both the
 * org-wide and the per-project cap.
 *
 * The gate charges NET NEW activations, not payload size: the repository appends
 * with `createMany({ skipDuplicates: true })` and never deletes, so a unit that
 * already exists under this config produces no new row and must cost nothing —
 * otherwise re-running the same setup would start failing near the cap.
 *
 * Channels and tracked accounts share one per-platform priority-accounts pool,
 * so their net-new units are grouped by platform and asserted as a single
 * combined 'tracked' charge per platform.
 */
describe('EngageService.setupEngage — quota gate', () => {
  const org = { id: 'org-1' } as any;

  function buildService(existing?: {
    keywords?: { keyword: string }[];
    monitoredChannels?: { platform: string; channelId: string }[];
    trackedAccounts?: { platform: string; username: string }[];
  }) {
    const config = {
      id: 'cfg-1',
      keywords: existing?.keywords ?? [],
      monitoredChannels: existing?.monitoredChannels ?? [],
      trackedAccounts: existing?.trackedAccounts ?? [],
      xReplyAccounts: [],
    };
    const engageRepository = {
      getOrCreateConfig: vi.fn(async () => config),
      setupEngage: vi.fn(async () => ({ id: 'cfg-1' })),
    } as any;
    const assertCanActivate = vi.fn(async () => undefined);
    const entitlementService = { assertCanActivate } as any;

    const service = new EngageService(
      engageRepository,
      { client: undefined } as any, // temporal: _ensureGlobalWorkflowsRunning no-ops
      {} as any,
      {} as any,
      entitlementService,
      undefined,
      undefined,
      undefined
    );
    return { service, assertCanActivate, engageRepository };
  }

  /**
   * Counts asserted for one unit type (optionally one platform), or undefined
   * when never checked. Channels + tracked accounts share the per-platform
   * priority-accounts pool, so both are charged as ONE 'tracked' assert per
   * platform.
   */
  const charged = (mock: any, type: string, platform?: string) =>
    mock.mock.calls.find(
      (c: unknown[]) => c[1] === type && (platform === undefined || c[4] === platform)
    )?.[2];

  it('charges keywords, and channels+tracked as one per-platform pool, with the config id', async () => {
    const { service, assertCanActivate } = buildService();

    await service.setupEngage(org, {
      keywords: [{ keyword: 'alpha' }, { keyword: 'beta' }],
      monitoredChannels: [
        { platform: 'reddit', channelId: 'r1', channelName: 'r/one' },
      ],
      trackedAccounts: [{ username: 'someone' }],
    } as any);

    expect(charged(assertCanActivate, 'keyword')).toBe(2);
    // The reddit channel and the (default-'x') tracked account land on
    // different platforms → one combined pool charge per platform.
    expect(charged(assertCanActivate, 'tracked', 'reddit')).toBe(1);
    expect(charged(assertCanActivate, 'tracked', 'x')).toBe(1);
    // Every call carries the config id, so the per-project cap actually applies.
    for (const call of assertCanActivate.mock.calls) {
      expect(call[0]).toBe('org-1');
      expect(call[3]).toBe('cfg-1');
    }
  });

  it('sums channels and tracked accounts on the SAME platform into one charge', async () => {
    const { service, assertCanActivate } = buildService();

    await service.setupEngage(org, {
      monitoredChannels: [
        { platform: 'x', channelId: 'list1', channelName: 'list one' },
      ],
      trackedAccounts: [{ platform: 'x', username: 'someone' }],
    } as any);

    // 1 channel + 1 tracked on X → a single combined charge of 2, so the two
    // types cannot each fill the shared pool separately.
    expect(charged(assertCanActivate, 'tracked', 'x')).toBe(2);
    expect(assertCanActivate).toHaveBeenCalledTimes(1);
  });

  it('does not write when a cap rejects the payload', async () => {
    const { service, assertCanActivate, engageRepository } = buildService();
    assertCanActivate.mockRejectedValueOnce(new ForbiddenException('nope'));

    await expect(
      service.setupEngage(org, { keywords: [{ keyword: 'alpha' }] } as any)
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(engageRepository.setupEngage).not.toHaveBeenCalled();
  });

  it('charges nothing for units that already exist (skipDuplicates re-run)', async () => {
    const { service, assertCanActivate } = buildService({
      keywords: [{ keyword: 'alpha' }, { keyword: 'beta' }],
      monitoredChannels: [{ platform: 'reddit', channelId: 'r1' }],
      trackedAccounts: [{ platform: 'x', username: 'someone' }],
    });

    // Byte-identical replay of the previous setup.
    await service.setupEngage(org, {
      keywords: [{ keyword: 'alpha' }, { keyword: 'beta' }],
      monitoredChannels: [
        { platform: 'reddit', channelId: 'r1', channelName: 'r/one' },
      ],
      trackedAccounts: [{ platform: 'x', username: 'someone' }],
    } as any);

    expect(assertCanActivate).not.toHaveBeenCalled();
  });

  it('charges only the genuinely new units in a partially-overlapping payload', async () => {
    const { service, assertCanActivate } = buildService({
      keywords: [{ keyword: 'alpha' }],
    });

    await service.setupEngage(org, {
      keywords: [{ keyword: 'alpha' }, { keyword: 'beta' }, { keyword: 'gamma' }],
    } as any);

    expect(charged(assertCanActivate, 'keyword')).toBe(2);
  });

  it('counts a unit repeated within one payload once, like the write does', async () => {
    const { service, assertCanActivate } = buildService();

    await service.setupEngage(org, {
      keywords: [{ keyword: 'alpha' }, { keyword: 'alpha' }],
      trackedAccounts: [
        { platform: 'x', username: 'dup' },
        { username: 'dup' }, // platform defaults to 'x' — the same unique key
      ],
    } as any);

    expect(charged(assertCanActivate, 'keyword')).toBe(1);
    expect(charged(assertCanActivate, 'tracked', 'x')).toBe(1);
  });

  it('does not charge a keyword explicitly sent as disabled', async () => {
    const { service, assertCanActivate } = buildService();

    await service.setupEngage(org, {
      keywords: [{ keyword: 'alpha', enabled: false }, { keyword: 'beta' }],
    } as any);

    expect(charged(assertCanActivate, 'keyword')).toBe(1);
  });

  it('skips the check entirely for unit types the payload omits', async () => {
    const { service, assertCanActivate } = buildService();

    await service.setupEngage(org, { keywords: [{ keyword: 'alpha' }] } as any);

    expect(charged(assertCanActivate, 'subreddit')).toBeUndefined();
    expect(charged(assertCanActivate, 'tracked')).toBeUndefined();
  });

  it('treats the same channelId on different platforms as distinct units', async () => {
    const { service, assertCanActivate } = buildService({
      monitoredChannels: [{ platform: 'reddit', channelId: 'shared' }],
    });

    await service.setupEngage(org, {
      keywords: [{ keyword: 'alpha' }],
      monitoredChannels: [
        { platform: 'reddit', channelId: 'shared', channelName: 'r/shared' },
        { platform: 'linkedin', channelId: 'shared', channelName: 'shared' },
      ],
    } as any);

    // Only the linkedin one is new; its charge lands on its own platform pool.
    expect(charged(assertCanActivate, 'tracked', 'linkedin')).toBe(1);
    expect(charged(assertCanActivate, 'tracked', 'reddit')).toBeUndefined();
  });
});

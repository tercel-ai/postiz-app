import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
  isPublishingActive,
  mergePublishWindows,
  ProjectPublishingService,
  readPublishingPolicies,
  resolveEnabledPlatforms,
} from '../project-publishing.service';

// These three fields were written by the Automation page into
// EngageConfig.replyPolicies and read by NOBODY — the time window a user set
// had no effect on when anything published. These tests pin the reading of
// them, which is what makes the setting real.
describe('readPublishingPolicies', () => {
  it('picks the publishing keys out of a blob shared with reply policies', () => {
    expect(
      readPublishingPolicies({
        x: {
          publishingEnabled: true,
          publishingWindowStart: '09:00',
          publishingWindowEnd: '17:00',
          // Reply-side neighbours in the same object — ignored, not rejected.
          autoReplyEnabled: true,
          length: 'short',
        },
      })
    ).toEqual({
      x: {
        publishingEnabled: true,
        publishingWindowStart: '09:00',
        publishingWindowEnd: '17:00',
      },
    });
  });

  it('lower-cases platform keys and drops platforms with no publishing fields', () => {
    expect(
      readPublishingPolicies({ LinkedIn: { publishingEnabled: false }, x: { length: 'long' } })
    ).toEqual({ linkedin: { publishingEnabled: false } });
  });

  it('ignores a malformed blob instead of throwing', () => {
    expect(readPublishingPolicies(null)).toEqual({});
    expect(readPublishingPolicies('nope')).toEqual({});
    expect(readPublishingPolicies([{ publishingEnabled: true }])).toEqual({});
    expect(readPublishingPolicies({ x: 'not-an-object' })).toEqual({});
  });

  it('ignores publishing fields of the wrong type', () => {
    expect(
      readPublishingPolicies({ x: { publishingEnabled: 'yes', publishingWindowStart: 9 } })
    ).toEqual({});
  });
});

describe('resolveEnabledPlatforms', () => {
  it('returns null when no platform has been decided either way', () => {
    // "Never configured" must stay unconstrained, or every project that predates
    // this setting would silently stop publishing.
    expect(resolveEnabledPlatforms({})).toBeNull();
    expect(
      resolveEnabledPlatforms({ x: { publishingWindowStart: '09:00' } })
    ).toBeNull();
  });

  it('returns an EMPTY list when every platform is explicitly off', () => {
    // Distinct from null on purpose: this is the master switch turned off, and
    // it must queue nothing rather than everything.
    expect(
      resolveEnabledPlatforms({
        x: { publishingEnabled: false },
        reddit: { publishingEnabled: false },
      })
    ).toEqual([]);
  });

  it('returns only the enabled platforms', () => {
    expect(
      resolveEnabledPlatforms({
        x: { publishingEnabled: true },
        reddit: { publishingEnabled: false },
        linkedin: { publishingEnabled: true },
      })
    ).toEqual(['x', 'linkedin']);
  });
});

describe('mergePublishWindows', () => {
  it("lets the project's window override the admin one", () => {
    expect(
      mergePublishWindows(
        { x: { windowStart: '06:00', windowEnd: '22:00' } },
        { x: { publishingWindowStart: '09:00', publishingWindowEnd: '17:00' } }
      )
    ).toEqual({ x: { windowStart: '09:00', windowEnd: '17:00' } });
  });

  it('inherits the admin window timezone when the project names none', () => {
    // An admin who pinned New York meant those bounds to be New York time; a
    // project narrowing the hours inside it did not mean to reinterpret as UTC.
    expect(
      mergePublishWindows(
        { x: { windowStart: '06:00', windowEnd: '22:00', timezone: 'America/New_York' } },
        { x: { publishingWindowStart: '09:00', publishingWindowEnd: '17:00' } }
      )
    ).toEqual({
      x: { windowStart: '09:00', windowEnd: '17:00', timezone: 'America/New_York' },
    });
  });

  it("prefers the project's own timezone over the inherited one", () => {
    expect(
      mergePublishWindows(
        { x: { windowStart: '06:00', windowEnd: '22:00', timezone: 'America/New_York' } },
        {
          x: {
            publishingWindowStart: '09:00',
            publishingWindowEnd: '17:00',
            publishingTimezone: 'Asia/Shanghai',
          },
        }
      )
    ).toEqual({
      x: { windowStart: '09:00', windowEnd: '17:00', timezone: 'Asia/Shanghai' },
    });
  });

  it('keeps the admin window when the project window is malformed', () => {
    // A bad edit must never WIDEN publishing past what an admin allowed, so the
    // admin tier stands rather than the window being cleared.
    const admin = { x: { windowStart: '09:00', windowEnd: '17:00' } };
    expect(
      mergePublishWindows(admin, {
        x: { publishingWindowStart: '25:00', publishingWindowEnd: '17:00' },
      })
    ).toEqual(admin);
    expect(
      mergePublishWindows(admin, {
        // start === end is not a window, it is a moment.
        x: { publishingWindowStart: '09:00', publishingWindowEnd: '09:00' },
      })
    ).toEqual(admin);
  });

  it('leaves a platform the project said nothing about on the admin window', () => {
    expect(
      mergePublishWindows(
        { x: { windowStart: '09:00', windowEnd: '17:00' } },
        { reddit: { publishingEnabled: true } }
      )
    ).toEqual({ x: { windowStart: '09:00', windowEnd: '17:00' } });
  });

  it('adds a window for a platform the admin left unconstrained', () => {
    expect(
      mergePublishWindows(
        {},
        { reddit: { publishingWindowStart: '10:00', publishingWindowEnd: '20:00' } }
      )
    ).toEqual({ reddit: { windowStart: '10:00', windowEnd: '20:00' } });
  });
});

// The assertion that closes the hole: ProjectAuthGuard authorizes the projectId
// in the request, but nothing previously checked that the planId in the same
// request was THAT project's plan.
describe('ProjectPublishingService.assertPlanBelongsToProject', () => {
  const makeService = (plan: { projectId: string | null } | null) => {
    const findFirst = vi.fn().mockResolvedValue(plan);
    const service = new ProjectPublishingService(
      { model: { operationPlan: { findFirst } } } as any,
      { model: { engageConfig: { findFirst: vi.fn() } } } as any,
      { getPublishTimeWindows: vi.fn() } as any
    );
    return { service, findFirst };
  };

  it('passes for a plan of the same project', async () => {
    const { service, findFirst } = makeService({ projectId: 'proj-1' });
    await expect(
      service.assertPlanBelongsToProject('org-1', 'proj-1', 'plan-1')
    ).resolves.toBeUndefined();
    // Org-scoped at the query level too — a plan of another ORG is simply absent.
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'plan-1', organizationId: 'org-1' },
      select: { projectId: true },
    });
  });

  it("404s for another project's plan rather than 403", async () => {
    // Whether a sibling project owns that id is not this caller's to learn.
    const { service } = makeService({ projectId: 'proj-2' });
    await expect(
      service.assertPlanBelongsToProject('org-1', 'proj-1', 'plan-1')
    ).rejects.toMatchObject({ status: 404 });
  });

  it('404s for a plan that does not exist in this org', async () => {
    const { service } = makeService(null);
    await expect(
      service.assertPlanBelongsToProject('org-1', 'proj-1', 'plan-1')
    ).rejects.toMatchObject({ status: 404 });
  });

  it('403s for a legacy plan with no project at all', async () => {
    // It exists and is this org's — it just predates project scoping and cannot
    // be driven through a project-scoped route.
    const { service } = makeService({ projectId: null });
    await expect(
      service.assertPlanBelongsToProject('org-1', 'proj-1', 'plan-1')
    ).rejects.toMatchObject({ status: 403 });
  });
});

// master AND feature. The per-platform level is applied downstream, per post.
describe('isPublishingActive', () => {
  it('requires BOTH the master and the feature switch', () => {
    expect(isPublishingActive({ automationEnabled: true, publishingEnabled: true })).toBe(true);
    expect(isPublishingActive({ automationEnabled: false, publishingEnabled: true })).toBe(false);
    expect(isPublishingActive({ automationEnabled: true, publishingEnabled: false })).toBe(false);
    expect(isPublishingActive({ automationEnabled: false, publishingEnabled: false })).toBe(false);
  });
});

describe('ProjectPublishingService.resolve', () => {
  it("layers the project's settings over the admin publish windows", async () => {
    const service = new ProjectPublishingService(
      { model: { operationPlan: { findFirst: vi.fn() } } } as any,
      {
        model: {
          engageConfig: {
            findFirst: vi.fn().mockResolvedValue({
              metadata: {
                replyPolicies: {
                  x: {
                    publishingEnabled: true,
                    publishingWindowStart: '09:00',
                    publishingWindowEnd: '17:00',
                  },
                  reddit: { publishingEnabled: false },
                },
              },
            }),
          },
        },
      } as any,
      {
        getPublishTimeWindows: vi
          .fn()
          .mockResolvedValue({ x: { windowStart: '06:00', windowEnd: '22:00' } }),
      } as any
    );

    await expect(service.resolve('org-1', 'proj-1')).resolves.toEqual({
      // The fixture's metadata sets no master switch, so it resolves off — the
      // platform/window resolution below is independent of it.
      automationEnabled: false,
      publishingEnabled: true,
      publishingConfigured: false,
      enabledPlatforms: ['x'],
      windows: { x: { windowStart: '09:00', windowEnd: '17:00' } },
      platformDecisions: { x: true, reddit: false },
    });
  });

  it('reports an unconfigured project as unconstrained', async () => {
    const service = new ProjectPublishingService(
      { model: { operationPlan: { findFirst: vi.fn() } } } as any,
      { model: { engageConfig: { findFirst: vi.fn().mockResolvedValue(null) } } } as any,
      { getPublishTimeWindows: vi.fn().mockResolvedValue({}) } as any
    );

    await expect(service.resolve('org-1', 'proj-1')).resolves.toEqual({
      automationEnabled: false,
      publishingEnabled: false,
      publishingConfigured: false,
      enabledPlatforms: null,
      windows: {},
      platformDecisions: {},
    });
  });
});

// The switch columns are read here, and their THREE-state handling is what keeps
// a deploy from silently changing every existing project's behaviour.
describe('ProjectPublishingService.resolve — switch resolution', () => {
  const makeService = (config: Record<string, unknown> | null) =>
    new ProjectPublishingService(
      { model: { operationPlan: { findFirst: vi.fn() } } } as any,
      { model: { engageConfig: { findFirst: vi.fn().mockResolvedValue(config) } } } as any,
      { getPublishTimeWindows: vi.fn().mockResolvedValue({}) } as any
    );

  it('treats a project with no config row as fully off', async () => {
    // Never switched Automation on, and never turned a platform on either.
    // Absence is not consent for something that posts with a real account.
    await expect(makeService(null).resolve('org-1', 'proj-1')).resolves.toMatchObject({
      automationEnabled: false,
      publishingEnabled: false,
      publishingConfigured: false,
    });
  });

  it('falls back to the derived rule when publishingEnabled is absent', async () => {
    // A project that predates the switch: publishing was "on" iff some platform
    // was on, and it must keep behaving that way rather than flipping on deploy.
    await expect(
      makeService({
        metadata: { replyPolicies: { x: { publishingEnabled: true } } },
      }).resolve('org-1', 'proj-1')
    ).resolves.toMatchObject({ publishingEnabled: true, publishingConfigured: false });

    await expect(
      makeService({
        metadata: { replyPolicies: { x: { publishingEnabled: false } } },
      }).resolve('org-1', 'proj-1')
    ).resolves.toMatchObject({ publishingEnabled: false, publishingConfigured: false });
  });

  it('lets an explicit false win over platforms that are still selected', async () => {
    // The whole reason the column exists: turning the feature off must not have
    // to clear the platform list, so the list survives to be restored.
    await expect(
      makeService({
        metadata: {
          publishingEnabled: false,
          replyPolicies: { x: { publishingEnabled: true } },
        },
      }).resolve('org-1', 'proj-1')
    ).resolves.toMatchObject({
      publishingEnabled: false,
      publishingConfigured: true,
      enabledPlatforms: ['x'],
    });
  });

  it('lets an explicit true win with no platform selected yet', async () => {
    await expect(
      makeService({ metadata: { publishingEnabled: true, replyPolicies: {} } }).resolve(
        'org-1',
        'proj-1'
      )
    ).resolves.toMatchObject({
      publishingEnabled: true,
      publishingConfigured: true,
      enabledPlatforms: null,
    });
  });

  it('reports the master switch independently of the feature switch', async () => {
    // Reported separately, never pre-ANDed: a client has to be able to show
    // "publishing is on, Automation is off overall" without losing the setting.
    await expect(
      makeService({
        metadata: {
          automationEnabled: false,
          publishingEnabled: true,
          replyPolicies: { x: { publishingEnabled: true } },
        },
      }).resolve('org-1', 'proj-1')
    ).resolves.toMatchObject({ automationEnabled: false, publishingEnabled: true });
  });
});

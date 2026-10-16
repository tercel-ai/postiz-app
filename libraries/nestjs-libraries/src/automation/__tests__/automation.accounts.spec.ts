import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AutomationService } from '../automation.service';
import {
  SaveAutomationPublishingDto,
  SaveAutomationRepliesDto,
} from '../automation.dto';
import { readEngageConfigMetadata } from '../../engage/engage-config-metadata';

beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());
const accounts = { x: { integrationId: 'account', expectedRevision: 0 } };
function setup() {
  const existing = {
    metadata: {
      publishingEnabled: true,
      autoReplyEnabled: false,
      replyPolicies: {
        x: {
          publishingEnabled: true,
          publishingWindowStart: '08:00',
          publishingWindowEnd: '18:00',
        },
        reddit: { publishingEnabled: false, strategy: 'question' },
      },
    },
  };
  const settings = readEngageConfigMetadata(existing);
  const posts = {
    alignPlanDraftPublishDates: vi.fn(),
    rescheduleQueuedPlanPosts: vi
      .fn()
      .mockResolvedValue({ rescheduled: 0, skipped: [] }),
    schedulePlanPosts: vi.fn().mockResolvedValue({ scheduled: [] }),
    uncommitPlanPosts: vi.fn().mockResolvedValue({ uncommitted: 0, groups: 0 }),
  };
  const repository = {
    getConfigCore: vi.fn().mockResolvedValue(existing),
    saveConfig: vi.fn(),
  };
  const engage = {
    saveConfig: vi.fn(),
    activateScanning: vi.fn().mockResolvedValue(undefined),
  };
  const publishing = {
    resolve: vi.fn().mockResolvedValue({
      automationEnabled: true,
      publishingEnabled: true,
      enabledPlatforms: ['x'],
      platformDecisions: { x: true, reddit: false },
      windows: {},
    }),
  };
  const bindings = {
    save: vi
      .fn()
      .mockImplementation(
        async (_org, _user, _project, _action, _accounts, transform) => ({
          saved: true,
          bindings: [{ platform: 'x', integrationId: 'account', revision: 1 }],
          settings: transform ? transform(settings) : settings,
        })
      ),
  };
  const automatic = {assertOwnerAvailable:vi.fn(),saveOwner:vi.fn(),owner:vi.fn().mockResolvedValue('user')};
  const service = new AutomationService(
    posts as any,
    { getActivePlanId: vi.fn().mockResolvedValue({ id: 'plan' }) } as any,
    engage as any,
    repository as any,
    publishing as any,
    {} as any,
    bindings as any,
    undefined,
    automatic as any
  );
  return { service, bindings, posts, engage, repository, publishing, settings, automatic };
}

describe('automation account DTO compatibility', () => {
  it('accepts account-only saves without requiring publishing platforms', async () => {
    expect(
      await validate(plainToInstance(SaveAutomationPublishingDto, { accounts }))
    ).toEqual([]);
    expect(
      await validate(plainToInstance(SaveAutomationRepliesDto, { accounts }))
    ).toEqual([]);
  });
  it.each([
    { x: { integrationId: 'account' } },
    { x: { integrationId: 'account', expectedRevision: -1 } },
    {
      x: {
        integrationId: 'account',
        expectedRevision: 0,
        extensionNodeId: 'node',
      },
    },
    { unknown: { integrationId: 'account', expectedRevision: 0 } },
  ])('rejects malformed binding maps (%j)', async (value) => {
    expect(
      (
        await validate(
          plainToInstance(SaveAutomationPublishingDto, { accounts: value })
        )
      ).some((error) => error.property === 'accounts')
    ).toBe(true);
  });
});

describe('automation account save semantics', () => {
  it('saving a publishing account alone does not align, uncommit, commit, or replace platform policies', async () => {
    const { service, bindings, posts, repository } = setup();
    const result = await service.savePublishing(
      { id: 'org' } as any,
      'project',
      { accounts } as any,
      'user'
    );
    expect(result).toMatchObject({
      saved: true,
      scheduled: null,
      rescheduled: null,
      uncommitted: null,
      bindings: [{ revision: 1 }],
    });
    expect(bindings.save.mock.calls[0].slice(0, 5)).toEqual([
      'org',
      'user',
      'project',
      'POST',
      accounts,
    ]);
    expect(posts.alignPlanDraftPublishDates).not.toHaveBeenCalled();
    expect(posts.uncommitPlanPosts).not.toHaveBeenCalled();
    expect(posts.schedulePlanPosts).not.toHaveBeenCalled();
    expect(repository.saveConfig).not.toHaveBeenCalled();
  });
  it('saving a reply account alone does not enable replies, scanning, or replace policies', async () => {
    const { service, bindings, engage } = setup();
    await service.saveReplies(
      { id: 'org' } as any,
      'project',
      { accounts } as any,
      'user'
    );
    expect(bindings.save.mock.calls[0].slice(0, 5)).toEqual([
      'org',
      'user',
      'project',
      'REPLY',
      accounts,
    ]);
    expect(engage.saveConfig).not.toHaveBeenCalled();
    expect(engage.activateScanning).not.toHaveBeenCalled();
  });
  it('account and reply policy replacement use the same atomic writer and preserve publishing keys', async () => {
    const { service, bindings, engage } = setup();
    await service.saveReplies(
      { id: 'org' } as any,
      'project',
      {
        accounts,
        autoReplyEnabled: true,
        policies: { x: { autoReplyEnabled: true, strategy: 'question' } },
      } as any,
      'user'
    );
    const transform = bindings.save.mock.calls[0][5];
    const next = transform({
      automationEnabled: false,
      publishingEnabled: true,
      autoReplyEnabled: false,
      replyPolicies: {
        x: { publishingEnabled: true, publishingWindowStart: '09:00' },
        reddit: { publishingEnabled: false, strategy: 'old' },
      },
    });
    expect(next.replyPolicies.x.publishingWindowStart).toBe('09:00');
    expect(next.replyPolicies.reddit.strategy).toBeUndefined();
    expect(next.scanEnabled).toBe(true);
    expect(engage.activateScanning).toHaveBeenCalledTimes(1);
    expect(engage.saveConfig).not.toHaveBeenCalled();
  });
  it('omitting publishing platforms preserves selection when an account and window are saved', async () => {
    const { service, bindings } = setup();
    await service.savePublishing(
      { id: 'org' } as any,
      'project',
      { accounts, windows: { x: { start: '09:00', end: '17:00' } } } as any,
      'user'
    );
    const transform = bindings.save.mock.calls[0][5];
    const next = transform({
      automationEnabled: false,
      publishingEnabled: true,
      autoReplyEnabled: false,
      replyPolicies: {
        x: { publishingEnabled: true },
        reddit: { publishingEnabled: false },
      },
    });
    expect(next.replyPolicies.x.publishingEnabled).toBe(true);
    expect(next.replyPolicies.reddit.publishingEnabled).toBe(false);
  });
  it('legacy explicit platform replacement still does not touch account bindings', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED','false');
    const { service, bindings, repository } = setup();
    await service.savePublishing({ id: 'org' } as any, 'project', {
      platforms: [],
    });
    expect(bindings.save).not.toHaveBeenCalled();
    expect(
      repository.saveConfig.mock.calls[0][1].metadata.replyPolicies.x
        .publishingEnabled
    ).toBe(false);
  });
  it('rejects new account saves while the capability is disabled instead of silently ignoring fields', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
    const { service, bindings } = setup();
    await expect(
      service.savePublishing(
        { id: 'org' } as any,
        'project',
        { accounts } as any,
        'user'
      )
    ).rejects.toMatchObject({ status: 503 });
    expect(bindings.save).not.toHaveBeenCalled();
  });
});

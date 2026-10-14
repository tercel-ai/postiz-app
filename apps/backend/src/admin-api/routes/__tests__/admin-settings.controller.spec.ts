import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { AdminSettingsController } from '../admin-settings.controller';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { OperationPlanService } from '@gitroom/nestjs-libraries/database/prisma/operation-plan/operation-plan.service';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import {
  canonicalOperationPlanPlatform,
  PlatformCadence,
} from '@gitroom/nestjs-libraries/database/prisma/operation-plan/platform-cadence';

const CADENCE_KEY = 'operation_plan.platform_cadence';

async function getCadence(controller: AdminSettingsController) {
  const result = await controller.getSetting(CADENCE_KEY);
  return { key: result.key, value: result.value as Record<string, PlatformCadence> };
}

function makeController(value: unknown) {
  const settingsService = {
    get: vi.fn().mockResolvedValue(value),
    set: vi.fn(),
  };
  const integrationManager = new IntegrationManager();
  const controller = new AdminSettingsController(
    settingsService as any,
    {} as any,
    {} as any,
    {} as any,
    integrationManager
  );
  return { controller, settingsService, integrationManager };
}

describe('AdminSettingsController platform cadence', () => {
  it('returns every registered provider with its effective default when the setting is absent', async () => {
    const { controller, integrationManager, settingsService } = makeController(null);

    const result = await getCadence(controller);

    expect(result.key).toBe(CADENCE_KEY);
    expect(Object.keys(result.value)).toEqual(
      [...new Set(integrationManager.getSocialProviderList()
        .map((provider) => canonicalOperationPlanPlatform(provider.identifier)))]
    );
    expect(result.value).toMatchObject({
      x: { cadence: '1 post per weekday, lighter on weekends; 1-2 threads per week' },
      linkedin: { cadence: '3-4 posts per week' },
      instagram: { cadence: '3-5 posts per week' },
      medium: { cadence: '1-2 articles per week' },
      mastodon: { cadence: '2-3 posts per week' },
    });
    expect(settingsService.get).toHaveBeenCalledExactlyOnceWith(CADENCE_KEY);
    expect(settingsService.set).not.toHaveBeenCalled();
  });

  it('keeps database overrides and supplies defaults for platforms missing from an older stored value', async () => {
    const stored = {
      x: { cadence: '2 posts per weekday', citationWeight: 'high', notes: 'Focus on data stories' },
      linkedin: { cadence: '1 post per week' },
      instagram: { cadence: '2 posts per week' },
    };
    const { controller } = makeController(stored);

    const result = await getCadence(controller);

    expect(result.value.x).toEqual(stored.x);
    expect(result.value.linkedin).toEqual(stored.linkedin);
    expect(result.value.instagram).toEqual(stored.instagram);
    expect(result.value.reddit).toMatchObject({ cadence: '2-3 self-posts per week across relevant subreddits' });
    expect(result.value.devto).toMatchObject({ cadence: '1-2 articles per week' });
    expect(Object.keys(stored)).toEqual(['x', 'linkedin', 'instagram']);
  });

  it('uses a database rule even when the platform only has a generic built-in fallback', async () => {
    const { controller } = makeController({ mastodon: { cadence: '1 post per week', notes: 'Keep it brief' } });

    const result = await getCadence(controller);

    expect(result.value.mastodon).toEqual({ cadence: '1 post per week', notes: 'Keep it brief' });
  });

  it('preserves whole-entry override semantics for a partial configured rule', async () => {
    const { controller } = makeController({ linkedin: { citationWeight: 'high' } });

    const result = await getCadence(controller);

    expect(result.value.linkedin).toEqual({ citationWeight: 'high' });
  });

  it.each([undefined, [], 'invalid', 42])('falls back when the stored map is malformed: %j', async (stored) => {
    const { controller } = makeController(stored);

    const result = await getCadence(controller);

    expect(result.value.linkedin).toMatchObject({ cadence: '3-4 posts per week' });
    expect(result.value.mastodon).toEqual({ cadence: '2-3 posts per week' });
  });

  it('falls back for empty or malformed platform entries and keeps valid prose fields', async () => {
    const { controller } = makeController({
      x: { cadence: '  ', citationWeight: null },
      linkedin: { cadence: 4 },
      instagram: [],
      medium: { cadence: 'weekly', citationWeight: 9, notes: 'Use examples' },
      reddit: {},
      devto: null,
    });

    const result = await getCadence(controller);

    expect(result.value.x.cadence).toContain('1 post per weekday');
    expect(result.value.linkedin.cadence).toBe('3-4 posts per week');
    expect(result.value.instagram.cadence).toBe('3-5 posts per week');
    expect(result.value.medium).toEqual({ cadence: 'weekly', notes: 'Use examples' });
    expect(result.value.reddit.cadence).toContain('2-3 self-posts');
    expect(result.value.devto.cadence).toBe('1-2 articles per week');
  });

  it('does not expose stored rules for identifiers outside the provider registry', async () => {
    const { controller } = makeController({ unsupported: { cadence: 'daily' } });

    const result = await getCadence(controller);

    expect(result.value).not.toHaveProperty('unsupported');
  });

  it('returns exactly the guidance the generator resolves for the same platforms', async () => {
    const { controller, settingsService } = makeController({
      x: { cadence: '2 posts per weekday', citationWeight: 'high' },
      linkedin: { citationWeight: 'high' },
      instagram: { cadence: false },
    });
    const service = new OperationPlanService({} as any, undefined, undefined, settingsService as any);
    const result = await getCadence(controller);
    const platforms = Object.keys(result.value);

    expect(await (service as any)._buildPlatformPlaybook(platforms)).toEqual(result.value);
  });

  it('exposes one LinkedIn rule and adopts a legacy page override when no profile rule exists', async () => {
    const { controller, settingsService } = makeController({ 'linkedin-page': { cadence: '2 posts per week' } });
    const service = new OperationPlanService({} as any, undefined, undefined, settingsService as any);
    const result = await getCadence(controller);

    expect(result.value).not.toHaveProperty('linkedin-page');
    expect(result.value.linkedin).toEqual({ cadence: '2 posts per week' });
    expect(await (service as any)._buildPlatformPlaybook(['linkedin'])).toEqual({
      linkedin: result.value.linkedin,
    });
  });

  it('prefers the canonical LinkedIn database rule over a legacy page rule', async () => {
    const { controller } = makeController({
      linkedin: { cadence: 'weekly' },
      'linkedin-page': { cadence: 'daily' },
    });

    expect((await getCadence(controller)).value.linkedin).toEqual({ cadence: 'weekly' });
  });

  it('keeps other settings responses unchanged', async () => {
    const stored = { custom: 'value' };
    const { controller } = makeController(stored);

    expect(await controller.getSetting('other.key')).toEqual({ key: 'other.key', value: stored });
  });

  it('still returns 404 for other missing settings', async () => {
    const { controller } = makeController(null);

    await expect(controller.getSetting('other.key')).rejects.toMatchObject({ status: 404 });
  });
});

function makeSaveAndGenerate(initial: Record<string, PlatformCadence> = {}) {
  let stored = structuredClone(initial);
  // Emulate JSON persistence while exercising the real SettingsService and both
  // controllers/services. No database or LLM endpoint is contacted.
  const settingsRepository = {
    getValue: vi.fn(async (key: string) => key === CADENCE_KEY ? structuredClone(stored) : null),
    set: vi.fn(async (key: string, value: Record<string, PlatformCadence>) => {
      if (key === CADENCE_KEY) stored = structuredClone(value);
    }),
  };
  const settingsService = new SettingsService(settingsRepository as any);
  const controller = new AdminSettingsController(
    settingsService,
    {} as any,
    {} as any,
    {} as any,
    new IntegrationManager()
  );
  const planRepository = {
    findManyByTaskId: vi.fn().mockResolvedValue([]),
    getConnectedPlatforms: vi.fn().mockResolvedValue(['linkedin-page']),
  };
  const aiseeClient = {
    getTaskDetail: vi.fn(async (id: string) => ({
      ok: true,
      task: {
        id,
        userId: 'owner-1',
        productId: 'proj-1',
        status: 'completed',
        result: { summary: 'Usable analysis' },
        productSnapshot: { name: 'Product', keywords: [] },
      },
    })),
  };
  const creditService = {
    resolveOwnerUserId: vi.fn().mockResolvedValue('owner-1'),
    hasCredits: vi.fn().mockResolvedValue(true),
  };
  const openaiService = {
    generateStructuredText: vi.fn(async (_system: string, userPrompt: string) => {
      const payload = JSON.parse(userPrompt);
      return {
        data: {
          goal: { title: 'Goal', description: 'Plan description', targetScore: 70 },
          contentItems: [{
            contentId: 'content-1',
            utcDate: payload.range.startAt,
            themeKey: 'w1:foundations',
            themeTitle: 'Practical lessons',
            platforms: payload.platforms.map((platform: string, index: number) => ({
              id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
              platform,
              content: `Practical lessons for ${platform}`,
              thread: null,
              media: null,
              subreddit: null,
              flairLabel: null,
              titleTag: null,
              tags: null,
            })),
          }],
          engagePolicies: [],
          warnings: [],
        },
        usage: { usage: { total_tokens: 100 } },
      };
    }),
  };
  const service = new OperationPlanService(
    planRepository as any,
    aiseeClient as any,
    creditService as any,
    settingsService,
    openaiService as any
  );
  const generate = (taskId: string, platforms: string[] = ['x', 'linkedin-page', 'mastodon']) =>
    service.create('org-1', 'proj-1', {
      taskId,
      startAt: '2030-01-01T00:00:00.000Z',
      endAt: '2030-01-07T00:00:00.000Z',
      platforms,
    }, { dryRun: true });
  const payload = (index: number) => JSON.parse(openaiService.generateStructuredText.mock.calls[index][1]);
  return { controller, settingsRepository, generate, payload };
}

describe('Admin settings save to operation-plan generation', () => {
  it('applies the edited GET response after PUT to the actual generation prompt', async () => {
    const { controller, settingsRepository, generate, payload } = makeSaveAndGenerate();
    const response = await getCadence(controller);
    response.value.x = { cadence: '4 posts per week', citationWeight: 'high', notes: 'Threads count toward the total' };
    response.value.linkedin = { cadence: '2 posts per week', notes: 'Publish on Tuesdays and Thursdays' };
    response.value.mastodon = { cadence: '1 post per week', citationWeight: 'low' };

    expect(await controller.upsertSetting(CADENCE_KEY, { type: 'json', value: response.value })).toEqual({
      key: CADENCE_KEY,
      upserted: true,
    });
    expect(settingsRepository.set).toHaveBeenCalledWith(CADENCE_KEY, response.value, {
      type: 'json',
      description: undefined,
    });
    expect((await getCadence(controller)).value).toEqual(response.value);
    expect((await generate('task-1')).status).toBe('PREVIEW');

    expect(payload(0).platforms).toEqual(['x', 'linkedin', 'mastodon']);
    expect(payload(0).platformPlaybook).toEqual({
      x: response.value.x,
      linkedin: response.value.linkedin,
      mastodon: response.value.mastodon,
    });
  });

  it('reads subsequent saves without caching and restores defaults when an override is removed', async () => {
    const { controller, settingsRepository, generate, payload } = makeSaveAndGenerate({ x: { cadence: 'daily' } });
    await generate('task-1');
    expect(payload(0).platformPlaybook.x).toEqual({ cadence: 'daily' });

    await controller.upsertSetting(CADENCE_KEY, {
      type: 'json',
      value: { x: { cadence: '1 post per week', citationWeight: 'low', notes: 'Use a single case study' } },
    });
    await generate('task-2');
    expect(payload(1).platformPlaybook.x).toEqual({
      cadence: '1 post per week', citationWeight: 'low', notes: 'Use a single case study',
    });
    expect(payload(1).platformPlaybook.linkedin.cadence).toBe('3-4 posts per week');
    expect(payload(1).platformPlaybook.mastodon.cadence).toBe('2-3 posts per week');

    await controller.upsertSetting(CADENCE_KEY, { type: 'json', value: {} });
    await generate('task-3');
    expect(payload(2).platformPlaybook.x.cadence).toContain('1 post per weekday');
    expect(settingsRepository.getValue.mock.calls.filter(([key]) => key === CADENCE_KEY)).toHaveLength(3);
  });
});

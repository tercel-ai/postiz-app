import { describe, expect, it, vi } from 'vitest';
import { RedditTargetResolutionService } from '@gitroom/nestjs-libraries/engage/reddit-target-resolution.service';
import {
  readRedditTargetPending,
  REDDIT_TARGET_PENDING_KEY,
} from '@gitroom/nestjs-libraries/engage/reddit-pending-target';

import { redditFlairOptionsRevision } from '../reddit-channel-capability';
import { prepareRedditPlanEdit, restageRedditFlairAfterCatalogChange } from '../reddit-plan-readiness';

const ORG = 'org-1';

function parkedSettings(
  title = 'Shipping an MCP server',
  candidate: string | null = 'claudeai',
  pending = {}
) {
  return JSON.stringify({
    __type: 'reddit',
    [REDDIT_TARGET_PENDING_KEY]: {
      candidate,
      title,
      reason: 'egress-unavailable',
      since: '2026-09-21T00:00:00.000Z',
      ...pending,
    },
  });
}

/** A minimal in-memory stand-in for PrismaRepository<'post'>. */
function makePostStore(rows: any[], editableIntent?: Record<string, any>) {
  const store = new Map<string, any>(rows.map((r) => [r.id, { ...r }]));
  const matches = (row: any, where: any): boolean => {
    if (!row) return false;
    if (where.organizationId && row.organizationId !== where.organizationId) return false;
    if (where.id && row.id !== where.id) return false;
    if (where.OR && !where.OR.some((candidate: any) => matches(row, candidate))) return false;
    if (where.sendIntent && (row.sendIntentId !== editableIntent?.id ||
      editableIntent?.status !== where.sendIntent.status ||
      editableIntent?.action !== where.sendIntent.action ||
      (where.sendIntent.status === 'CANCELLED' && editableIntent?.context?.editableDraft !== true))) return false;
    if (where.group && row.group !== where.group) return false;
    if ('deletedAt' in where && where.deletedAt === null && row.deletedAt !== null) return false;
    if (where.providerIdentifier && row.providerIdentifier !== where.providerIdentifier)
      return false;
    if ('parentPostId' in where && row.parentPostId !== where.parentPostId) return false;
    if (where.state?.in && !where.state.in.includes(row.state)) return false;
    if (typeof where.state === 'string' && row.state !== where.state) return false;
    for (const field of ['claimedAt', 'sendIntentId', 'releaseId', 'releaseURL']) {
      if (field in where && row[field] !== where[field]) return false;
    }
    if (where.updatedAt && row.updatedAt.getTime() !== where.updatedAt.getTime()) return false;
    if ((typeof where.settings === 'string' || where.settings === null) && row.settings !== where.settings)
      return false;
    if (where.settings?.contains && !String(row.settings ?? '').includes(where.settings.contains))
      return false;
    return true;
  };
  const model = {
    post: {
      findMany: vi.fn(async ({ where, take, orderBy }: any) => {
        let found = [...store.values()].filter((r) => matches(r, where));
        // Honour orderBy so the ordering assertions test the SERVICE's query,
        // not this stub's insertion order — Prisma sorts, and a service that
        // forgot to ask for it would otherwise still look correct here.
        if (orderBy) {
          const sort = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((field) =>
            Object.entries(field)
          ) as [string, string][];
          found = found.sort((a, b) => {
            for (const [field, dir] of sort) {
              const cmp = a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0;
              if (cmp) return dir === 'desc' ? -cmp : cmp;
            }
            return 0;
          });
        }
        return (take ? found.slice(0, take) : found).map((row) => ({ ...row }));
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const row = [...store.values()].find((r) => matches(r, where));
        return row ? { ...row } : null;
      }),
      count: vi.fn(async ({ where }: any) =>
        [...store.values()].filter((r) => matches(r, where)).length
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const row = store.get(where.id);
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const found = [...store.values()].filter((r) => matches(r, where));
        found.forEach((row) => Object.assign(row, data,
          data.contentRevision ? { contentRevision: (row.contentRevision ?? 0) + data.contentRevision.increment } : {}));
        return { count: found.length };
      }),
    },
    sendIntent: {
      findFirst: vi.fn(async () => editableIntent ? { ...editableIntent } : null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (!editableIntent || editableIntent.id !== where.id || editableIntent.revision !== where.revision)
          return { count: 0 };
        editableIntent.contentRevision = data.contentRevision;
        editableIntent.revision += data.revision.increment;
        if (data.status) editableIntent.status = data.status;
        if (data.context) editableIntent.context = data.context;
        return { count: 1 };
      }),
    },
    sendExecution: { findMany: vi.fn(async () => []) },
    sendSegment: { findMany: vi.fn(async () => []) },
  };
  const transaction = {
    model: {
      $transaction: vi.fn(async (callback: (model: any) => Promise<void>) => {
        const before = new Map([...store].map(([id, row]) => [id, { ...row }]));
        try {
          await callback(model);
        } catch (error) {
          store.clear();
          for (const [id, row] of before) store.set(id, row);
          throw error;
        }
      }),
    },
  };
  const engage = { getRedditChannelCapability: vi.fn(async (..._args: any[]): Promise<Record<string, unknown>> => ({})) };
  const openai = { generateStructuredText: vi.fn(async (..._args: any[]): Promise<{ data: { option: number | null } }> => ({ data: { option: 0 } })) };
  const posts = { schedulePlanPosts: vi.fn(async () => {}), isControlled: vi.fn(async () => false) };
  const automatic = { owner: vi.fn(async () => 'automation-owner') };
  return {
    store, model, engage, openai, posts, automatic,
    service: new RedditTargetResolutionService(
      { model } as any, transaction as any, engage as any, openai as any, posts as any, automatic as any
    ),
  };
}

const anchor = (overrides: Record<string, unknown> = {}) => ({
  id: 'post-1',
  organizationId: ORG,
  providerIdentifier: 'reddit',
  parentPostId: null,
  group: 'plan-1:D01:reddit',
  content: 'Body of the post',
  settings: parkedSettings(),
  publishDate: new Date('2026-10-01T10:00:00.000Z'),
  deletedAt: null,
  updatedAt: new Date('2026-09-21T00:00:00.000Z'),
  state: 'DRAFT',
  operationPlanId: 'plan-1',
  projectId: 'project-1',
  sendIntentId: null,
  claimedAt: null,
  releaseId: null,
  releaseURL: null,
  ...overrides,
});

describe('listPending', () => {
  it('offers parked reddit roots, soonest first', async () => {
    const { service } = makePostStore([
      anchor({ id: 'later', publishDate: new Date('2026-10-02T10:00:00.000Z') }),
      anchor({ id: 'sooner', publishDate: new Date('2026-10-01T10:00:00.000Z') }),
    ]);
    const items = await service.listPending(ORG);
    expect(items.map((i) => i.postId)).toEqual(['sooner', 'later']);
    expect(items[0].pending.title).toBe('Shipping an MCP server');
  });

  it('never offers a thread part on its own — it shares the anchor\'s community', async () => {
    const { service } = makePostStore([
      anchor(),
      anchor({ id: 'part-2', parentPostId: 'post-1' }),
    ]);
    const items = await service.listPending(ORG);
    expect(items.map((i) => i.postId)).toEqual(['post-1']);
  });

  it('skips a row whose marker does not parse rather than offering a titleless post', async () => {
    const { service } = makePostStore([
      anchor({
        id: 'broken',
        settings: JSON.stringify({ [REDDIT_TARGET_PENDING_KEY]: { candidate: 'x' } }),
      }),
    ]);
    expect(await service.listPending(ORG)).toEqual([]);
  });

  it('is org-scoped', async () => {
    const { service } = makePostStore([anchor({ organizationId: 'other-org' })]);
    expect(await service.listPending(ORG)).toEqual([]);
  });
});

describe('resolve', () => {
  it('writes the community and clears the marker', async () => {
    const { store, service } = makePostStore([anchor()]);

    const result = await service.resolve(ORG, [
      { postId: 'post-1', subreddit: 'r/ClaudeAI' },
    ]);

    expect(result.resolved).toBe(1);
    const settings = JSON.parse(store.get('post-1').settings);
    // Normalized on the way in: the `r/` prefix and casing are stripped.
    expect(settings.subreddit[0].value.subreddit).toBe('claudeai');
    expect(settings[REDDIT_TARGET_PENDING_KEY]).toBeUndefined();
  });

  it('resolves the whole thread chain to one community, keeping each part\'s title', async () => {
    const { store, service } = makePostStore([
      anchor(),
      anchor({
        id: 'part-2',
        parentPostId: 'post-1',
        settings: parkedSettings('Follow-up detail'),
      }),
    ]);

    await service.resolve(ORG, [{ postId: 'post-1', subreddit: 'claudeai' }]);

    const part = JSON.parse(store.get('part-2').settings).subreddit[0].value;
    expect(part.subreddit).toBe('claudeai');
    expect(part.title).toBe('Follow-up detail');
  });

  it('rejects a subreddit name Reddit could not accept', async () => {
    const { store, service } = makePostStore([anchor()]);

    const result = await service.resolve(ORG, [
      { postId: 'post-1', subreddit: 'not a valid name!' },
    ]);

    expect(result.skipped).toBe(1);
    // Still parked — a rejected answer must not consume the post.
    expect(readRedditTargetPending(store.get('post-1').settings)).not.toBeNull();
  });

  it('skips a post that is no longer parked instead of overwriting it', async () => {
    const { store, service } = makePostStore([
      anchor({
        settings: JSON.stringify({
          __type: 'reddit',
          subreddit: [{ value: { subreddit: 'chosenbyahuman', title: 'T', type: 'self' } }],
        }),
      }),
    ]);

    const result = await service.resolve(ORG, [
      { postId: 'post-1', subreddit: 'somethingelse' },
    ]);

    expect(result.skipped).toBe(1);
    expect(JSON.parse(store.get('post-1').settings).subreddit[0].value.subreddit).toBe(
      'chosenbyahuman'
    );
  });

  it('skips a post belonging to another org', async () => {
    const { store, service } = makePostStore([anchor({ organizationId: 'other-org' })]);
    const result = await service.resolve(ORG, [
      { postId: 'post-1', subreddit: 'claudeai' },
    ]);
    expect(result.skipped).toBe(1);
    expect(readRedditTargetPending(store.get('post-1').settings)).not.toBeNull();
  });

  it('retires the whole chain when the extension found no usable community', async () => {
    const { store, service } = makePostStore([
      anchor(),
      anchor({ id: 'part-2', parentPostId: 'post-1' }),
    ]);

    const result = await service.resolve(ORG, [
      { postId: 'post-1', unresolvable: true },
    ]);

    expect(result.retired).toBe(1);
    expect(store.get('post-1').deletedAt).toBeInstanceOf(Date);
    expect(store.get('part-2').deletedAt).toBeInstanceOf(Date);
    // Marker cleared too, so an un-delete cannot put it back on the parked list.
    expect(readRedditTargetPending(store.get('post-1').settings)).toBeNull();
  });

  it('carries an observed flair requirement through to the settings', async () => {
    const { store, service } = makePostStore([anchor()]);

    await service.resolve(ORG, [
      {
        postId: 'post-1',
        subreddit: 'machinelearning',
        flairLabel: 'Research',
        flairRequired: true,
      },
    ]);

    const value = JSON.parse(store.get('post-1').settings).subreddit[0].value;
    expect(value.flairLabel).toBe('Research');
    expect(value.flairRequired).toBe(true);
    expect(value.is_flair_required).toBe(false);
  });

  it('one bad item does not cost the rest of the batch', async () => {
    const { store, service } = makePostStore([
      anchor(),
      anchor({ id: 'post-2', group: 'plan-1:D02:reddit' }),
    ]);

    const result = await service.resolve(ORG, [
      { postId: 'missing-post', subreddit: 'claudeai' },
      { postId: 'post-2', subreddit: 'claudeai' },
    ]);

    expect(result.skipped).toBe(1);
    expect(result.resolved).toBe(1);
    expect(readRedditTargetPending(store.get('post-2').settings)).toBeNull();
  });
});

describe('asynchronous flair selection', () => {
  const settings = () => parkedSettings('Shipping an MCP server', 'claudeai', {
    reason: 'flair-pending', selectFlair: true,
  });

  it('returns fresh cached options only for an already resolved community', async () => {
    const { service, engage } = makePostStore([
      anchor({ settings: settings() }),
      anchor({ id: 'other', group: 'plan-1:D02:reddit' }),
    ]);
    engage.getRedditChannelCapability.mockResolvedValue({
      flairs: [], flairsObservedAt: new Date().toISOString(),
    });
    const [fixed, proposed] = await service.listPending(ORG);
    expect(fixed.flairOptions).toEqual([]);
    expect(fixed.pendingRevision).toHaveLength(64);
    expect(proposed.flairOptions).toBeUndefined();
    expect(engage.getRedditChannelCapability).toHaveBeenCalledExactlyOnceWith(ORG, 'claudeai');
  });

  it('chooses a current label for the final subreddit and hands off only that root', async () => {
    const { service, openai, store, posts, automatic } = makePostStore([anchor({
      settings: parkedSettings('Shipping an MCP server', 'claudeai', {
        selectFlair: true, flairLabel: 'Discussion',
      }),
    })]);
    posts.isControlled.mockResolvedValue(true);
    openai.generateStructuredText.mockResolvedValue({ data: { option: 1 } });
    const [item] = await service.listPending(ORG);
    await expect(service.resolve(ORG, [{
      postId: item.postId, pendingRevision: item.pendingRevision, subreddit: 'selfhosted',
      flairOptions: ['Help', 'Release'],
    }])).resolves.toMatchObject({ resolved: 1 });
    expect(JSON.parse(openai.generateStructuredText.mock.calls[0][1])).toMatchObject({
      subreddit: 'selfhosted', options: [{ index: 0, label: 'Help' }, { index: 1, label: 'Release' }],
    });
    expect(JSON.parse(openai.generateStructuredText.mock.calls[0][1])).not.toHaveProperty('suggestedLabel');
    expect(JSON.parse(store.get(item.postId).settings).subreddit[0].value).toMatchObject({
      subreddit: 'selfhosted', flairLabel: 'Release',
    });
    expect(automatic.owner).toHaveBeenCalledExactlyOnceWith(ORG, 'project-1', 'POST');
    expect(posts.schedulePlanPosts).toHaveBeenCalledExactlyOnceWith(
      ORG, 'plan-1', 'project-1', undefined, undefined,
      { userId: 'automation-owner', origin: 'AUTOMATION' }, [item.postId], true
    );
  });

  it.each([null, 4])('keeps a required post in draft if the result has no offered option (%s)', async (option) => {
    const { service, openai, store, posts } = makePostStore([anchor({
      settings: settings(), state: 'QUEUE',
    })]);
    openai.generateStructuredText.mockResolvedValue({ data: { option } });
    const [item] = await service.listPending(ORG);
    await expect(service.resolve(ORG, [{
      postId: item.postId, pendingRevision: item.pendingRevision, subreddit: 'claudeai',
      flairOptions: ['News'], flairRequired: true,
    }])).resolves.toMatchObject({ resolved: 1 });
    const row = store.get(item.postId);
    expect(row.state).toBe('DRAFT');
    expect(row.deletedAt).toBeNull();
    expect(readRedditTargetPending(row.settings)).toBeNull();
    expect(JSON.parse(row.settings).subreddit[0].value).toMatchObject({
      subreddit: 'claudeai', flairRequired: true,
    });
    expect(JSON.parse(row.settings).subreddit[0].value.flairLabel).toBeUndefined();
    expect(JSON.parse(row.settings).subreddit[0].value.flairOptionsRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(posts.schedulePlanPosts).not.toHaveBeenCalled();
  });

  it('preserves the legacy cache fence when a user edits or retargets the post', () => {
    const previous = JSON.stringify({ redditLegacyFlairResolution: true,
      subreddit: [{ value: { subreddit: 'old', title: 'Old', type: 'self' } }] });
    for (const subreddit of ['old', 'new']) {
      const next = JSON.stringify({ subreddit: [{ value: { subreddit, title: 'New', type: 'self' } }] });
      expect(JSON.parse(prepareRedditPlanEdit(previous, next))).toMatchObject({ redditLegacyFlairResolution: true });
    }
  });

  it.each([['new-template', false], ['old-template', true]] as const)(
    'preserves a new explicit template on retarget and rejects a carried ID (%s)',
    (templateId, shouldRestage) => {
      const settingsFor = (subreddit: string, id: string) => JSON.stringify({
        redditPlanSchedulePending: true,
        subreddit: [{ value: { subreddit, title: 'A saved title', type: 'self',
          is_flair_required: false, flair: { id, name: 'Manual Choice' } } }],
      });
      const edited = JSON.parse(prepareRedditPlanEdit(settingsFor('oldsite', 'old-template'), settingsFor('newsite', templateId)));
      expect(edited).not.toHaveProperty('redditPlanSchedulePending');
      if (shouldRestage) {
        expect(edited.redditTargetPending).toMatchObject({ candidate: 'newsite' });
        expect(edited.subreddit[0].value.flair).toBeUndefined();
      } else {
        expect(edited).not.toHaveProperty('redditTargetPending');
        expect(edited.subreddit[0].value.flair.id).toBe(templateId);
      }
    }
  );

  it('preserves a manually selected template even on a fresh poll of an old pending marker', async () => {
    const settingsWithSelection = {
      ...JSON.parse(settings()),
      subreddit: [{ value: { subreddit: 'claudeai', title: 'Saved title', type: 'self',
        flairRequired: true, flair: { id: 'manual-choice', name: 'Manual Choice' } } }],
    };
    const { service, openai, store, posts } = makePostStore([anchor({ settings: JSON.stringify(settingsWithSelection) })]);
    const [item] = await service.listPending(ORG);
    await expect(service.resolve(ORG, [{
      postId: item.postId, pendingRevision: item.pendingRevision, subreddit: 'claudeai',
      flairOptions: ['New automatic option'], flairRequired: true,
    }])).resolves.toMatchObject({ resolved: 1 });
    const written = JSON.parse(store.get(item.postId).settings);
    expect(written.subreddit).toEqual(settingsWithSelection.subreddit);
    expect(written.redditTargetPending).toBeUndefined();
    expect(openai.generateStructuredText).not.toHaveBeenCalled();
    expect(posts.schedulePlanPosts).not.toHaveBeenCalled();
  });

  it('resolves a proven autonomous claim without erasing its original pacing timestamp', async () => {
    const claimedAt = new Date('2026-09-30T10:00:00Z');
    const currentSettings = JSON.stringify({ ...JSON.parse(settings()), redditLegacyFlairResolution: true,
      subreddit: [{ value: { subreddit: 'claudeai', title: 'Saved title', type: 'self' } }] });
    const { service, store } = makePostStore([anchor({ settings: currentSettings, state: 'QUEUE', claimedAt })]);
    const [item] = await service.listPending(ORG);
    expect(item).toBeDefined();
    await expect(service.resolve(ORG, [{ postId: item.postId, pendingRevision: item.pendingRevision,
      subreddit: 'claudeai', flairOptions: ['Discussion'], flairRequired: true }])).resolves.toMatchObject({ resolved: 1 });
    expect(store.get(item.postId)).toMatchObject({ state: 'QUEUE', claimedAt,
      publishDate: new Date('2026-10-01T10:00:00Z') });
  });

  it('keeps an autonomous queued root and schedule after optional Flair is observed', async () => {
    const currentSettings = JSON.stringify({ ...JSON.parse(settings()), redditLegacyFlairResolution: true,
      subreddit: [{ value: { subreddit: 'claudeai', title: 'Saved title', type: 'self' } }] });
    const { service, store, openai, posts } = makePostStore([anchor({ settings: currentSettings, state: 'QUEUE' })]);
    openai.generateStructuredText.mockResolvedValue({ data: { option: null } });
    const [item] = await service.listPending(ORG);
    await expect(service.resolve(ORG, [{ postId: item.postId, pendingRevision: item.pendingRevision,
      subreddit: 'claudeai', flairOptions: ['Discussion'], flairRequired: false }]))
      .resolves.toMatchObject({ resolved: 1 });
    const row = store.get(item.postId);
    expect(row).toMatchObject({ state: 'QUEUE', publishDate: new Date('2026-10-01T10:00:00.000Z') });
    expect(JSON.parse(row.settings)).toMatchObject({ redditLegacyFlairResolution: true });
    expect(readRedditTargetPending(row.settings)).toBeNull();
    expect(posts.schedulePlanPosts).not.toHaveBeenCalled();
  });

  it.each([true, false])('resolves an untouched controlled queued intent and preserves its schedule when selected=%s', async selected => {
    const intent = { id: 'intent', organizationId: ORG, rootPostId: 'post-1', projectId: 'project-1',
      platform: 'reddit', action: 'POST', activeExecutionId: null, hasConfirmedSegments: false,
      status: 'QUEUED', context: {}, revision: 1, routeRevision: 2, contentRevision: 3 };
    const currentSettings = JSON.stringify({ ...JSON.parse(settings()), redditLegacyFlairResolution: true,
      subreddit: [{ value: { subreddit: 'claudeai', title: 'Saved title', type: 'self' } }] });
    const { service, store, openai, posts } = makePostStore([anchor({
      settings: currentSettings, state: 'QUEUE', sendIntentId: intent.id,
      routeRevision: 2, contentRevision: 3, publishMethod: 'EXTENSION',
    })], intent);
    openai.generateStructuredText.mockResolvedValue({ data: { option: selected ? 0 : null } });
    const [item] = await service.listPending(ORG);
    await expect(service.resolve(ORG, [{ postId: item.postId, pendingRevision: item.pendingRevision,
      subreddit: 'claudeai', flairOptions: ['Discussion'], flairRequired: true }]))
      .resolves.toMatchObject({ resolved: 1 });
    expect(store.get(item.postId)).toMatchObject({ state: selected ? 'QUEUE' : 'DRAFT', contentRevision: 4,
      publishDate: new Date('2026-10-01T10:00:00.000Z') });
    expect(intent).toMatchObject({ status: selected ? 'QUEUED' : 'CANCELLED', contentRevision: 4,
      ...(selected ? {} : { context: { editableDraft: true } }) });
    expect(posts.schedulePlanPosts).not.toHaveBeenCalled();
  });

  it('updates the existing dormant draft intent revision and does not automatically queue an edited Reddit draft', async () => {
    const intent = { id: 'intent', organizationId: ORG, rootPostId: 'post-1', projectId: 'project-1',
      platform: 'reddit', action: 'POST', activeExecutionId: null, hasConfirmedSegments: false,
      status: 'CANCELLED', context: { editableDraft: true }, revision: 1, routeRevision: 2, contentRevision: 3 };
    const { service, store, posts } = makePostStore([anchor({
      settings: settings(), sendIntentId: intent.id, routeRevision: 2, contentRevision: 3, publishMethod: 'EXTENSION',
    })], intent);
    const [item] = await service.listPending(ORG);
    expect(item?.postId).toBe('post-1');
    await expect(service.resolve(ORG, [{
      postId: item.postId, pendingRevision: item.pendingRevision, subreddit: 'claudeai',
      flairOptions: ['Discussion'], flairRequired: true,
    }])).resolves.toMatchObject({ resolved: 1 });
    expect(store.get(item.postId)).toMatchObject({ sendIntentId: intent.id, state: 'DRAFT', routeRevision: 2, contentRevision: 4 });
    expect(intent).toMatchObject({ status: 'CANCELLED', activeExecutionId: null, routeRevision: 2, contentRevision: 4 });
    expect(posts.schedulePlanPosts).not.toHaveBeenCalled();
  });

  it('leaves the original intent intact if late evidence arrives while resolving an edited draft', async () => {
    const intent = { id: 'intent', organizationId: ORG, rootPostId: 'post-1', projectId: 'project-1',
      platform: 'reddit', action: 'POST', activeExecutionId: null, hasConfirmedSegments: false,
      status: 'CANCELLED', context: { editableDraft: true }, revision: 1, routeRevision: 2, contentRevision: 3 };
    const { service, store, openai, posts } = makePostStore([anchor({
      settings: settings(), sendIntentId: intent.id, routeRevision: 2, contentRevision: 3, publishMethod: 'EXTENSION',
    })], intent);
    const [item] = await service.listPending(ORG);
    openai.generateStructuredText.mockImplementationOnce(async () => {
      intent.hasConfirmedSegments = true;
      return { data: { option: 0 } };
    });
    await expect(service.resolve(ORG, [{
      postId: item.postId, pendingRevision: item.pendingRevision, subreddit: 'claudeai',
      flairOptions: ['Discussion'], flairRequired: true,
    }])).resolves.toMatchObject({ skipped: 1 });
    expect(store.get(item.postId)).toMatchObject({ settings: settings(), contentRevision: 3 });
    expect(intent).toMatchObject({ contentRevision: 3, revision: 1, hasConfirmedSegments: true });
    expect(posts.schedulePlanPosts).not.toHaveBeenCalled();
  });

  it('tries once per effective catalog and schedules only after a changed catalog yields a label', async () => {
    const { service, openai, store, posts } = makePostStore([anchor({ settings: settings() })]);
    openai.generateStructuredText
      .mockResolvedValueOnce({ data: { option: null } })
      .mockResolvedValueOnce({ data: { option: null } })
      .mockResolvedValueOnce({ data: { option: 1 } });

    async function resolveFrom(labels: string[], flairRequired = true) {
      const [item] = await service.listPending(ORG);
      await expect(service.resolve(ORG, [{
        postId: item.postId, pendingRevision: item.pendingRevision, subreddit: 'claudeai',
        flairOptions: labels, flairRequired,
      }])).resolves.toMatchObject({ resolved: 1 });
      return store.get(item.postId);
    }
    const restage = (saved: string, labels: string[]) => restageRedditFlairAfterCatalogChange(
      saved, 'claudeai', redditFlairOptionsRevision(labels)!, new Date().toISOString()
    );

    const row = await resolveFrom(['News']);
    expect(restage(row.settings, ['News'])).toBeUndefined();
    row.settings = restage(row.settings, ['News', 'Release']);
    expect(row.settings).toBeDefined();
    await resolveFrom(['News', 'Release'], false);
    expect(row.state).toBe('DRAFT');
    expect(await service.listPending(ORG)).toEqual([]);
    expect(restage(row.settings, ['Release', 'News'])).toBeUndefined();
    expect(posts.schedulePlanPosts).not.toHaveBeenCalled();

    row.settings = restage(row.settings, ['News', 'Discussion']);
    await resolveFrom(['News', 'Discussion']);
    expect(JSON.parse(row.settings).subreddit[0].value.flairLabel).toBe('Discussion');
    expect(restage(row.settings, ['Other'])).toBeUndefined();
    expect(openai.generateStructuredText).toHaveBeenCalledTimes(3);
    expect(posts.schedulePlanPosts).toHaveBeenCalledExactlyOnceWith(
      ORG, 'plan-1', 'project-1', undefined, undefined, undefined, [row.id], true
    );
  });

  it('keeps a draft pending if another catalog is reported while selection is in flight', async () => {
    const { service, openai, engage, store, posts } = makePostStore([anchor({ settings: settings() })]);
    const catalog = (...labels: string[]) => ({
      flairs: labels.map(label => ({ label })), flairsObservedAt: new Date().toISOString(),
    });
    engage.getRedditChannelCapability.mockResolvedValue(catalog('News'));
    openai.generateStructuredText.mockImplementationOnce(async () => {
      engage.getRedditChannelCapability.mockResolvedValue(catalog('News', 'Discussion'));
      return { data: { option: null } };
    }).mockResolvedValueOnce({ data: { option: 1 } });
    const [item] = await service.listPending(ORG);
    const oldSnapshot = { postId: item.postId, pendingRevision: item.pendingRevision, subreddit: 'claudeai',
      flairOptions: ['News'], flairRequired: true };
    await expect(service.resolve(ORG, [oldSnapshot])).resolves.toMatchObject({ skipped: 1 });
    expect(posts.schedulePlanPosts).not.toHaveBeenCalled();
    const [retry] = await service.listPending(ORG);
    await expect(service.resolve(ORG, [{ ...oldSnapshot, pendingRevision: retry.pendingRevision }]))
      .resolves.toMatchObject({ resolved: 1 });
    expect(JSON.parse(store.get(item.postId).settings).subreddit[0].value.flairLabel).toBe('Discussion');
  });

  it('records a durable root-only schedule handoff when a resolved draft hits a temporary admission failure', async () => {
    const { service, store, posts } = makePostStore([
      anchor({ settings: settings() }),
      anchor({ id: 'part-2', parentPostId: 'post-1', settings: settings() }),
    ]);
    posts.schedulePlanPosts.mockRejectedValueOnce(new Error('project validation temporarily unavailable'));
    const [item] = await service.listPending(ORG);
    await expect(service.resolve(ORG, [{
      postId: item.postId, pendingRevision: item.pendingRevision, subreddit: 'claudeai',
      flairOptions: ['Discussion'], flairRequired: true,
    }])).resolves.toMatchObject({ resolved: 1 });
    const root = JSON.parse(store.get(item.postId).settings);
    expect(root.redditPlanSchedulePending).toBe(true);
    expect(root.redditTargetPending).toBeUndefined();
    expect(root.subreddit[0].value.flairLabel).toBe('Discussion');
    expect(JSON.parse(store.get('part-2').settings).redditPlanSchedulePending).toBeUndefined();
  });

  it('lets an optional post proceed if the current Flair list cannot be read', async () => {
    const { service, openai, store, posts } = makePostStore([anchor({ settings: settings() })]);
    const [item] = await service.listPending(ORG);
    await expect(service.resolve(ORG, [{
      postId: item.postId, pendingRevision: item.pendingRevision, subreddit: 'claudeai',
      flairOptions: null, flairRequired: false,
    }])).resolves.toMatchObject({ resolved: 1 });
    expect(JSON.parse(store.get(item.postId).settings).subreddit[0].value.flairLabel).toBeUndefined();
    expect(openai.generateStructuredText).not.toHaveBeenCalled();
    expect(posts.schedulePlanPosts).toHaveBeenCalledOnce();
  });

  it.each(['unknown rule', 'required with an unreadable list'])(
    'retains and rotates a draft with an unresolved Flair observation (%s)',
    async (condition) => {
      const { service, store, posts, engage } = makePostStore([
        anchor({ settings: parkedSettings('release', 'claudeai', { selectFlair: true, flairLabel: 'Help' }), state: 'QUEUE' }),
        anchor({ id: 'post-2', group: 'plan-1:D02:reddit', settings: settings() }),
      ]);
      // A fresh catalog stamp alone does not prove that flair is optional.
      engage.getRedditChannelCapability.mockResolvedValue({ observedAt: new Date().toISOString() });
      const [item] = await service.listPending(ORG);
      await expect(service.resolve(ORG, [{
        postId: item.postId, pendingRevision: item.pendingRevision, subreddit: 'selfhosted',
        flairOptions: null, ...(condition.startsWith('required') ? { flairRequired: true } : {}),
      }])).resolves.toMatchObject({ skipped: 1 });
      expect(store.get(item.postId).state).toBe('DRAFT');
      const pending = readRedditTargetPending(store.get(item.postId).settings);
      expect(pending).toMatchObject({ candidate: 'selfhosted', reason: 'flair-pending' });
      expect(pending?.flairLabel).toBeUndefined();
      expect((await service.listPending(ORG, 1))[0].postId).toBe('post-2');
      expect(posts.schedulePlanPosts).not.toHaveBeenCalled();
    }
  );

  it('skips a legacy response and a changed destination for a newly staged post', async () => {
    const { service, openai } = makePostStore([anchor({ settings: settings() })]);
    const [item] = await service.listPending(ORG);
    await expect(service.resolve(ORG, [{
      postId: item.postId, subreddit: 'claudeai', flairLabel: 'Discussion',
    }, {
      postId: item.postId, pendingRevision: item.pendingRevision, subreddit: 'selfhosted',
      flairOptions: ['News'],
    }])).resolves.toMatchObject({ skipped: 2 });
    expect(openai.generateStructuredText).not.toHaveBeenCalled();
  });

  it('preserves a manually saved subreddit even when an older editor left its marker', async () => {
    const saved = JSON.stringify({
      ...JSON.parse(settings()),
      subreddit: [{ value: { subreddit: 'r/selfhosted', flairLabel: 'News' } }],
    });
    const { service, openai, store, posts } = makePostStore([anchor({ settings: saved })]);
    const [item] = await service.listPending(ORG);
    await expect(service.resolve(ORG, [{
      postId: item.postId, pendingRevision: item.pendingRevision, subreddit: 'claudeai',
      flairOptions: ['Discussion'],
    }])).resolves.toMatchObject({ skipped: 1 });
    expect(store.get(item.postId).settings).toBe(saved);
    expect(openai.generateStructuredText).not.toHaveBeenCalled();
    expect(posts.schedulePlanPosts).not.toHaveBeenCalled();
  });

  it('resolves a fixed draft when its saved subreddit matches after normalization', async () => {
    const saved = JSON.stringify({
      ...JSON.parse(settings()),
      subreddit: [{ value: { subreddit: ' /r/ClaudeAI/ ' } }],
    });
    const { service, store } = makePostStore([anchor({ settings: saved })]);
    const [item] = await service.listPending(ORG);
    await expect(service.resolve(ORG, [{
      postId: item.postId, pendingRevision: item.pendingRevision, subreddit: 'claudeai',
      flairOptions: ['Discussion'],
    }])).resolves.toMatchObject({ resolved: 1 });
    expect(JSON.parse(store.get(item.postId).settings).subreddit[0].value).toMatchObject({
      subreddit: 'claudeai', flairLabel: 'Discussion',
    });
  });

  it('preserves the title saved before a fresh poll and advances the content revision', async () => {
    const initial = JSON.parse(settings());
    initial.subreddit = [{ value: { subreddit: 'claudeai', title: 'Editor title', type: 'self' } }];
    const { service, openai, model, store } = makePostStore([anchor({ settings: JSON.stringify(initial) })]);
    const [item] = await service.listPending(ORG);
    await service.resolve(ORG, [{
      postId: item.postId, pendingRevision: item.pendingRevision, subreddit: 'claudeai',
      flairOptions: ['Discussion'], flairRequired: true,
    }]);
    expect(JSON.parse(openai.generateStructuredText.mock.calls[0][1])).toMatchObject({ title: 'Editor title' });
    expect(JSON.parse(store.get(item.postId).settings).subreddit[0].value.title).toBe('Editor title');
    expect(model.post.updateMany.mock.calls[0][0].data).toHaveProperty('contentRevision', { increment: 1 });
  });

  it('rotates a required draft after a temporary model failure so it can retry', async () => {
    const { service, openai, posts, store } = makePostStore([anchor({ settings: settings() })]);
    openai.generateStructuredText.mockRejectedValueOnce(new Error('temporary timeout'));
    const [item] = await service.listPending(ORG);
    const observation = { postId: item.postId, pendingRevision: item.pendingRevision, subreddit: 'claudeai', flairOptions: ['Discussion'], flairRequired: true };
    await expect(service.resolve(ORG, [observation])).resolves.toMatchObject({ skipped: 1 });
    expect(posts.schedulePlanPosts).not.toHaveBeenCalled();
    const [retry] = await service.listPending(ORG);
    await expect(service.resolve(ORG, [{ ...observation, pendingRevision: retry.pendingRevision }])).resolves.toMatchObject({ resolved: 1 });
    expect(JSON.parse(store.get(item.postId).settings).subreddit[0].value.flairLabel).toBe('Discussion');
  });

  it('rolls back the entire thread when an edit wins the race against selection', async () => {
    const { service, openai, store, posts } = makePostStore([
      anchor({ settings: settings() }),
      anchor({ id: 'post-2', parentPostId: 'post-1', settings: settings() }),
    ]);
    const [item] = await service.listPending(ORG);
    openai.generateStructuredText.mockImplementationOnce(async () => {
      store.get('post-2').updatedAt = new Date('2026-09-22T00:00:00.000Z');
      store.get('post-2').settings = '{"edited":true}';
      return { data: { option: 0 } };
    });
    await expect(service.resolve(ORG, [{
      postId: item.postId, pendingRevision: item.pendingRevision, subreddit: 'claudeai',
      flairOptions: ['Discussion'],
    }])).resolves.toMatchObject({ skipped: 1 });
    expect(readRedditTargetPending(store.get('post-1').settings)).not.toBeNull();
    expect(store.get('post-2').settings).toBe('{"edited":true}');
    expect(posts.schedulePlanPosts).not.toHaveBeenCalled();
  });
});

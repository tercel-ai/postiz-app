import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedditTargetResolutionService } from '@gitroom/nestjs-libraries/engage/reddit-target-resolution.service';
import {
  readRedditTargetPending,
  REDDIT_TARGET_PENDING_KEY,
} from '@gitroom/nestjs-libraries/engage/reddit-pending-target';

const ORG = 'org-1';

function parkedSettings(title = 'Shipping an MCP server', candidate: string | null = 'claudeai') {
  return JSON.stringify({
    __type: 'reddit',
    [REDDIT_TARGET_PENDING_KEY]: {
      candidate,
      title,
      reason: 'egress-unavailable',
      since: '2026-09-21T00:00:00.000Z',
    },
  });
}

/** A minimal in-memory stand-in for PrismaRepository<'post'>. */
function makePostStore(rows: any[]) {
  const store = new Map<string, any>(rows.map((r) => [r.id, { ...r }]));
  const matches = (row: any, where: any): boolean => {
    if (!row) return false;
    if (where.organizationId && row.organizationId !== where.organizationId) return false;
    if (where.id && row.id !== where.id) return false;
    if (where.group && row.group !== where.group) return false;
    if ('deletedAt' in where && where.deletedAt === null && row.deletedAt !== null) return false;
    if (where.providerIdentifier && row.providerIdentifier !== where.providerIdentifier)
      return false;
    if ('parentPostId' in where && row.parentPostId !== where.parentPostId) return false;
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
          const [[field, dir]] = Object.entries(orderBy) as [[string, string]];
          found = found.sort((a, b) => {
            const av = a[field];
            const bv = b[field];
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return dir === 'desc' ? -cmp : cmp;
          });
        }
        return take ? found.slice(0, take) : found;
      }),
      findFirst: vi.fn(async ({ where }: any) =>
        [...store.values()].find((r) => matches(r, where)) ?? null
      ),
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
        found.forEach((r) => Object.assign(r, data));
        return { count: found.length };
      }),
    },
  };
  return { store, repo: { model } as any };
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
  ...overrides,
});

describe('listPending', () => {
  it('offers parked reddit roots, soonest first', async () => {
    const { repo } = makePostStore([
      anchor({ id: 'later', publishDate: new Date('2026-10-02T10:00:00.000Z') }),
      anchor({ id: 'sooner', publishDate: new Date('2026-10-01T10:00:00.000Z') }),
    ]);
    const service = new RedditTargetResolutionService(repo);
    const items = await service.listPending(ORG);
    expect(items.map((i) => i.postId)).toEqual(['sooner', 'later']);
    expect(items[0].pending.title).toBe('Shipping an MCP server');
  });

  it('never offers a thread part on its own — it shares the anchor\'s community', async () => {
    const { repo } = makePostStore([
      anchor(),
      anchor({ id: 'part-2', parentPostId: 'post-1' }),
    ]);
    const service = new RedditTargetResolutionService(repo);
    const items = await service.listPending(ORG);
    expect(items.map((i) => i.postId)).toEqual(['post-1']);
  });

  it('skips a row whose marker does not parse rather than offering a titleless post', async () => {
    const { repo } = makePostStore([
      anchor({
        id: 'broken',
        settings: JSON.stringify({ [REDDIT_TARGET_PENDING_KEY]: { candidate: 'x' } }),
      }),
    ]);
    const service = new RedditTargetResolutionService(repo);
    expect(await service.listPending(ORG)).toEqual([]);
  });

  it('is org-scoped', async () => {
    const { repo } = makePostStore([anchor({ organizationId: 'other-org' })]);
    const service = new RedditTargetResolutionService(repo);
    expect(await service.listPending(ORG)).toEqual([]);
  });
});

describe('resolve', () => {
  it('writes the community and clears the marker', async () => {
    const { store, repo } = makePostStore([anchor()]);
    const service = new RedditTargetResolutionService(repo);

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
    const { store, repo } = makePostStore([
      anchor(),
      anchor({
        id: 'part-2',
        parentPostId: 'post-1',
        settings: parkedSettings('Follow-up detail'),
      }),
    ]);
    const service = new RedditTargetResolutionService(repo);

    await service.resolve(ORG, [{ postId: 'post-1', subreddit: 'claudeai' }]);

    const part = JSON.parse(store.get('part-2').settings).subreddit[0].value;
    expect(part.subreddit).toBe('claudeai');
    expect(part.title).toBe('Follow-up detail');
  });

  it('rejects a subreddit name Reddit could not accept', async () => {
    const { store, repo } = makePostStore([anchor()]);
    const service = new RedditTargetResolutionService(repo);

    const result = await service.resolve(ORG, [
      { postId: 'post-1', subreddit: 'not a valid name!' },
    ]);

    expect(result.skipped).toBe(1);
    // Still parked — a rejected answer must not consume the post.
    expect(readRedditTargetPending(store.get('post-1').settings)).not.toBeNull();
  });

  it('skips a post that is no longer parked instead of overwriting it', async () => {
    const { store, repo } = makePostStore([
      anchor({
        settings: JSON.stringify({
          __type: 'reddit',
          subreddit: [{ value: { subreddit: 'chosenbyahuman', title: 'T', type: 'self' } }],
        }),
      }),
    ]);
    const service = new RedditTargetResolutionService(repo);

    const result = await service.resolve(ORG, [
      { postId: 'post-1', subreddit: 'somethingelse' },
    ]);

    expect(result.skipped).toBe(1);
    expect(JSON.parse(store.get('post-1').settings).subreddit[0].value.subreddit).toBe(
      'chosenbyahuman'
    );
  });

  it('skips a post belonging to another org', async () => {
    const { store, repo } = makePostStore([anchor({ organizationId: 'other-org' })]);
    const service = new RedditTargetResolutionService(repo);
    const result = await service.resolve(ORG, [
      { postId: 'post-1', subreddit: 'claudeai' },
    ]);
    expect(result.skipped).toBe(1);
    expect(readRedditTargetPending(store.get('post-1').settings)).not.toBeNull();
  });

  it('retires the whole chain when the extension found no usable community', async () => {
    const { store, repo } = makePostStore([
      anchor(),
      anchor({ id: 'part-2', parentPostId: 'post-1' }),
    ]);
    const service = new RedditTargetResolutionService(repo);

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
    const { store, repo } = makePostStore([anchor()]);
    const service = new RedditTargetResolutionService(repo);

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
    const { store, repo } = makePostStore([
      anchor(),
      anchor({ id: 'post-2', group: 'plan-1:D02:reddit' }),
    ]);
    const service = new RedditTargetResolutionService(repo);

    const result = await service.resolve(ORG, [
      { postId: 'missing-post', subreddit: 'claudeai' },
      { postId: 'post-2', subreddit: 'claudeai' },
    ]);

    expect(result.skipped).toBe(1);
    expect(result.resolved).toBe(1);
    expect(readRedditTargetPending(store.get('post-2').settings)).toBeNull();
  });
});

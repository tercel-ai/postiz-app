/**
 * The extension publishes with the BROWSER's platform session, not an OAuth
 * token, so an extension-routed Post can go out with `integrationId` null and
 * no read path can then say which account posted it. These tests pin the fill:
 * on the publish-on-success callback, resolve the account the session report
 * says this browser is signed into for the post's platform, and stamp it —
 * without ever overwriting an account the user chose when scheduling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostsService } from '../posts.service';

function makeService(post: any, resolved: string | null = 'int_session') {
  const repo: any = {
    getPostById: vi.fn().mockResolvedValue(post),
    updatePost: vi.fn().mockResolvedValue({}),
    changeState: vi.fn().mockResolvedValue({}),
    publishExtensionChainChildren: vi.fn().mockResolvedValue({ count: 0 }),
    publishExtensionChainNodes: vi.fn().mockResolvedValue({ count: 0 }),
    getExtensionPublishChainNodes: vi.fn().mockResolvedValue([]),
    attributeExtensionPublisher: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const integrationService: any = {
    resolveExtensionPublisherId: vi.fn().mockResolvedValue(resolved),
  };
  const svc = new PostsService(
    repo,
    {} as any, // _integrationManager
    integrationService,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  return { svc, repo, integrationService };
}

describe('markPublishedFromExtension — publishing-account attribution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stamps the browser-session account on a post that has none', async () => {
    const { svc, repo, integrationService } = makeService({
      id: 'p1',
      state: 'QUEUE',
      group: 'g1',
      parentPostId: null,
      integrationId: null,
      providerIdentifier: 'reddit',
    });

    const r = await svc.markPublishedFromExtension(
      'org-1',
      'p1',
      'https://reddit.com/r/x/comments/1',
      't3_1'
    );

    expect(r).toEqual({ ok: true });
    expect(integrationService.resolveExtensionPublisherId).toHaveBeenCalledWith(
      'org-1',
      'reddit'
    );
    // Scoped to the GROUP, so a thread published as one extension task has its
    // follow-up segments attributed too — they went out as the same session.
    expect(repo.attributeExtensionPublisher).toHaveBeenCalledWith(
      'org-1',
      'g1',
      'reddit',
      'int_session'
    );
  });

  it('never overrides the account the user picked when scheduling', async () => {
    const { svc, repo, integrationService } = makeService({
      id: 'p1',
      state: 'QUEUE',
      group: 'g1',
      parentPostId: null,
      integrationId: 'int_chosen',
      providerIdentifier: 'reddit',
    });

    await svc.markPublishedFromExtension('org-1', 'p1', 'https://r/1', 't3_1');

    expect(integrationService.resolveExtensionPublisherId).not.toHaveBeenCalled();
    expect(repo.attributeExtensionPublisher).not.toHaveBeenCalled();
  });

  it('writes nothing when the session names no account (unattributed beats guessed)', async () => {
    const { svc, repo } = makeService(
      {
        id: 'p1',
        state: 'QUEUE',
        group: 'g1',
        parentPostId: null,
        integrationId: null,
        providerIdentifier: 'quora',
      },
      null
    );

    const r = await svc.markPublishedFromExtension('org-1', 'p1');

    expect(r).toEqual({ ok: true });
    expect(repo.attributeExtensionPublisher).not.toHaveBeenCalled();
  });

  it('skips a post with no platform on it — there is nothing to resolve against', async () => {
    const { svc, integrationService } = makeService({
      id: 'p1',
      state: 'QUEUE',
      group: 'g1',
      parentPostId: null,
      integrationId: null,
      providerIdentifier: null,
    });

    await svc.markPublishedFromExtension('org-1', 'p1', 'https://x.com/u/1');

    expect(integrationService.resolveExtensionPublisherId).not.toHaveBeenCalled();
  });

  it('keeps the post PUBLISHED when attribution blows up — the send already happened', async () => {
    const { svc, repo, integrationService } = makeService({
      id: 'p1',
      state: 'QUEUE',
      group: 'g1',
      parentPostId: null,
      integrationId: null,
      providerIdentifier: 'reddit',
    });
    integrationService.resolveExtensionPublisherId.mockRejectedValue(
      new Error('db down')
    );

    const r = await svc.markPublishedFromExtension('org-1', 'p1', 'https://r/1');

    // A failed callback would leave the row QUEUE and get it published twice —
    // far worse than a PUBLISHED row with no account on it.
    expect(r).toEqual({ ok: true });
    expect(repo.updatePost).toHaveBeenCalled();
    expect(repo.attributeExtensionPublisher).not.toHaveBeenCalled();
  });

  it('does not attribute a repeat callback for an already-published post', async () => {
    const { svc, integrationService } = makeService({
      id: 'p1',
      state: 'PUBLISHED',
      group: 'g1',
      integrationId: null,
      providerIdentifier: 'reddit',
    });

    const r = await svc.markPublishedFromExtension('org-1', 'p1', 'https://r/1');

    expect(r).toEqual({ ok: true, alreadyPublished: true });
    expect(integrationService.resolveExtensionPublisherId).not.toHaveBeenCalled();
  });
});

// The stamp's blast radius. A `group` is one channel's chain, but a recurring
// post's per-cycle clones share their TEMPLATE's group — so an unqualified
// group write could reach rows this callback never published.
describe('attributeExtensionPublisher — what the stamp may touch', () => {
  it('only writes PUBLISHED, unattributed, same-platform, non-recurring rows of the group', async () => {
    const { PostsRepository } = await import('../posts.repository');
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const repo = new PostsRepository(
      { model: { post: { updateMany } } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    await repo.attributeExtensionPublisher('org-1', 'g1', 'reddit', 'int_live');

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        group: 'g1',
        deletedAt: null,
        // Never overwrite an account the user chose when scheduling.
        integrationId: null,
        // A resolution for one platform can't land on a row of another.
        providerIdentifier: 'reddit',
        // Only rows that were actually sent — never a QUEUE row this callback
        // did not publish.
        state: 'PUBLISHED',
        // Never the permanent QUEUE template of a recurring post: a clone
        // shares its group, and stamping the template would change how every
        // future cycle routes.
        intervalInDays: null,
      },
      data: { integrationId: 'int_live' },
    });
  });
});

// Regression: the stamp runs after the thread chain is settled, because it only
// touches PUBLISHED rows. Attributing before the children flip would skip them
// and leave the chain half-attributed.
describe('attribution ordering vs thread settling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('settles the chain children before stamping the account', async () => {
    const order: string[] = [];
    const { svc, repo } = makeService({
      id: 'anchor',
      state: 'QUEUE',
      group: 'g1',
      parentPostId: null,
      integrationId: null,
      providerIdentifier: 'reddit',
    });
    repo.publishExtensionChainChildren.mockImplementation(async () => {
      order.push('settle-children');
      return { count: 1 };
    });
    repo.attributeExtensionPublisher.mockImplementation(async () => {
      order.push('attribute');
      return { count: 2 };
    });

    await svc.markPublishedFromExtension('org-1', 'anchor', 'https://r/1');

    expect(order).toEqual(['settle-children', 'attribute']);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { EngageService } from '../engage.service';

/**
 * The reply URL must be saved synchronously (it only needs the parseable id); the
 * slow author/avatar lookup is resolved out of band so it never blocks the save.
 * These tests pin that contract on the X path (postsService.fetchEngageXAuthor is
 * injectable, so no module mock is needed).
 */
describe('submitManualReplyUrl — URL saved first, author enriched in background', () => {
  const org = { id: 'org-1' } as any;
  const url = 'https://x.com/benppoulton/status/123';

  function build(authorResult: any) {
    const updateReplyUrl = vi.fn(async () => ({ id: 'post-1' }));
    const updateReplyAuthor = vi.fn(async () => undefined);
    const repo = {
      getSentReplyPlatform: vi.fn(async () => 'x'),
      updateReplyUrl,
      updateReplyAuthor,
    } as any;
    const postsService = {
      fetchEngageXAuthor: vi.fn(async () => authorResult),
    } as any;
    const service = new EngageService(repo, { client: undefined } as any, postsService, {} as any, {} as any);
    return { service, updateReplyUrl, updateReplyAuthor, postsService };
  }

  const flush = () => new Promise((r) => setImmediate(r));

  it('saves the URL with NO engageAuthor argument (never blocks on the lookup)', async () => {
    const { service, updateReplyUrl } = build({ handle: 'benppoulton' });

    await service.submitManualReplyUrl(org, 'reply-1', url);

    // updateReplyUrl is called with NO resolved author (4th arg is undefined) —
    // the URL is saved immediately and the slow author lookup runs out of band.
    expect(updateReplyUrl).toHaveBeenCalledWith('org-1', 'reply-1', url, undefined);
  });

  it('resolves the author out of band and persists it via updateReplyAuthor', async () => {
    const author = { handle: 'benppoulton', id: 't2_1', name: 'Ben Poulton' };
    const { service, updateReplyAuthor, postsService } = build(author);

    await service.submitManualReplyUrl(org, 'reply-1', url);
    await flush(); // let the fire-and-forget microtask run

    expect(postsService.fetchEngageXAuthor).toHaveBeenCalledWith('org-1', url);
    expect(updateReplyAuthor).toHaveBeenCalledWith('org-1', 'reply-1', author);
  });

  it('does NOT call updateReplyAuthor when the author cannot be resolved', async () => {
    const { service, updateReplyAuthor } = build(null);

    await service.submitManualReplyUrl(org, 'reply-1', url);
    await flush();

    expect(updateReplyAuthor).not.toHaveBeenCalled();
  });
});

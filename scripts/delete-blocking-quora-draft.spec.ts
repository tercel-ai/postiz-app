import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  deleteBlockingQuoraDraft,
  parseDraftOptions,
  readAuthToken,
  TARGET,
} from './delete-blocking-quora-draft';

const post = (extra = {}) => ({
  id: TARGET.postId,
  organizationId: TARGET.organizationId,
  projectId: TARGET.projectId,
  integrationId: TARGET.integrationId,
  integration: { providerIdentifier: 'quora' },
  state: 'DRAFT',
  deletedAt: null,
  sendIntentId: null,
  releaseId: null,
  parentPostId: null,
  childrenPost: [],
  intervalInDays: null,
  ...extra,
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
function fixture(extra = {}) {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(response({ found: true }))
    .mockResolvedValueOnce(response({ posts: [post(extra)] }))
    .mockResolvedValueOnce(response({ error: true }))
    .mockResolvedValueOnce(response({ found: false }));
}

describe('delete the reviewed blocking Quora draft through the API', () => {
  it('defaults to preview and rejects unknown or repeated options', () => {
    expect(parseDraftOptions([])).toEqual({ apply: false, help: false });
    expect(parseDraftOptions(['--apply']).apply).toBe(true);
    expect(parseDraftOptions(['--help']).help).toBe(true);
    for (const args of [['--force'], ['--apply', '--apply'], ['--token', 'secret']]) {
      expect(() => parseDraftOptions(args)).toThrow();
    }
  });

  it('previews without deleting or logging account credentials', async () => {
    const fetcher = fixture();
    const result = await deleteBlockingQuoraDraft('secret', false, fetcher);
    expect(result).toEqual({ target: TARGET, status: 'preview' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toBe(
      `${TARGET.baseUrl}/posts/list/locate?postId=${TARGET.postId}`
    );
    expect(fetcher.mock.calls[1][0]).toContain(`projectId=${TARGET.projectId}`);
    expect(fetcher.mock.calls[1][1]).toMatchObject({
      headers: { authorization: 'Bearer secret', showorg: TARGET.organizationId },
      redirect: 'error', cache: 'no-store',
    });
  });

  it('deletes exactly the reviewed ID and verifies absence despite the legacy error flag', async () => {
    const fetcher = fixture();
    await expect(deleteBlockingQuoraDraft('Bearer secret', true, fetcher))
      .resolves.toEqual({ target: TARGET, status: 'deleted' });
    expect(fetcher.mock.calls[2][0]).toBe(`${TARGET.baseUrl}/posts/id/${TARGET.postId}`);
    expect(fetcher.mock.calls[2][1]).toMatchObject({ method: 'DELETE' });
    expect(fetcher.mock.calls[3][0]).toBe(fetcher.mock.calls[0][0]);
  });

  it.each([
    { id: 'other' }, { organizationId: 'other' }, { projectId: 'other' },
    { integrationId: 'other' }, { integration: { providerIdentifier: 'x' } },
    { state: 'QUEUE' }, { state: 'PUBLISHED' }, { sendIntentId: 'intent' },
    { releaseId: 'lease' }, { deletedAt: '2026-10-28' },
    { parentPostId: 'parent' }, { childrenPost: [{ id: 'child' }] },
    { intervalInDays: 7 }, { sendIntentId: undefined },
  ])('refuses unsafe or changed draft data: %j', async extra => {
    const fetcher = fixture(extra);
    await expect(deleteBlockingQuoraDraft('secret', true, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reports an absent post without sending a delete request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ found: false }));
    await expect(deleteBlockingQuoraDraft('secret', true, fetcher))
      .resolves.toEqual({ target: TARGET, status: 'not-found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 409, 500])('stops on HTTP %i without echoing server bodies', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ token: 'secret' }, status));
    await expect(deleteBlockingQuoraDraft('secret', true, fetcher))
      .rejects.toThrow(`HTTP ${status}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not mistake an HTTP failure during delete for success', async () => {
    const fetcher = fixture();
    fetcher.mockReset()
      .mockResolvedValueOnce(response({ found: true }))
      .mockResolvedValueOnce(response({ posts: [post()] }))
      .mockResolvedValueOnce(response({}, 409));
    await expect(deleteBlockingQuoraDraft('secret', true, fetcher)).rejects.toThrow('HTTP 409');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('fails verification when the draft remains visible', async () => {
    const fetcher = fixture();
    fetcher.mockReset()
      .mockResolvedValueOnce(response({ found: true }))
      .mockResolvedValueOnce(response({ posts: [post()] }))
      .mockResolvedValueOnce(response({ error: true }))
      .mockResolvedValueOnce(response({ found: true }));
    await expect(deleteBlockingQuoraDraft('secret', true, fetcher))
      .rejects.toThrow('still visible');
  });

  it.each([{}, { found: 'false' }])('rejects malformed lookup responses: %j', async body => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(body));
    await expect(deleteBlockingQuoraDraft('secret', true, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sanitizes transport failures rather than leaking token-bearing messages', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret'));
    await expect(deleteBlockingQuoraDraft('secret', true, fetcher))
      .rejects.toThrow('Request failed');
  });

  it('reads an environment token without prompting', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    await expect(readAuthToken({ AISEE_AUTH_TOKEN: 'Bearer secret' }, input, output))
      .resolves.toBe('secret');
    expect(output.read()).toBeNull();
  });

  it('requires a token in noninteractive use', async () => {
    await expect(readAuthToken({}, new PassThrough(), new PassThrough()))
      .rejects.toThrow('AISEE_AUTH_TOKEN');
  });

  it('hides terminal input and restores terminal mode after entry', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const output = new PassThrough();
    const pending = readAuthToken({}, input, output);
    input.write('hidden-secret\r');
    await expect(pending).resolves.toBe('hidden-secret');
    expect(output.read().toString()).not.toContain('hidden-secret');
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('restores terminal mode when hidden input is cancelled', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const pending = readAuthToken({}, input, new PassThrough());
    input.write('\u0003');
    await expect(pending).rejects.toThrow('cancelled');
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });
});

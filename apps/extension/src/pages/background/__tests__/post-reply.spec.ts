import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePostReply } from '../post-reply';
import { postRedditComment } from '@gitroom/extension/utils/reddit.poster';
import { postXReply } from '../x.poster';
import { notifyReply } from '@gitroom/extension/utils/notify';

vi.mock('@gitroom/extension/utils/reddit.poster', () => ({
  postRedditComment: vi.fn(),
}));
vi.mock('../x.poster', () => ({
  postXReply: vi.fn(),
}));
vi.mock('@gitroom/extension/utils/auth.service', () => ({
  getValidAccessToken: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@gitroom/extension/utils/notify', () => ({
  notifyReply: vi.fn(),
}));

const mockedReddit = vi.mocked(postRedditComment);
const mockedX = vi.mocked(postXReply);

/**
 * Route the background's fetch calls: GET /engage/sent/:id/status (duplicate
 * guard) and PATCH /engage/sent/:id/publish-reply (backfill). Each handler
 * returns the Response-ish object the code under test reads.
 */
function stubFetch(handlers: {
  status?: () => Promise<any> | any;
  publish?: (init: RequestInit) => Promise<any> | any;
}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('/status')) {
      if (!handlers.status) throw new Error('unexpected status call');
      return handlers.status();
    }
    if (url.includes('/publish-reply')) {
      if (!handlers.publish) throw new Error('unexpected publish call');
      return handlers.publish(init!);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const basePayload = {
  platform: 'reddit' as const,
  url: 'https://www.reddit.com/r/test/comments/abc/hello/',
  text: 'a reply',
  sentReplyId: 'r1',
  backendBase: 'https://api.example.com',
  token: 'tok',
  opportunityId: 'o1',
};

describe('handlePostReply — pre-send duplicate guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('refuses to post when the sent reply already has a replyUrl', async () => {
    stubFetch({
      status: () => ok({ state: 'PUBLISHED', replyUrl: 'https://reddit.com/x' }),
    });

    const res = await handlePostReply({ ...basePayload });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already published/i);
    expect(mockedReddit).not.toHaveBeenCalled();
    expect(notifyReply).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false })
    );
  });

  it('refuses to post when the record is PUBLISHED even without a URL', async () => {
    stubFetch({ status: () => ok({ state: 'PUBLISHED', replyUrl: null }) });

    const res = await handlePostReply({ ...basePayload });

    expect(res.ok).toBe(false);
    expect(mockedReddit).not.toHaveBeenCalled();
  });

  it('fails OPEN when the status probe errors — a probe failure is not a duplicate', async () => {
    stubFetch({
      status: () => {
        throw new Error('network down');
      },
      publish: () => ok({ ok: true }),
    });
    mockedReddit.mockResolvedValue({
      ok: true,
      permalink: 'https://www.reddit.com/r/test/comments/abc/hello/comment/d1/',
    });

    const res = await handlePostReply({ ...basePayload });

    expect(mockedReddit).toHaveBeenCalledOnce();
    expect(res.ok).toBe(true);
  });

  it('skips the probe entirely for debug sends with no sentReplyId', async () => {
    const { calls } = stubFetch({});
    mockedReddit.mockResolvedValue({ ok: true, permalink: 'https://r/p' });

    await handlePostReply({
      ...basePayload,
      sentReplyId: undefined,
      backendBase: undefined,
    });

    expect(calls).toHaveLength(0);
    expect(mockedReddit).toHaveBeenCalledOnce();
  });
});

describe('handlePostReply — backfill on confirmed send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('backfills URL-less when the platform confirmed but no permalink was captured', async () => {
    const { calls } = stubFetch({
      status: () => ok({ state: 'DRAFT', replyUrl: null }),
      publish: () => ok({ ok: true }),
    });
    // Reddit accepted the comment but the response node could not be parsed.
    mockedReddit.mockResolvedValue({ ok: true });

    const res = await handlePostReply({ ...basePayload });

    const publish = calls.find((c) => c.url.includes('/publish-reply'));
    expect(publish).toBeDefined();
    const body = JSON.parse(String(publish!.init!.body));
    // The commit still lands, just without a url field.
    expect(body).not.toHaveProperty('url');
    expect(res.backfilled).toBe(true);
  });

  it('backfills WITH the permalink when one was captured', async () => {
    const { calls } = stubFetch({
      status: () => ok({ state: 'DRAFT', replyUrl: null }),
      publish: () => ok({ ok: true }),
    });
    const permalink =
      'https://www.reddit.com/r/test/comments/abc/hello/comment/d1/';
    mockedReddit.mockResolvedValue({ ok: true, permalink });

    await handlePostReply({ ...basePayload });

    const publish = calls.find((c) => c.url.includes('/publish-reply'));
    const body = JSON.parse(String(publish!.init!.body));
    expect(body.url).toBe(permalink);
  });

  it('does NOT backfill a pending X result — nothing is provably live yet', async () => {
    const { calls } = stubFetch({
      status: () => ok({ state: 'DRAFT', replyUrl: null }),
    });
    mockedX.mockResolvedValue({
      ok: true,
      pending: true,
      message: 'Draft filled — click Reply on X',
    });

    const res = await handlePostReply({ ...basePayload, platform: 'x' });

    expect(calls.find((c) => c.url.includes('/publish-reply'))).toBeUndefined();
    expect(res.backfilled).toBeUndefined();
  });
});

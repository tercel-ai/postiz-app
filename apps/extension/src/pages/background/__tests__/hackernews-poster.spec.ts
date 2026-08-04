import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseHackernewsId,
  submitHackernewsStory,
} from '../hackernews.poster';
import * as tabAutomation from '@gitroom/extension/utils/tab-automation';

vi.mock('@gitroom/extension/utils/tab-automation', () => ({
  openTab: vi.fn(),
  closeTab: vi.fn(),
  focusTab: vi.fn(),
  getTabUrl: vi.fn(),
  runInPage: vi.fn(),
  sleep: vi.fn().mockResolvedValue(undefined),
  waitForTabComplete: vi.fn().mockResolvedValue(undefined),
}));

const mocked = vi.mocked(tabAutomation);

/**
 * Route runInPage calls by the injected function's name (the poster passes
 * named function references), recording the call order so the spec can assert
 * WHEN the username is read — it must happen on the post-submit landing page,
 * because /submit renders a stripped header with no `user?id=` link.
 */
function stubPage(handlers: Record<string, (...args: any[]) => any>) {
  const calls: string[] = [];
  mocked.runInPage.mockImplementation(async (_tabId, fn: any, args?: any[]) => {
    const name = fn?.name || 'anonymous';
    calls.push(name);
    const handler = handlers[name];
    return handler ? handler(...(args ?? [])) : null;
  });
  return calls;
}

describe('parseHackernewsId', () => {
  it('extracts the numeric id from an item URL', () => {
    expect(
      parseHackernewsId('https://news.ycombinator.com/item?id=49163380')
    ).toBe('49163380');
  });

  it('rejects non-HN hosts and malformed ids', () => {
    expect(parseHackernewsId('https://example.com/item?id=1')).toBeNull();
    expect(parseHackernewsId('https://news.ycombinator.com/item?id=abc')).toBeNull();
    expect(parseHackernewsId('not a url')).toBeNull();
  });
});

describe('submitHackernewsStory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.sleep.mockResolvedValue(undefined);
    mocked.waitForTabComplete.mockResolvedValue(undefined);
    mocked.openTab.mockResolvedValue({ tabId: 7 });
    (globalThis as any).chrome = {
      tabs: { update: vi.fn().mockResolvedValue(undefined) },
    };
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
  });

  it('reads the username on the landing page (after submit) and resolves the permalink there', async () => {
    mocked.getTabUrl.mockResolvedValue('https://news.ycombinator.com/newest');
    const calls = stubPage({
      hnDetectLogin: () => false,
      hnFillSubmit: () => 'submitted',
      hnReadUsername: () => 'alice',
      hnFindOnLanding: (title: string, username: string | null) => {
        expect(title).toBe('My Story');
        expect(username).toBe('alice');
        return '123';
      },
    });

    const r = await submitHackernewsStory({ title: 'My Story', text: 'body' });

    expect(r).toMatchObject({
      ok: true,
      permalink: 'https://news.ycombinator.com/item?id=123',
      postId: '123',
      author: { handle: 'alice' },
    });
    // /submit has no user link — the username MUST be read after the submit.
    expect(calls.indexOf('hnReadUsername')).toBeGreaterThan(
      calls.indexOf('hnFillSubmit')
    );
    expect(calls).not.toContain('hnScanSubmittedPage');
  });

  it('falls back to /submitted?id=<user> when the landing-page match fails', async () => {
    mocked.getTabUrl.mockResolvedValue('https://news.ycombinator.com/newest');
    stubPage({
      hnDetectLogin: () => false,
      hnFillSubmit: () => 'submitted',
      hnReadUsername: () => 'alice',
      hnFindOnLanding: () => null,
      hnScanSubmittedPage: () => ({ id: '456', rows: 3 }),
    });

    const r = await submitHackernewsStory({ title: 'T', text: 'b' });

    expect(r).toMatchObject({
      ok: true,
      permalink: 'https://news.ycombinator.com/item?id=456',
      postId: '456',
    });
    expect((globalThis as any).chrome.tabs.update).toHaveBeenCalledWith(7, {
      url: 'https://news.ycombinator.com/submitted?id=alice',
    });
  });

  it('fails (never URL-less success) when neither username nor landing match is available', async () => {
    mocked.getTabUrl.mockResolvedValue('https://news.ycombinator.com/newest');
    stubPage({
      hnDetectLogin: () => false,
      hnFillSubmit: () => 'submitted',
      hnReadUsername: () => null,
      hnFindOnLanding: () => null,
    });

    const r = await submitHackernewsStory({ title: 'T', text: 'b' });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not be verified/i);
    expect((globalThis as any).chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('fails when the story is absent from the inspected /submitted list', async () => {
    mocked.getTabUrl.mockResolvedValue('https://news.ycombinator.com/newest');
    stubPage({
      hnDetectLogin: () => false,
      hnFillSubmit: () => 'submitted',
      hnReadUsername: () => 'alice',
      hnFindOnLanding: () => null,
      // Page inspected (rows rendered) but the story is not there — HN
      // silently dropped the submission; this must NOT report success.
      hnScanSubmittedPage: () => ({ id: null, rows: 5 }),
    });

    const r = await submitHackernewsStory({ title: 'T', text: 'b' });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not appear in your submitted list/i);
  });

  it('fails with a clear reason on HN\'s anti-abuse "Sorry." page (fnop=sorry)', async () => {
    mocked.getTabUrl.mockResolvedValue(
      'https://news.ycombinator.com/x?fnid=qPi3ZBLZ3jzhBDCv1NbL2B&fnop=sorry'
    );
    stubPage({
      hnDetectLogin: () => false,
      hnFillSubmit: () => 'submitted',
    });

    const r = await submitHackernewsStory({ title: 'T', text: 'b' });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/declined the submission/i);
    // Must short-circuit before any permalink resolution.
    expect((globalThis as any).chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('fails on HN error interstitials (expired fnid / rate limit) even off /submit', async () => {
    mocked.getTabUrl.mockResolvedValue('https://news.ycombinator.com/r');
    stubPage({
      hnDetectLogin: () => false,
      hnFillSubmit: () => 'submitted',
      hnReadPageError: () => 'Unknown or expired link',
    });

    const r = await submitHackernewsStory({ title: 'T', text: 'b' });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unknown or expired link/);
  });

  it('reports a rejected submission when the tab is still on /submit', async () => {
    mocked.getTabUrl.mockResolvedValue('https://news.ycombinator.com/submit');
    stubPage({
      hnDetectLogin: () => false,
      hnFillSubmit: () => 'submitted',
    });

    const r = await submitHackernewsStory({ title: 'T', text: 'b' });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/rejected/i);
  });
});

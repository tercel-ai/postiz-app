import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tab layer is the only thing standing between this poster and a live
// browser, so it is stubbed wholesale and the injected functions are dispatched
// by name — that keeps the assertions about WHICH page step ran, which is the
// whole point of a guard that must abort before the composer opens.
const openTab = vi.fn();
const runInPage = vi.fn();
const closeTab = vi.fn();
const focusTab = vi.fn();
const getTabUrl = vi.fn();

vi.mock('@gitroom/extension/utils/tab-automation', () => ({
  openTab: (...a: any[]) => openTab(...a),
  runInPage: (...a: any[]) => runInPage(...a),
  closeTab: (...a: any[]) => closeTab(...a),
  focusTab: (...a: any[]) => focusTab(...a),
  getTabUrl: (...a: any[]) => getTabUrl(...a),
  sleep: async (): Promise<void> => undefined,
}));

import { postQuoraPost } from '../quora.poster';

/** Names of the in-page functions, in the order the poster runs them. */
const ran = () => runInPage.mock.calls.map(([, fn]) => (fn as any).name);

function stubPage(opts: { slug?: string; compose?: string } = {}) {
  runInPage.mockImplementation(async (_tabId: number, fn: any) => {
    switch (fn.name) {
      case 'quoraDetectLogin':
        return false;
      case 'quoraReadOwnSlug':
        return opts.slug;
      case 'quoraComposeInPage':
        return opts.compose ?? 'posted';
      default:
        throw new Error(`unexpected in-page function: ${fn.name}`);
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  openTab.mockResolvedValue({ tabId: 1 });
  // A permalink on the first poll ends the post-submit wait immediately.
  getTabUrl.mockResolvedValue('https://www.quora.com/Some-Question-Title');
  // The MAIN-world create interceptor install + capture-read go through
  // chrome.scripting.executeScript directly (not the runInPage mock above).
  // No capture here — falls through to the getTabUrl poll stubbed above.
  vi.stubGlobal('chrome', {
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: null }]) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('postQuoraPost — wrong-account guard', () => {
  it('aborts before the composer when the tab is signed in as someone else', async () => {
    stubPage({ slug: 'Someone-Else' });

    const r = await postQuoraPost({ text: 'hello', expectedSlug: 'Tercel-Yi' });

    expect(r.ok).toBe(false);
    // Both accounts must be named: "wrong account" without saying which is not
    // actionable, and the user has to know which one to switch to.
    expect(r.error).toContain('Someone-Else');
    expect(r.error).toContain('Tercel-Yi');
    // The identity WAS read and the composer never opened — asserting only the
    // absence would pass just as happily if the dispatch broke and nothing ran.
    expect(ran()).toContain('quoraReadOwnSlug');
    expect(ran()).not.toContain('quoraComposeInPage');
    // And the tab is closed, not left focused: a tab sitting on a half-open
    // composer invites finishing the post by hand as the WRONG account.
    expect(closeTab).toHaveBeenCalledWith(1);
    expect(focusTab).not.toHaveBeenCalled();
  });

  it('publishes when the slugs differ only by case or a stored /profile/ prefix', async () => {
    // Quora slugs are case-insensitive, and an Integration row predating the
    // provider's prefix-stripping still carries the path. A false mismatch
    // there would block a legitimate post forever.
    stubPage({ slug: 'Tercel-Yi' });

    const r = await postQuoraPost({
      text: 'hello',
      expectedSlug: '/profile/tercel-yi',
    });

    expect(r.ok).toBe(true);
    expect(ran()).toContain('quoraComposeInPage');
  });

  it('publishes unverified when the identity cannot be read', async () => {
    // Fails OPEN deliberately: an unreadable identity is not evidence of a
    // mismatch, and blocking every post on it would take Quora publishing
    // offline the next time Quora changes that page.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubPage({ slug: undefined });

    const r = await postQuoraPost({ text: 'hello', expectedSlug: 'Tercel-Yi' });

    expect(r.ok).toBe(true);
    expect(ran()).toContain('quoraComposeInPage');
    // A wrong-account publish is irreversible and only ever surfaces after the
    // fact, so an unverified pass must not read identically to a verified one.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never reads the identity when the post is not bound to an account', async () => {
    // Operation-plan posts publish by platform, so "whoever is signed in" IS
    // the intent — paying for an identity read there would be pure overhead.
    stubPage({ slug: 'Anyone-At-All' });

    const r = await postQuoraPost({ text: 'hello' });

    expect(r.ok).toBe(true);
    expect(ran()).not.toContain('quoraReadOwnSlug');
  });

  it('reports the login wall before any account comparison', async () => {
    runInPage.mockImplementation(async (_tabId: number, fn: any) =>
      fn.name === 'quoraDetectLogin' ? true : undefined
    );

    const r = await postQuoraPost({ text: 'hello', expectedSlug: 'Tercel-Yi' });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not signed in/i);
    expect(ran()).not.toContain('quoraReadOwnSlug');
  });
});

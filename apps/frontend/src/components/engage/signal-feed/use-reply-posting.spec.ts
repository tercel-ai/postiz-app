// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// The hook pulls the org-scoped fetch + the extension protocol constants from
// @gitroom/helpers; mock both so the test runs without the app wiring.
const fetchMock = vi.fn();
vi.mock('@gitroom/helpers/utils/custom.fetch', () => ({
  useFetch: () => fetchMock,
}));
vi.mock('@gitroom/helpers/extension/brand', () => ({
  EXTENSION_MESSAGE: {
    source: 'aisee',
    engageReply: 'aisee:engage-reply',
    resultSource: 'aisee-extension',
    engageReplyResult: 'aisee:engage-reply-result',
  },
}));

import { useReplyPosting } from './use-reply-posting';

const okJson = (body: unknown) => ({ ok: true, json: async () => body });

// Build a same-window, same-origin extension result message (the hook rejects
// anything else as a safety check).
function dispatchExtensionResult(result: unknown, opportunityId = 'opp-1') {
  const ev = new MessageEvent('message', {
    data: {
      source: 'aisee-extension',
      action: 'aisee:engage-reply-result',
      opportunityId,
      result,
    },
    origin: window.location.origin,
  });
  Object.defineProperty(ev, 'source', { value: window });
  window.dispatchEvent(ev);
}

describe('useReplyPosting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('enters "posting" on begin() and stays there until a signal arrives', async () => {
    fetchMock.mockResolvedValue(okJson({ replyUrl: null }));
    const { result } = renderHook(() => useReplyPosting('opp-1'));

    expect(result.current.posting).toBe(false);
    act(() => result.current.begin('reply-1'));
    expect(result.current.posting).toBe(true);
    expect(result.current.status).toBe('posting');

    // Two polls in, the permalink still isn't backfilled → still posting.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.status).toBe('posting');
  });

  it('resolves SUCCESS once polling sees a backfilled replyUrl', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson({ replyUrl: null }))
      .mockResolvedValueOnce(okJson({ replyUrl: null }))
      .mockResolvedValue(okJson({ replyUrl: 'https://www.reddit.com/r/x/comments/a/comment/b/' }));

    const onResolved = vi.fn();
    const { result } = renderHook(() => useReplyPosting('opp-1', onResolved));
    act(() => result.current.begin('reply-1'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(onResolved).toHaveBeenCalledWith({ status: 'success' });
    expect(result.current.status).toBe('success');
  });

  it('settles to PROCESSING on the 20s timeout — never "failed"', async () => {
    fetchMock.mockResolvedValue(okJson({ replyUrl: null }));
    const onResolved = vi.fn();
    const { result } = renderHook(() => useReplyPosting('opp-1', onResolved));
    act(() => result.current.begin('reply-1'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });

    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith({ status: 'processing' });
    expect(result.current.status).toBe('processing');
  });

  it('resolves SUCCESS immediately via the extension result message (fast path)', () => {
    fetchMock.mockResolvedValue(okJson({ replyUrl: null }));
    const onResolved = vi.fn();
    const { result } = renderHook(() => useReplyPosting('opp-1', onResolved));
    act(() => result.current.begin('reply-1'));

    act(() => dispatchExtensionResult({ ok: true, backfilled: true }));

    expect(onResolved).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' })
    );
    expect(result.current.status).toBe('success');
  });

  it('resolves FAILED when the extension explicitly reports an error', () => {
    fetchMock.mockResolvedValue(okJson({ replyUrl: null }));
    const onResolved = vi.fn();
    const { result } = renderHook(() => useReplyPosting('opp-1', onResolved));
    act(() => result.current.begin('reply-1'));

    act(() => dispatchExtensionResult({ ok: false, error: 'no session' }));

    expect(onResolved).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: 'no session' })
    );
    expect(result.current.status).toBe('failed');
  });

  it('ignores result messages for a different opportunity', () => {
    fetchMock.mockResolvedValue(okJson({ replyUrl: null }));
    const onResolved = vi.fn();
    const { result } = renderHook(() => useReplyPosting('opp-1', onResolved));
    act(() => result.current.begin('reply-1'));

    act(() => dispatchExtensionResult({ ok: true }, 'some-other-opp'));

    expect(onResolved).not.toHaveBeenCalled();
    expect(result.current.status).toBe('posting');
  });
});

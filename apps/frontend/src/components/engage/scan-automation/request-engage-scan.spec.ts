// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';
import { requestEngageScan } from './request-engage-scan';

describe('requestEngageScan', () => {
  it('resolves only the matching extension response', async () => {
    const postMessage = vi
      .spyOn(window, 'postMessage')
      .mockImplementation(() => undefined);
    const pending = requestEngageScan();
    const request = postMessage.mock.calls[0][0] as {
      requestId: string;
    };

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
          source: EXTENSION_MESSAGE.resultSource,
          action: EXTENSION_MESSAGE.engageScanResult,
          requestId: request.requestId,
          ok: true,
          summary: {
            units: 2,
            posts: 7,
            accepted: 4,
            stoppedReason: 'idle',
          },
        },
      })
    );

    await expect(pending).resolves.toEqual({
      units: 2,
      posts: 7,
      accepted: 4,
      stoppedReason: 'idle',
    });
  });
});

export interface EngageScanRunSummary {
  units: number;
  posts: number;
  accepted: number;
  stoppedReason: string;
}

export function requestEngageScan(
  timeoutMs = 120_000
): Promise<EngageScanRunSummary> {
  const requestId =
    globalThis.crypto?.randomUUID?.() ??
    `scan-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('The extension did not finish the scan in time'));
    }, timeoutMs);

    const finish = () => {
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
    };

    function onMessage(event: MessageEvent) {
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        source?: string;
        action?: string;
        requestId?: string;
        ok?: boolean;
        summary?: EngageScanRunSummary;
        error?: string;
      };
      if (data?.source !== EXTENSION_MESSAGE.resultSource) return;
      if (data.action !== EXTENSION_MESSAGE.engageScanResult) return;
      if (data.requestId !== requestId) return;
      finish();
      if (!data.ok || !data.summary) {
        reject(new Error(data.error || 'The extension could not run the scan'));
        return;
      }
      resolve(data.summary);
    }

    window.addEventListener('message', onMessage);
    window.postMessage(
      {
        source: EXTENSION_MESSAGE.source,
        action: EXTENSION_MESSAGE.engageScan,
        requestId,
      },
      window.location.origin
    );
  });
}
import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';

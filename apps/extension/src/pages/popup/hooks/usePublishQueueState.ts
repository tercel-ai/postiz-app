import { useCallback, useEffect, useState } from 'react';
import { ENGAGE_EXTENSION_ACTION } from '@gitroom/extension/utils/executor/actions';
import type {
  PublishPostItem,
  PublishTaskState,
} from '@gitroom/helpers/extension/post-publish';

// The publish queue lives in the service worker and is persisted verbatim to
// chrome.storage.local under this key (apps/extension/src/utils/post-publish/
// queue.ts, STORAGE_KEY). We read it directly and live-refresh on
// storage.onChanged — the same pattern as useReplyHistoryState — so every
// state transition the SW persists (queued → publishing → published/error)
// shows up here without a message round-trip. Actions (publish-now / cancel)
// still go through the SW, which persists and thereby feeds this listener back.
const PUBLISH_QUEUE_STORAGE_KEY = 'aisee_publish_queue';

/** One persisted queue row (see QueueEntry in queue.ts). */
export interface PublishQueueRow {
  item: PublishPostItem;
  state: PublishTaskState;
  requestId?: string;
  tabId?: number;
  /** Epoch ms this task becomes due (0 = immediately). */
  dueAt: number;
}

function sendAction(action: string, extra: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ action, ...extra }, (resp) => {
        const err = chrome.runtime.lastError?.message;
        if (err) return reject(new Error(err));
        if (resp?.ok) resolve();
        else reject(new Error(resp?.reason || resp?.error || 'Request failed'));
      });
    } catch (e: any) {
      reject(new Error(String(e?.message || e)));
    }
  });
}

/** Publish-queue state — used by both Popup and Panel. */
export function usePublishQueueState() {
  const [rows, setRows] = useState<PublishQueueRow[]>([]);

  useEffect(() => {
    const apply = (value: unknown) =>
      setRows(Array.isArray(value) ? (value as PublishQueueRow[]) : []);

    try {
      chrome.storage.local.get([PUBLISH_QUEUE_STORAGE_KEY], (data) =>
        apply(data?.[PUBLISH_QUEUE_STORAGE_KEY])
      );
    } catch {
      apply(undefined);
    }

    const onChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: string
    ) => {
      if (area === 'local' && changes[PUBLISH_QUEUE_STORAGE_KEY]) {
        apply(changes[PUBLISH_QUEUE_STORAGE_KEY].newValue);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const publishNow = useCallback(
    (taskId: string) =>
      sendAction(ENGAGE_EXTENSION_ACTION.publishNow, { taskId }),
    []
  );

  const cancelTask = useCallback(
    (taskId: string) =>
      sendAction(ENGAGE_EXTENSION_ACTION.publishCancel, { taskIds: [taskId] }),
    []
  );

  return { rows, publishNow, cancelTask };
}

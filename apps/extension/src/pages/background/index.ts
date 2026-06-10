import { fetchRequestUtil } from '@gitroom/extension/utils/request.util';
import { handlePostReply } from './post-reply';

const isDevelopment = process.env.NODE_ENV === 'development';

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.action === 'makeHttpRequest') {
    fetchRequestUtil(request).then((response) => {
      sendResponse(response);
    });
  }

  // In-browser reply (Option A). payload: { platform, url, text, opportunityId? }
  if (request.action === 'postReply') {
    handlePostReply(request.payload)
      .then(sendResponse)
      .catch((e) =>
        sendResponse({ ok: false, error: String(e?.message || e) })
      );
    return true;
  }

  if (request.action === 'loadStorage') {
    chrome.storage.local.get([request.key], function (storage) {
      sendResponse(storage[request.key]);
    });
  }

  if (request.action === 'saveStorage') {
    chrome.storage.local.set({ [request.key]: request.value }, function () {
      sendResponse({ success: true });
    });
  }

  if (request.action === 'openTab') {
    chrome.tabs.create({ url: request.url }, function (tab) {
      sendResponse({ success: true, tabId: tab?.id });
    });
  }

  if (request.action === 'loadCookie') {
    chrome.cookies.get(
      {
        url: import.meta.env?.FRONTEND_URL || process?.env?.FRONTEND_URL,
        name: request.cookieName,
      },
      function (cookies) {
        sendResponse(cookies?.value);
      }
    );
  }

  return true;
});

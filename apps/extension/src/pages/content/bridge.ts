import { installAuthBridge } from '@gitroom/extension/pages/content/auth-bridge';
import { installEngageReplyBridge } from '@gitroom/extension/pages/content/browser-assisted-reply';
import { installPingBridge } from '@gitroom/extension/pages/content/ping-bridge';
import { installEngageScanBridge } from '@gitroom/extension/pages/content/engage-scan-bridge';
import { installEngageMetricsBridge } from '@gitroom/extension/pages/content/engage-metrics-bridge';
import { installPostMetricsBridge } from '@gitroom/extension/pages/content/post-metrics-bridge';
import { installPostsMetricsRefreshBridge } from '@gitroom/extension/pages/content/posts-metrics-refresh-bridge';
import { installSocialSessionsBridge } from '@gitroom/extension/pages/content/social-sessions-bridge';
import { installPostPublishBridge } from '@gitroom/extension/pages/content/post-publish-bridge';

// Installers that touch chrome.runtime at install time (post-publish and auth
// register onMessage listeners) throw "Extension context invalidated" when this
// content script has been orphaned — the extension was reloaded, updated, or
// rebuilt in place while the page stayed open. At module scope that throw is
// fatal: every installer AFTER the failing one is skipped, so a single dead
// listener registration silently takes down the whole bridge (including the
// presence ping, which is what the web app uses to decide whether the extension
// is installed at all). Isolate them so one dead installer can't cascade.
function install(name: string, fn: () => void): void {
  try {
    fn();
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn(
      `[aisee] bridge: ${name} failed to install —`,
      String(e?.message || e)
    );
  }
}

install('ping', installPingBridge);
install('socialSessions', installSocialSessionsBridge);
install('postPublish', installPostPublishBridge);
install('engageScan', installEngageScanBridge);
install('engageMetrics', installEngageMetricsBridge);
install('postMetrics', installPostMetricsBridge);
install('postsMetricsRefresh', installPostsMetricsRefreshBridge);
install('engageReply', installEngageReplyBridge);
install('auth', installAuthBridge);

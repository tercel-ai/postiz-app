import { installAuthBridge } from '@gitroom/extension/pages/content/auth-bridge';
import { installEngageReplyBridge } from '@gitroom/extension/pages/content/browser-assisted-reply';
import { installPingBridge } from '@gitroom/extension/pages/content/ping-bridge';
import { installEngageScanBridge } from '@gitroom/extension/pages/content/engage-scan-bridge';
import { installEngageMetricsBridge } from '@gitroom/extension/pages/content/engage-metrics-bridge';
import { installPostMetricsBridge } from '@gitroom/extension/pages/content/post-metrics-bridge';
import { installPostsMetricsRefreshBridge } from '@gitroom/extension/pages/content/posts-metrics-refresh-bridge';
import { installSocialSessionsBridge } from '@gitroom/extension/pages/content/social-sessions-bridge';

installPingBridge();
installSocialSessionsBridge();
installEngageScanBridge();
installEngageMetricsBridge();
installPostMetricsBridge();
installPostsMetricsRefreshBridge();
installEngageReplyBridge();
installAuthBridge();

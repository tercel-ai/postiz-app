import { installAuthBridge } from '@gitroom/extension/pages/content/auth-bridge';
import { installEngageReplyBridge } from '@gitroom/extension/pages/content/browser-assisted-reply';
import { installPingBridge } from '@gitroom/extension/pages/content/ping-bridge';
import { installEngageScanBridge } from '@gitroom/extension/pages/content/engage-scan-bridge';
import { installEngageMetricsBridge } from '@gitroom/extension/pages/content/engage-metrics-bridge';

installPingBridge();
installEngageScanBridge();
installEngageMetricsBridge();
installEngageReplyBridge();
installAuthBridge();

import { installAuthBridge } from '@gitroom/extension/pages/content/auth-bridge';
import { installEngageReplyBridge } from '@gitroom/extension/pages/content/browser-assisted-reply';
import { installPingBridge } from '@gitroom/extension/pages/content/ping-bridge';
import { installEngageScanBridge } from '@gitroom/extension/pages/content/engage-scan-bridge';

installPingBridge();
installEngageScanBridge();
installEngageReplyBridge();
installAuthBridge();

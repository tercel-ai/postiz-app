import { installAuthBridge } from '@gitroom/extension/pages/content/auth-bridge';
import { installEngageReplyBridge } from '@gitroom/extension/pages/content/browser-assisted-reply';
import { installPingBridge } from '@gitroom/extension/pages/content/ping-bridge';

installPingBridge();
installEngageReplyBridge();
installAuthBridge();

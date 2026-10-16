import { isAccountBoundSendingEnabled } from '@gitroom/nestjs-libraries/extension/account-bound-sending.config';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

@Injectable()
export class ExtensionExecutionReadyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { headers } = context.switchToHttp().getRequest();
    // Registry rollout must never hand controlled clients a legacy send lease.
    if (
      headers['x-extension-node-id'] ||
      headers['x-extension-node-token'] ||
      headers['x-extension-protocol-version']
    ) {
      if (isAccountBoundSendingEnabled() && headers['x-extension-node-id'] && headers['x-extension-node-token'] && headers['x-extension-protocol-version'] === 'ACCOUNT_BOUND_V1') return true;
      throw new ServiceUnavailableException('ACCOUNT_BOUND_SEND_NOT_ENABLED');
    }
    return true;
  }
}

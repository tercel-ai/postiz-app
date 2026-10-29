import { Integration } from '@prisma/client';
import { SendAction } from './send-binding.dto';

export type AccountBindingPurpose = 'SEND' | 'CONFIGURE';

const canonicalPlatform = (provider: string) =>
  provider === 'linkedin-page' ? 'linkedin' : provider.toLowerCase();

/** Preferences keep the selected integration; only sending requires a ready actor. */
export function accountBindingError(
  account:
    | Pick<
        Integration,
        | 'organizationId'
        | 'disabled'
        | 'deletedAt'
        | 'inBetweenSteps'
        | 'providerIdentifier'
        | 'identityNamespace'
        | 'internalId'
      >
    | undefined,
  relation: { disabled: boolean; engageEnabled: boolean } | undefined,
  org: string,
  project: string | undefined,
  platform: string,
  action: SendAction,
  purpose: AccountBindingPurpose = 'SEND'
): string | null {
  if (project !== undefined && (!relation || relation.disabled))
    return 'ACCOUNT_NOT_ASSIGNED';
  if (
    !account ||
    account.organizationId !== org ||
    account.deletedAt ||
    (purpose === 'SEND' && (account.disabled || account.inBetweenSteps))
  )
    return 'ACCOUNT_DISABLED';
  if (
    purpose === 'SEND' &&
    project !== undefined &&
    action === 'REPLY' &&
    relation!.engageEnabled !== true
  )
    return 'REPLY_ACCOUNT_DISABLED';
  if (canonicalPlatform(account.providerIdentifier) !== platform)
    return 'ACCOUNT_PLATFORM_MISMATCH';
  if (
    purpose === 'SEND' &&
    (!account.internalId || !account.identityNamespace || account.identityNamespace === 'legacy')
  )
    return 'ACCOUNT_IDENTITY_UNRESOLVED';
  return null;
}


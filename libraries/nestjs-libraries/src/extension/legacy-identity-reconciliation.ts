const OAUTH_VERIFIABLE_PROVIDERS = new Set(['x', 'reddit', 'linkedin-page']);

export interface LegacyIdentityCandidate {
  id: string;
  organizationId: string;
  providerIdentifier: string;
  identityNamespace: string;
  internalId: string;
  token: string;
}

export type LegacyIdentityPlan =
  | { action: 'VERIFY_OAUTH'; reason: null }
  | {
      action: 'WAIT_FOR_SESSION';
      reason: 'OAUTH_VERIFICATION_UNAVAILABLE' | 'OAUTH_CREDENTIAL_MISSING';
    };

export function planLegacyIdentity(
  candidate: Pick<LegacyIdentityCandidate, 'providerIdentifier' | 'token'>
): LegacyIdentityPlan {
  if (!OAUTH_VERIFIABLE_PROVIDERS.has(candidate.providerIdentifier)) {
    return {
      action: 'WAIT_FOR_SESSION',
      reason: 'OAUTH_VERIFICATION_UNAVAILABLE',
    };
  }
  if (!candidate.token?.trim()) {
    return {
      action: 'WAIT_FOR_SESSION',
      reason: 'OAUTH_CREDENTIAL_MISSING',
    };
  }
  return { action: 'VERIFY_OAUTH', reason: null };
}

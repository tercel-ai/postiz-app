// One deployment switch controls the complete account-bound plugin mechanism.
// Retired per-stage flags cannot implicitly opt a deployment into the new mode.
export function isAccountBoundSendingEnabled(): boolean {
  return process.env.ACCOUNT_BOUND_SENDING_ENABLED === 'true';
}

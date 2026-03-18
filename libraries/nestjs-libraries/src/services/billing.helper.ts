/**
 * Billing mode switch.
 *
 * BILL_TYPE controls which billing system is active:
 *
 *   - "internal"  — legacy Stripe-based subscription billing.
 *                   Credits table tracks per-operation quotas. Stripe webhooks
 *                   process subscription lifecycle events.
 *
 *   - "third"     — Aisee (../aisee-core) handles all billing externally.
 *                   BillingRecord table stores local audit trail. Stripe
 *                   endpoints return stubs. Subscription quotas (image / video
 *                   counts) are no longer enforced locally.
 *
 * Default: "third" (Aisee).
 */

export type BillType = 'internal' | 'third';

export function getBillType(): BillType {
  const raw = (process.env.BILL_TYPE || 'third').toLowerCase().trim();
  if (raw === 'internal') return 'internal';
  return 'third';
}

export function isInternalBilling(): boolean {
  return getBillType() === 'internal';
}

export function isThirdPartyBilling(): boolean {
  return getBillType() === 'third';
}

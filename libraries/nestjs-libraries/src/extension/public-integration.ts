// A whitelist keeps new credential columns from accidentally becoming public.
const PUBLIC_FIELDS = [
  'id',
  'organizationId',
  'internalId',
  'type',
  'name',
  'providerIdentifier',
  'picture',
  'disabled',
  'profile',
  'deletedAt',
  'createdAt',
  'updatedAt',
  'inBetweenSteps',
  'refreshNeeded',
  'activeSessionClient',
  'extensionSessionCheckedAt',
  'postingTimes',
  'customerId',
  'rootInternalId',
  'additionalSettings',
  'identityNamespace',
] as const;

export function publicIntegration(
  row: Record<string, unknown>
): Record<string, unknown> & { id: string; disabled?: boolean } {
  return Object.fromEntries(
    PUBLIC_FIELDS.filter((key) => key in row).map((key) => [key, row[key]])
  ) as Record<string, unknown> & { id: string; disabled?: boolean };
}

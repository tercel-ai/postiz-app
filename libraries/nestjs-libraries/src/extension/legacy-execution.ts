import { Prisma } from '@prisma/client';

// Nullable values are only a migration compatibility state. Unknown protocols fail closed.
export const legacyExecutionWhere = (): Prisma.PostWhereInput => ({
  OR: [{ executionProtocol: null }, { executionProtocol: 'LEGACY' }],
});
export const isLegacyExecution = (protocol: string | null | undefined) =>
  protocol == null || protocol === 'LEGACY';

export function legacyPostLeaseCutoff(now: Date): Date {
  const minutes = Math.max(1, Number(process.env.EXTENSION_PUBLISH_LEASE_MINUTES) || 10);
  return new Date(now.getTime() - minutes * 60_000);
}

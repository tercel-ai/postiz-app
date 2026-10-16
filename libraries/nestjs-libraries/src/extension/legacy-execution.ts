import { Prisma } from '@prisma/client';

// Nullable values are only a migration compatibility state. Unknown protocols fail closed.
export const legacyExecutionWhere = (): Prisma.PostWhereInput => ({
  OR: [{ executionProtocol: null }, { executionProtocol: 'LEGACY' }],
});
export const isLegacyExecution = (protocol: string | null | undefined) =>
  protocol == null || protocol === 'LEGACY';

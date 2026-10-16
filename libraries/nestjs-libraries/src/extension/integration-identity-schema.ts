import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

// Read the real schema only when creating/changing an actor identity. Environment
// flags cannot prove a contract migration was applied. No catalog result is cached.
export async function requiresLegacyIdentityKey(
  tx: Prisma.TransactionClient
): Promise<boolean> {
  let rows: Array<{ columns: string[] }>;
  try {
    rows = await tx.$queryRaw<Array<{ columns: string[] }>>`
      SELECT array_agg(a.attname::text ORDER BY k.ordinality) AS "columns"
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE n.nspname = current_schema() AND t.relname = 'Integration'
        AND i.indisunique AND i.indisvalid AND i.indisready
        AND i.indpred IS NULL AND i.indexprs IS NULL
        AND k.ordinality <= i.indnkeyatts
      GROUP BY i.indexrelid
    `;
  } catch {
    throw new ServiceUnavailableException('ACCOUNT_IDENTITY_SCHEMA_UNVERIFIED');
  }
  const hasKey = (columns: string[]) =>
    Array.isArray(rows) &&
    rows.some(
      (row) =>
        Array.isArray(row?.columns) &&
        row.columns.length === columns.length &&
        columns.every((column) => row.columns.includes(column))
    );
  if (
    !hasKey([
      'organizationId',
      'providerIdentifier',
      'identityNamespace',
      'internalId',
    ])
  )
    throw new ServiceUnavailableException('ACCOUNT_IDENTITY_SCHEMA_NOT_READY');
  return hasKey(['organizationId', 'internalId']);
}

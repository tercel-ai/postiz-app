import { Prisma } from '@prisma/client';
import { normalizeHandle } from './extension-session.utils';

interface ProfileClaim {
  organizationId: string;
  providerIdentifier: string;
  type: string;
  profile?: string | null;
  deletedAt?: Date | null;
}

/** Unchanged claims may refresh credentials while historical duplicates are cleaned up. */
export function isNewIntegrationProfileClaim(
  current: ProfileClaim | null | undefined,
  next: ProfileClaim
): boolean {
  const profile = normalizeHandle(next.profile ?? '');
  if (next.type !== 'social' || next.deletedAt || !profile) return false;
  return !current || !!current.deletedAt || current.type !== 'social' ||
    current.organizationId !== next.organizationId ||
    current.providerIdentifier !== next.providerIdentifier ||
    normalizeHandle(current.profile ?? '') !== profile;
}

/** Profile collisions never prove that two platform identities are the same account. */
export async function hasIntegrationProfileConflict(
  db: Pick<Prisma.TransactionClient, 'integration'>,
  org: string,
  provider: string,
  profile: string | null | undefined,
  excludeId?: string
): Promise<boolean> {
  const normalized = normalizeHandle(profile ?? '');
  if (!normalized) return false;
  const candidates = await db.integration.findMany({
    where: {
      organizationId: org,
      providerIdentifier: provider,
      type: 'social',
      deletedAt: null,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, profile: true },
  });
  return candidates.some(candidate =>
    candidate.id !== excludeId &&
    normalizeHandle(candidate.profile ?? '') === normalized
  );
}

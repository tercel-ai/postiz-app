import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';

/**
 * Resolve userId to organizationId(s) for admin list filtering.
 * Returns the resolved organizationId (string, string[], or undefined),
 * or null if userId was provided but the user has no organizations
 * (caller should return an empty result in this case).
 */
export async function resolveOrganizationId(
  organizationService: OrganizationService,
  organizationId?: string,
  userId?: string,
): Promise<{ organizationId?: string | string[]; empty: boolean }> {
  if (organizationId) {
    return { organizationId, empty: false };
  }
  if (userId) {
    const orgs = await organizationService.getOrgsByUserId(userId);
    if (orgs.length === 0) {
      return { empty: true };
    }
    return { organizationId: orgs.map((o) => o.id), empty: false };
  }
  return { organizationId: undefined, empty: false };
}

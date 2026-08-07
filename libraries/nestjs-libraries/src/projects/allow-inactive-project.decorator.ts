import { SetMetadata } from '@nestjs/common';

export const ALLOW_INACTIVE_PROJECT = 'allowInactiveProject';

/**
 * Opt a mutating route out of the activation check in ProjectAuthGuard.
 *
 * The guard blocks every non-GET request carrying a projectId whose aisee-core
 * product is deactivated. Mark a route with this decorator when it must keep
 * working while the project is switched off — e.g. a cleanup or export that a
 * user needs precisely because they turned the project off. Ownership
 * validation still applies; only the activation check is skipped.
 */
export const AllowInactiveProject = () =>
  SetMetadata(ALLOW_INACTIVE_PROJECT, true);

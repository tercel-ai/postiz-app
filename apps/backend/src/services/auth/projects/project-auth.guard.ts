import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { Organization } from '@prisma/client';
import { ProjectValidationService } from '@gitroom/nestjs-libraries/projects/project-validation.service';

/**
 * Global guard (registered in AppModule alongside PoliciesGuard/
 * SuperAdminGuard). No-ops when a request carries no projectId, so legacy,
 * non-project-scoped routes are unaffected during migration
 * (project-scoped-post-engage-design.md §8/§11). When a projectId IS present
 * — as a route param, query param, or body field — it is validated against
 * the authenticated request.org (never a client-supplied organization
 * mapping, per §4) before the handler runs; the validated id is then exposed
 * to handlers via @GetProjectFromRequest().
 */
@Injectable()
export class ProjectAuthGuard implements CanActivate {
  constructor(private readonly _projectValidation: ProjectValidationService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request: Request = context.switchToHttp().getRequest();

    const projectId =
      request.params?.projectId ||
      (request.query?.projectId as string | undefined) ||
      (request.body as { projectId?: string } | undefined)?.projectId;

    if (!projectId || typeof projectId !== 'string') {
      return true;
    }

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error — set by AuthMiddleware, which runs before all guards
    const org: Organization | undefined = request.org;
    if (!org) {
      return true; // no authenticated org yet — earlier auth handling applies
    }

    await this._projectValidation.assertProjectAccess(org.id, projectId);

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    request.projectId = projectId;
    return true;
  }
}

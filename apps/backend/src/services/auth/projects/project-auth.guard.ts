import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { Organization } from '@prisma/client';
import { ProjectValidationService } from '@gitroom/nestjs-libraries/projects/project-validation.service';
import { ALLOW_INACTIVE_PROJECT } from '@gitroom/nestjs-libraries/projects/allow-inactive-project.decorator';

/**
 * Global guard (registered in AppModule alongside PoliciesGuard/
 * SuperAdminGuard). No-ops when a request carries no projectId, so legacy,
 * non-project-scoped routes are unaffected during migration
 * (project-scoped-post-engage-design.md §8/§11). When a projectId IS present
 * — as a route param, query param, or body field — it is validated against
 * the authenticated request.org (never a client-supplied organization
 * mapping, per §4) before the handler runs; the validated id is then exposed
 * to handlers via @GetProjectFromRequest().
 *
 * Mutating requests (anything but GET) additionally require the project to be
 * active in aisee-core: deactivating a project must stop it producing new work
 * — posts, plans, engage replies, channel bindings — while leaving every read
 * path intact so the user can still inspect it and switch it back on. The
 * default is deny-on-mutation rather than an opt-in per route, so a new route
 * cannot silently miss the check; @AllowInactiveProject() opts one out.
 */
@Injectable()
export class ProjectAuthGuard implements CanActivate {
  constructor(
    private readonly _projectValidation: ProjectValidationService,
    private readonly _reflector: Reflector
  ) {}

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

    const allowInactive = this._reflector.get<boolean>(
      ALLOW_INACTIVE_PROJECT,
      context.getHandler()
    );

    if (request.method === 'GET' || allowInactive) {
      await this._projectValidation.assertProjectAccess(org.id, projectId);
    } else {
      await this._projectValidation.assertProjectActive(org.id, projectId);
    }

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    request.projectId = projectId;
    return true;
  }
}

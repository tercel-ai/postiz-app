import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * The projectId ProjectAuthGuard validated for this request, or undefined on
 * a request that carried no projectId (legacy, non-project-scoped route).
 */
export const GetProjectFromRequest = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.projectId;
  }
);

import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SUPER_ADMIN_KEY } from './super-admin.decorator';

@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(private _reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requireSuperAdmin = this._reflector.getAllAndOverride<boolean>(
      SUPER_ADMIN_KEY,
      [context.getHandler(), context.getClass()]
    );

    if (!requireSuperAdmin) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user?.isSuperAdmin) {
      throw new HttpException('Unauthorized: superadmin required', 403);
    }

    return true;
  }
}

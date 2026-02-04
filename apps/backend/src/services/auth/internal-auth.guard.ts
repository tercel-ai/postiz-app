import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { HttpForbiddenException } from '@gitroom/nestjs-libraries/services/exception.filter';

@Injectable()
export class InternalAuthGuard implements CanActivate {
  private readonly logger = new Logger(InternalAuthGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      this.logger.warn('Internal API: missing Bearer token');
      throw new HttpForbiddenException();
    }

    const token = authHeader.slice(7);

    try {
      const payload = AuthService.verifyJWT(token) as any;

      if (
        !payload.roles ||
        !Array.isArray(payload.roles) ||
        !payload.roles.includes('system-internal')
      ) {
        this.logger.warn('Internal API: token missing system-internal role');
        throw new HttpForbiddenException();
      }

      return true;
    } catch (err) {
      if (err instanceof HttpForbiddenException) {
        throw err;
      }
      this.logger.warn(`Internal API: JWT verification failed: ${err}`);
      throw new HttpForbiddenException();
    }
  }
}

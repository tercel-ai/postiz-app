import {
  CanActivate, ExecutionContext, ForbiddenException, HttpException, HttpStatus, Injectable,
} from '@nestjs/common';
import { InjectThrottlerStorage, ThrottlerStorage } from '@nestjs/throttler';
import type { Response } from 'express';

const WINDOW_MS = 15 * 60 * 1000;
const ORGANIZATION_LIMIT = 30;
// Leave room under X's 300/15min app quota even across local window boundaries.
const APPLICATION_LIMIT = 120;

@Injectable()
export class XUsernameLookupThrottleGuard implements CanActivate {
  constructor(@InjectThrottlerStorage() private readonly storage: ThrottlerStorage) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const organizationId = http.getRequest<{ org?: { id: string } }>().org?.id;
    if (!organizationId) throw new ForbiddenException();

    // Check the organization first so its blocked requests do not spend shared capacity.
    for (const [key, limit] of [
      [`x-username-lookup:org:${organizationId}`, ORGANIZATION_LIMIT],
      ['x-username-lookup:app', APPLICATION_LIMIT],
    ] as const) {
      const result = await this.storage.increment(key, WINDOW_MS, limit, WINDOW_MS, key);
      if (result.isBlocked) {
        http.getResponse<Response>().setHeader('Retry-After', result.timeToBlockExpire);
        throw new HttpException(
          { error: 'rate_limited', message: 'X username lookup rate limited' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    return true;
  }
}

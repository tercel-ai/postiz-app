import { createParamDecorator, ExecutionContext } from '@nestjs/common';

const TIMEZONE_RE = /^[A-Za-z_]+(\/[A-Za-z_]+)+$/;

export const GetTimezone = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest();
    const tz = request.headers['x-timezone'] as string | undefined;
    return tz && TIMEZONE_RE.test(tz) ? tz : undefined;
  }
);

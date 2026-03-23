import { createParamDecorator, ExecutionContext, Logger } from '@nestjs/common';

// Accepts standard IANA names (e.g. Asia/Shanghai, America/New_York)
// and Etc/* offsets (e.g. Etc/GMT+8, Etc/GMT-5).
const TIMEZONE_RE = /^[A-Za-z_]+\/[A-Za-z0-9_+\-]+(\/[A-Za-z0-9_+\-]+)*$/;

const logger = new Logger('GetTimezone');

export const GetTimezone = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest();
    const tz = request.headers['x-timezone'] as string | undefined;
    if (tz && !TIMEZONE_RE.test(tz)) {
      logger.warn(`Rejected invalid x-timezone header: "${tz}"`);
      return undefined;
    }
    return tz || undefined;
  }
);

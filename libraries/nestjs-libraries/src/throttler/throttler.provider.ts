import { ThrottlerGuard } from '@nestjs/throttler';
import { ExecutionContext, Injectable } from '@nestjs/common';

// Metadata key used by @nestjs/throttler's @Throttle() decorator. Not re-exported
// from the package's public index, so we reference the literal value defined in
// node_modules/@nestjs/throttler/dist/throttler.constants.d.ts.
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';

@Injectable()
export class ThrottlerBehindProxyGuard extends ThrottlerGuard {
  public override async canActivate(
    context: ExecutionContext
  ): Promise<boolean> {
    const { url } = context.switchToHttp().getRequest();
    // Always-throttled public-v1 paths (default org-level rate limiting).
    if (url.includes('/public/v1/posts') || url.includes('/public/v1/upload')) {
      return super.canActivate(context);
    }
    // Honor per-route @Throttle() metadata on every other route too —
    // without this, decorators like @Throttle({ default: { limit, ttl } })
    // are silent no-ops outside the public-v1 allowlist.
    const handler = context.getHandler();
    const classRef = context.getClass();
    const throttleLimit = this.reflector.getAllAndOverride<unknown>(
      THROTTLER_LIMIT,
      [handler, classRef]
    );
    if (throttleLimit !== undefined) {
      return super.canActivate(context);
    }
    return true;
  }

  protected override async getTracker(
    req: Record<string, any>
  ): Promise<string> {
    // Per-route throttles need a stable tracker that does NOT collapse all
    // engage requests into a single bucket. Prefer userId when present (matches
    // F-04's "20 generations/user/hour" wording); fall back to org-scoped key.
    const userId = req.user?.id;
    const orgId = req.org?.id ?? 'anon';
    const bucket = req.url?.indexOf?.('/posts') > -1 ? 'posts' : 'other';
    return userId
      ? `${orgId}_${userId}_${bucket}`
      : `${orgId}_${bucket}`;
  }
}
